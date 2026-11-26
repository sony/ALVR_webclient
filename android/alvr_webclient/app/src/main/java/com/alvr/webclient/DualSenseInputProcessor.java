package com.alvr.webclient;

import android.hardware.input.InputManager;
import android.os.Build;
import android.os.CombinedVibration;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.VibratorManager;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;

import java.util.Locale;

/**
 * Processes a Bluetooth HID-connected DualSense through the Android InputDevice API
 * and bridges its input to window.alvrOnDsInput() in client.js.
 *
 * Device detection: prefer VID/PID, with name matching as a fallback.
 * Touchpad: read SOURCE_TOUCHPAD MotionEvents.
 * Vibration: InputDevice.getVibratorManager() + CombinedVibration (API 31+).
 */
public class DualSenseInputProcessor implements InputManager.InputDeviceListener {

    private static final String TAG = "DualSenseInputProcessor";

    private final InputManager inputManager;
    private final Handler      mainHandler = new Handler(Looper.getMainLooper());

    private WebView webView;
    private int     dsDeviceId = -1;

    private volatile boolean paused = false;

    // ---- Button state --------------------------------------------------------
    private int btn0 = 0x08;  // DPAD neutral = 8
    private int btn1 = 0;
    private int btn2 = 0;

    // ---- Analog axes ---------------------------------------------------------
    private float axisLX    = 0f, axisLY    = 0f;
    private float axisRX    = 0f, axisRY    = 0f;
    private float axisTrigL = 0f, axisTrigR = 0f;
    private float axisHatX  = 0f, axisHatY  = 0f;

    // ---- Touchpad ------------------------------------------------------------
    // Coordinates: X=0..1919, Y=0..941 (matches client.js parseDsTouchPoints).
    // IDs are MotionEvent pointer IDs (stable per finger), not pointer indices.
    private boolean tpActive0 = false, tpActive1 = false;
    private int     tpX0 = 0, tpY0 = 0, tpX1 = 0, tpY1 = 0;
    private int     tpId0 = 0, tpId1 = 1;

    // ---- Gyroscope -----------------------------------------------------------
    private final DualSenseGyroRelay gyroRelay = new DualSenseGyroRelay(this::sendGyroDelta);

    public DualSenseInputProcessor(InputManager inputManager) {
        this.inputManager = inputManager;
    }

    public void setWebView(WebView webView) {
        this.webView = webView;
    }

    public void start() {
        inputManager.registerInputDeviceListener(this, mainHandler);
        for (int id : inputManager.getInputDeviceIds()) {
            InputDevice d = inputManager.getInputDevice(id);
            if (d == null) continue;
            if (DualSenseDevice.isDualSense(d) && DualSenseDevice.isGamepadSource(d)) {
                dsDeviceId = id;
                Log.i(TAG, "DualSense already connected: " + d.getName()
                        + " VID=" + String.format("0x%04X", d.getVendorId())
                        + " PID=" + String.format("0x%04X", d.getProductId())
                        + " id=" + id);
                notifyConnected();
                break;
            }
        }
        if (dsDeviceId < 0) {
            Log.i(TAG, "start(): DualSense not found in current device list, waiting for onInputDeviceAdded");
        }
    }

    public void stop() {
        inputManager.unregisterInputDeviceListener(this);
        gyroRelay.stop();
    }

    public void resumeStreaming() {
        paused = false;
        Log.i(TAG, "DualSense streaming resumed");
    }

    public void pauseStreaming() {
        paused = true;
        Log.i(TAG, "DualSense streaming paused");
    }

    public boolean isConnected() {
        return dsDeviceId >= 0;
    }

    /** Returns whether this is the device ID of a registered DualSense. */
    public boolean isKnownDevice(int deviceId) {
        return dsDeviceId >= 0 && deviceId == dsDeviceId;
    }

    /**
     * Returns whether the device ID matches a registered device or the VID/PID matches a DualSense.
     * This catches events from a DualSense companion "keyboard" sub-device
     * (with a different device ID), such as the SHARE button.
     */
    public boolean isDualSenseDevice(int deviceId) {
        if (isKnownDevice(deviceId)) return true;
        InputDevice d = inputManager.getInputDevice(deviceId);
        return d != null && DualSenseDevice.isDualSense(d);
    }

    // ---- InputManager.InputDeviceListener ------------------------------------

    @Override
    public void onInputDeviceAdded(int deviceId) {
        InputDevice d = inputManager.getInputDevice(deviceId);
        if (d == null) return;
        if (DualSenseDevice.isDualSense(d) && DualSenseDevice.isGamepadSource(d)) {
            dsDeviceId = deviceId;
            Log.i(TAG, "DualSense connected: " + d.getName()
                    + " VID=" + String.format("0x%04X", d.getVendorId())
                    + " PID=" + String.format("0x%04X", d.getProductId()));
            resetState();
            notifyConnected();
        }
    }

    @Override
    public void onInputDeviceRemoved(int deviceId) {
        if (deviceId == dsDeviceId) {
            Log.i(TAG, "DualSense disconnected: id=" + deviceId);
            dsDeviceId = -1;
            notifyDisconnected();
        }
    }

    @Override
    public void onInputDeviceChanged(int deviceId) {
        InputDevice d = inputManager.getInputDevice(deviceId);
        if (deviceId == dsDeviceId && d == null) {
            // Treat unavailable device information as a disconnection.
            dsDeviceId = -1;
            notifyDisconnected();
        } else if (deviceId == dsDeviceId && !gyroRelay.isRunning()) {
            // The motion sensor may be associated with the device after it was added.
            gyroRelay.start(d);
        } else if (dsDeviceId < 0
                && d != null
                && DualSenseDevice.isGamepadSource(d)) {
            // Register a newly detected device with a gamepad source on change notification.
            Log.i(TAG, "onInputDeviceChanged: registering id=" + deviceId
                    + " name=\"" + d.getName() + "\""
                    + " VID=" + String.format("0x%04X", d.getVendorId())
                    + " PID=" + String.format("0x%04X", d.getProductId()));
            dsDeviceId = deviceId;
            notifyConnected();
        }
    }

    // ---- Input processing (called by MainActivity) ---------------------------

    /** @return true if the event was consumed */
    public boolean processKeyEvent(KeyEvent event) {
        int eventDeviceId = event.getDeviceId();

        // Late detection: register the device if a gamepad event arrives before dsDeviceId is set.
        // Accept any device with a gamepad source, without relying on VID/PID matching.
        if (dsDeviceId < 0) {
            InputDevice d = inputManager.getInputDevice(eventDeviceId);
            if (d != null && DualSenseDevice.isGamepadSource(d)) {
                Log.w(TAG, "Lazy detect (KeyEvent): id=" + eventDeviceId
                        + " name=\"" + d.getName() + "\""
                        + " VID=" + String.format("0x%04X", d.getVendorId())
                        + " PID=" + String.format("0x%04X", d.getProductId())
                        + " sources=" + String.format("0x%08X", d.getSources())
                        + " isDS=" + DualSenseDevice.isDualSense(d));
                dsDeviceId = eventDeviceId;
                resetState();
                notifyConnected();
            }
        }

        if (dsDeviceId < 0 || eventDeviceId != dsDeviceId) {
            // Companion keyboard sub-device support: accept a different device ID if the VID/PID identifies a DualSense.
            // SHARE (KEYCODE_BUTTON_SELECT) may arrive from a sub-device with only SOURCE_KEYBOARD.
            InputDevice d = inputManager.getInputDevice(eventDeviceId);
            if (d == null || !DualSenseDevice.isDualSense(d)) return false;
            Log.d(TAG, "processKeyEvent: companion DualSense device id=" + eventDeviceId
                    + " (registered=" + dsDeviceId + ")");
        }
        Log.d(TAG, "processKeyEvent: keyCode=" + event.getKeyCode()
                + " (" + KeyEvent.keyCodeToString(event.getKeyCode()) + ")"
                + " action=" + (event.getAction() == KeyEvent.ACTION_DOWN ? "DOWN" : "UP")
                + " source=0x" + Integer.toHexString(event.getSource()));
        int[] byteMask = DualSenseDevice.keyCodeToBitMask(event.getKeyCode());
        if (byteMask == null) {
            Log.w(TAG, "  → keyCode not mapped, ignoring");
            return false;
        }
        boolean pressed = (event.getAction() == KeyEvent.ACTION_DOWN);
        switch (byteMask[0]) {
            case 0: btn0 = pressed ? (btn0 | byteMask[1]) : (btn0 & ~byteMask[1]); break;
            case 1: btn1 = pressed ? (btn1 | byteMask[1]) : (btn1 & ~byteMask[1]); break;
            case 2: btn2 = pressed ? (btn2 | byteMask[1]) : (btn2 & ~byteMask[1]); break;
        }
        sendState();
        return true;
    }

    /** @return true if the event was consumed */
    public boolean processMotionEvent(MotionEvent event) {
        int eventDeviceId = event.getDeviceId();

        // Late detection: register the device if a joystick event arrives before dsDeviceId is set.
        if (dsDeviceId < 0) {
            InputDevice d = inputManager.getInputDevice(eventDeviceId);
            if (d != null && DualSenseDevice.isGamepadSource(d)) {
                Log.w(TAG, "Lazy detect (MotionEvent): id=" + eventDeviceId
                        + " name=\"" + d.getName() + "\""
                        + " VID=" + String.format("0x%04X", d.getVendorId())
                        + " PID=" + String.format("0x%04X", d.getProductId())
                        + " sources=" + String.format("0x%08X", d.getSources())
                        + " isDS=" + DualSenseDevice.isDualSense(d));
                dsDeviceId = eventDeviceId;
                resetState();
                notifyConnected();
            }
        }

        if (dsDeviceId < 0 || eventDeviceId != dsDeviceId) return false;

        // Joystick axes (sticks / triggers / DPAD HAT).
        if (event.isFromSource(InputDevice.SOURCE_CLASS_JOYSTICK)
                && event.getAction() == MotionEvent.ACTION_MOVE) {

            axisLX = event.getAxisValue(MotionEvent.AXIS_X);
            axisLY = event.getAxisValue(MotionEvent.AXIS_Y);
            axisRX = event.getAxisValue(MotionEvent.AXIS_Z);
            axisRY = event.getAxisValue(MotionEvent.AXIS_RZ);

            float lt = event.getAxisValue(MotionEvent.AXIS_LTRIGGER);
            axisTrigL = (lt > 0f) ? lt : event.getAxisValue(MotionEvent.AXIS_BRAKE);
            float rt = event.getAxisValue(MotionEvent.AXIS_RTRIGGER);
            axisTrigR = (rt > 0f) ? rt : event.getAxisValue(MotionEvent.AXIS_GAS);

            float newHatX = event.getAxisValue(MotionEvent.AXIS_HAT_X);
            float newHatY = event.getAxisValue(MotionEvent.AXIS_HAT_Y);
            if (newHatX != axisHatX || newHatY != axisHatY) {
                axisHatX = newHatX;
                axisHatY = newHatY;
                int hatNibble = DualSenseDevice.hatToNibble(axisHatX, axisHatY);
                btn0 = (btn0 & ~DualSenseDevice.BTN0_DPAD_MASK) | hatNibble;
            }
            sendState();
        }

        // Physical touchpad click (ACTION_BUTTON_PRESS / ACTION_BUTTON_RELEASE).
        // Accept both SOURCE_TOUCHPAD and SOURCE_MOUSE because this varies by device and OS.
        // Do not use getActionButton(); treat all touchpad button events as clicks.
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_BUTTON_PRESS
                || action == MotionEvent.ACTION_BUTTON_RELEASE) {
            if (event.isFromSource(InputDevice.SOURCE_TOUCHPAD)
                    || event.isFromSource(InputDevice.SOURCE_MOUSE)) {
                if (action == MotionEvent.ACTION_BUTTON_PRESS) {
                    btn2 |=  DualSenseDevice.BTN2_TOUCHPAD;
                } else {
                    btn2 &= ~DualSenseDevice.BTN2_TOUCHPAD;
                }
                sendState();
                return true;
            }
        }

        // Touchpad contact
        if (event.isFromSource(InputDevice.SOURCE_TOUCHPAD)) {
            processTouchEvent(event);
        }

        return true;
    }

    /**
     * Processes touchpad MotionEvents.
     * Coordinates: X=0..1919, Y=0..941 (the same coordinate system as client.js parseDsTouchPoints).
     * Each slot carries the pointer ID so client.js can track fingers across pointer-index shifts
     * (e.g. when the first finger lifts, the remaining finger moves to index 0).
     * Physical touchpad clicks (presses) are handled by processMotionEvent.
     */
    private void processTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_MOVE:
            case MotionEvent.ACTION_POINTER_DOWN:
            case MotionEvent.ACTION_POINTER_UP: {
                // The lifting pointer is still included in ACTION_POINTER_UP; skip it.
                int skip = (action == MotionEvent.ACTION_POINTER_UP) ? event.getActionIndex() : -1;
                tpActive0 = tpActive1 = false;
                int slot = 0;
                for (int i = 0; i < event.getPointerCount() && slot < 2; i++) {
                    if (i == skip) continue;
                    int id = event.getPointerId(i);
                    int x  = (int) event.getX(i);
                    int y  = (int) event.getY(i);
                    if (slot == 0) { tpActive0 = true; tpId0 = id; tpX0 = x; tpY0 = y; }
                    else           { tpActive1 = true; tpId1 = id; tpX1 = x; tpY1 = y; }
                    slot++;
                }
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                tpActive0 = false;
                tpActive1 = false;
                break;
            default:
                break;
        }
        sendState();
    }

    /**
     * Processes haptics events from the ALVR server.
     * Called from the IS_NATIVE_APP branch of client.js triggerHaptics().
     *
     * @param durationMs vibration duration (ms)
     * @param amplitude  vibration intensity (0.0–1.0)
     */
    public void triggerHaptics(int durationMs, float amplitude) {
        if (dsDeviceId < 0) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;  // Not supported below API 31.

        InputDevice device = inputManager.getInputDevice(dsDeviceId);
        if (device == null) return;

        // InputDevice.getVibratorManager() does not require the VIBRATE permission
        // because it uses the device's own vibrator.
        VibratorManager vm = device.getVibratorManager();
        int strongAmp = Math.min(255, Math.max(1, Math.round(amplitude * 255)));

        // CombinedVibration.createParallel() applies the same effect to all vibrators
        // (the only factory method available in the public SDK).
        VibrationEffect effect = VibrationEffect.createOneShot(durationMs, strongAmp);
        vm.vibrate(CombinedVibration.createParallel(effect));
    }

    // ---- Internal helpers ----------------------------------------------------

    /** Sends the current state of all inputs to JS alvrOnDsInput(). */
    private void sendState() {
        if (paused) return;

        int stickLX = DualSenseDevice.axisToStick(axisLX);
        int stickLY = DualSenseDevice.axisToStick(axisLY);
        int stickRX = DualSenseDevice.axisToStick(axisRX);
        int stickRY = DualSenseDevice.axisToStick(axisRY);
        int trigL   = DualSenseDevice.axisToTrigger(axisTrigL);
        int trigR   = DualSenseDevice.axisToTrigger(axisTrigR);

        final String js = String.format(
                "window.alvrOnDsInput && window.alvrOnDsInput("
                + "%d,%d,%d,%d,%d,%d,%d,%d,%d,"
                + "%s,%d,%d,%s,%d,%d,%d,%d)",
                stickLX, stickLY, stickRX, stickRY,
                trigL, trigR, btn0, btn1, btn2,
                tpActive0 ? "true" : "false", tpX0, tpY0,
                tpActive1 ? "true" : "false", tpX1, tpY1,
                tpId0, tpId1);

        mainHandler.post(() -> {
            WebView wv = webView;
            if (wv != null) wv.evaluateJavascript(js, null);
        });
    }

    /** Called on the gyro sensor thread with an accumulated body-frame delta rotation. */
    private void sendGyroDelta(double w, double x, double y, double z) {
        if (paused) return;
        final String js = String.format(Locale.ROOT,
                "window.alvrOnDsGyroDelta && window.alvrOnDsGyroDelta(%.9f,%.9f,%.9f,%.9f)",
                w, x, y, z);
        mainHandler.post(() -> {
            WebView wv = webView;
            if (wv != null) wv.evaluateJavascript(js, null);
        });
    }

    /** Call after the JS page loads. Resend alvrOnDsConnected if already connected. */
    public void notifyPageReady() {
        if (dsDeviceId >= 0) {
            Log.i(TAG, "notifyPageReady(): DualSense already connected, re-notifying JS");
            notifyConnected();
        }
    }

    private void notifyConnected() {
        mainHandler.post(() -> {
            if (dsDeviceId >= 0) {
                // Restart so the relay always follows the currently registered device.
                gyroRelay.stop();
                gyroRelay.start(inputManager.getInputDevice(dsDeviceId));
            }
            WebView wv = webView;
            if (wv == null) return;
            wv.evaluateJavascript(
                    "window.alvrOnDsConnected && window.alvrOnDsConnected('bluetooth')", null);
            // Request pointer capture for the DualSense touchpad.
            // On capture, the OS hides the cursor and routes SOURCE_TOUCHPAD events
            // (absolute coordinates and multitouch) through OnCapturedPointerListener.
            if (Build.VERSION.SDK_INT >= 37) {
                wv.requestPointerCapture(View.POINTER_CAPTURE_MODE_ABSOLUTE);
            } else {
                wv.requestPointerCapture();
            }
        });
    }

    private void notifyDisconnected() {
        mainHandler.post(() -> {
            gyroRelay.stop();
            WebView wv = webView;
            if (wv == null) return;
            wv.evaluateJavascript(
                    "window.alvrOnDsDisconnected && window.alvrOnDsDisconnected()", null);
            wv.releasePointerCapture();
        });
    }

    private void resetState() {
        btn0 = 0x08;  // DPAD neutral
        btn1 = 0;
        btn2 = 0;
        axisLX = axisLY = axisRX = axisRY = 0f;
        axisTrigL = axisTrigR = 0f;
        axisHatX = axisHatY = 0f;
        tpActive0 = tpActive1 = false;
        tpX0 = tpY0 = tpX1 = tpY1 = 0;
        tpId0 = 0;
        tpId1 = 1;
    }
}
