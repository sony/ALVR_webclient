package com.alvr.webclient;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.hardware.input.InputManager;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * Main Activity for the ALVR Web Client.
 *
 * Responsibilities:
 *   1. Load index.html in the primary WebView to show the UI
 *   2. Detect secondary displays (XR devices) via DisplayManager
 *   3. Show XrDisplayPresentation when a secondary display is found
 *   4. Handle USB attach/detach events and start ImuRelayManager
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "MainActivity";
    private static final String ACTION_USB_PERMISSION =
            "com.alvr.webclient.USB_PERMISSION";
    private static final int REQUEST_CAMERA_PERMISSION = 1001;

    private WebView                primaryWebView;
    private AlvrAudioBridge        audioBridge;
    private DisplayMessageBroker   broker;
    private ImuRelayManager        imuRelayManager;
    private DualSenseInputProcessor dsInputProcessor;
    private DisplayManager         displayManager;
    private XrDisplayPresentation  xrPresentation;

    /**
     * Tracks the USB device for which a permission dialog is currently showing.
     * Prevents duplicate dialogs when both handleLaunchIntent() and
     * scanConnectedUsbDevices() detect the same already-connected device.
     */
    private UsbDevice pendingPermissionDevice = null;

    // -----------------------------------------------------------------------
    // DisplayManager.DisplayListener
    // -----------------------------------------------------------------------

    private final DisplayManager.DisplayListener displayListener =
            new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) {
            Display display = displayManager.getDisplay(displayId);
            if (display != null && isPresentationDisplay(display)) {
                Log.i(TAG, "Secondary display added: " + displayId);
                runOnUiThread(() -> showXrPresentation(display));
            }
        }

        @Override
        public void onDisplayRemoved(int displayId) {
            Log.i(TAG, "Display removed: " + displayId);
            runOnUiThread(() -> {
                if (xrPresentation != null && xrPresentation.isShowing()) {
                    xrPresentation.dismiss();
                    xrPresentation = null;
                }
            });
        }

        @Override
        public void onDisplayChanged(int displayId) {}
    };

    // -----------------------------------------------------------------------
    // USB permission receiver
    // -----------------------------------------------------------------------

    private final BroadcastReceiver usbPermissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
            pendingPermissionDevice = null;  // dialog dismissed (granted or denied)
            UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            boolean granted  = intent.getBooleanExtra(
                    UsbManager.EXTRA_PERMISSION_GRANTED, false);
            if (granted && device != null) {
                Log.i(TAG, "USB permission granted for: " + device.getDeviceName());
                startImuRelay(device);
            } else {
                Log.w(TAG, "USB permission denied for IMU device");
            }
        }
    };

    // USB attach/detach receiver
    private final BroadcastReceiver usbStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                handleUsbAttach(device);
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                Log.i(TAG, "USB device detached");
                imuRelayManager.stopRelay();
            }
        }
    };

    // -----------------------------------------------------------------------
    // Activity lifecycle
    // -----------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Enable remote debugging of WebViews via Chrome DevTools (chrome://inspect).
        WebView.setWebContentsDebuggingEnabled(true);

        broker           = new DisplayMessageBroker();
        imuRelayManager  = new ImuRelayManager(this);
        dsInputProcessor = new DualSenseInputProcessor(
                (InputManager) getSystemService(Context.INPUT_SERVICE));
        displayManager   = (DisplayManager) getSystemService(DISPLAY_SERVICE);

        setupPrimaryWebView();

        displayManager.registerDisplayListener(displayListener,
                android.os.Handler.createAsync(getMainLooper()));

        // Check for secondary displays already connected at startup
        for (Display d : displayManager.getDisplays(
                DisplayManager.DISPLAY_CATEGORY_PRESENTATION)) {
            if (isPresentationDisplay(d)) {
                showXrPresentation(d);
                break;
            }
        }

        // Register USB broadcast receivers
        IntentFilter permFilter = new IntentFilter(ACTION_USB_PERMISSION);
        registerReceiver(usbPermissionReceiver, permFilter, RECEIVER_NOT_EXPORTED);

        IntentFilter stateFilter = new IntentFilter();
        stateFilter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        stateFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        registerReceiver(usbStateReceiver, stateFilter, RECEIVER_NOT_EXPORTED);

        // Handle a USB device in the launch intent (app auto-started by device attachment)
        handleLaunchIntent(getIntent());

        // ACTION_USB_DEVICE_ATTACHED is not sticky in modern Android: if the XR device was
        // already connected when the user manually started the app, neither the launch intent
        // nor the dynamic usbStateReceiver will deliver the attach event.  Scan the current
        // USB device list to cover that case.
        //
        // CAMERA permission must be granted first: Android 12+ silently blocks the USB
        // permission dialog for UVC devices (XREAL Air 2 Ultra has a camera interface) when
        // the calling app lacks CAMERA permission (UsbUserPermissionManager log:
        // "Camera permission required for USB video class devices").
        requestCameraPermissionThenScanUsb();
    }

    /**
     * Requests CAMERA and RECORD_AUDIO permissions if not already granted, then scans
     * connected USB devices.
     *
     * CAMERA is required on Android 12+ so that UsbUserPermissionManager shows the USB
     * permission dialog for UVC devices (XREAL Air 2 Ultra).
     * RECORD_AUDIO is required for the ALVR web client's microphone input feature.
     */
    private void requestCameraPermissionThenScanUsb() {
        List<String> missing = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 37) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_LOCAL_NETWORK)
                    != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.ACCESS_LOCAL_NETWORK);
            }
        }
        if (missing.isEmpty()) {
            scanConnectedUsbDevices();
        } else {
            Log.i(TAG, "Requesting permissions: " + missing);
            ActivityCompat.requestPermissions(
                    this,
                    missing.toArray(new String[0]),
                    REQUEST_CAMERA_PERMISSION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode,
                                           String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            for (int i = 0; i < permissions.length; i++) {
                if (Manifest.permission.CAMERA.equals(permissions[i])) {
                    if (grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                        Log.i(TAG, "Camera permission granted; scanning for connected USB XR devices");
                        scanConnectedUsbDevices();
                    } else {
                        Log.w(TAG, "Camera permission denied; USB permission dialog may be blocked "
                                + "for UVC devices (XREAL Air 2 Ultra)");
                    }
                } else if (Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                    if (grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                        Log.i(TAG, "RECORD_AUDIO permission granted");
                    } else {
                        Log.w(TAG, "RECORD_AUDIO permission denied – microphone input will not work");
                    }
                }
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleLaunchIntent(intent);
    }

    @Override
    protected void onDestroy() {
        displayManager.unregisterDisplayListener(displayListener);
        unregisterReceiver(usbPermissionReceiver);
        unregisterReceiver(usbStateReceiver);
        imuRelayManager.stopRelay();
        dsInputProcessor.stop();
        if (audioBridge != null) {
            audioBridge.stop();
        }
        if (xrPresentation != null && xrPresentation.isShowing()) {
            xrPresentation.dismiss();
        }
        super.onDestroy();
    }

    // -----------------------------------------------------------------------
    // WebView setup
    // -----------------------------------------------------------------------

    private void setupPrimaryWebView() {
        primaryWebView = new WebView(this);
        configureWebView(primaryWebView);

        audioBridge = new AlvrAudioBridge();
        AlvrClientBridge clientBridge =
                new AlvrClientBridge(broker, imuRelayManager, dsInputProcessor,
                        primaryWebView, audioBridge);
        primaryWebView.addJavascriptInterface(clientBridge, "AlvrNativeBridge");

        broker.setClientWebView(primaryWebView);
        imuRelayManager.setWebView(primaryWebView);
        dsInputProcessor.setWebView(primaryWebView);
        dsInputProcessor.start();

        // DualSense touchpad: receive SOURCE_TOUCHPAD events while pointer capture is active.
        // requestPointerCapture() is called from notifyConnected().
        primaryWebView.setOnCapturedPointerListener((view, event) ->
                dsInputProcessor.processMotionEvent(event));

        // Extend the WebViewClient configured by configureWebView() and add onPageFinished.
        // Even if the DualSense is already connected during start(), evaluateJavascript()
        // is unavailable before loadUrl(), so resend alvrOnDsConnected after the page loads.
        primaryWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           SslError error) {
                Log.w(TAG, "SSL error (self-signed cert expected): " + error);
                handler.proceed();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                dsInputProcessor.notifyPageReady();
            }
        });

        setContentView(primaryWebView);

        primaryWebView.loadUrl("file:///android_asset/web_client/index.html");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Reacquire pointer capture when window focus returns.
        // Capture is released when returning from a dialog or another activity.
        if (hasFocus && primaryWebView != null && dsInputProcessor.isConnected()) {
            if (Build.VERSION.SDK_INT >= 37) {
                primaryWebView.requestPointerCapture(View.POINTER_CAPTURE_MODE_ABSOLUTE);
            } else {
                primaryWebView.requestPointerCapture();
            }
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Route by VID/PID as well as isKnownDevice.
        // SHARE (KEYCODE_BUTTON_SELECT) may arrive from a DualSense companion keyboard
        // sub-device with a different device ID and only SOURCE_KEYBOARD.
        boolean isGamepad     = (event.getSource() & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD;
        boolean fromDualSense = dsInputProcessor.isDualSenseDevice(event.getDeviceId());
        if (isGamepad || fromDualSense) {
            if (dsInputProcessor.processKeyEvent(event)) return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        // Pass both SOURCE_JOYSTICK (sticks/triggers/DPAD) and SOURCE_TOUCHPAD,
        boolean isJoystick = (event.getSource() & InputDevice.SOURCE_JOYSTICK)
                                  == InputDevice.SOURCE_JOYSTICK
                           && event.getAction() == MotionEvent.ACTION_MOVE;
        boolean isTouchpad = (event.getSource() & InputDevice.SOURCE_TOUCHPAD)
                                  == InputDevice.SOURCE_TOUCHPAD;
        // Also handle physical touchpad clicks that arrive as SOURCE_MOUSE.
        boolean isMouseButton = (event.getSource() & InputDevice.SOURCE_MOUSE)
                                     == InputDevice.SOURCE_MOUSE
                             && (event.getAction() == MotionEvent.ACTION_BUTTON_PRESS
                              || event.getAction() == MotionEvent.ACTION_BUTTON_RELEASE);
        if (isJoystick || isTouchpad || isMouseButton) {
            if (dsInputProcessor.processMotionEvent(event)) return true;
        }
        return super.dispatchGenericMotionEvent(event);
    }

    /**
     * Captures multitouch events from the DualSense touchpad.
     * BT HID SOURCE_TOUCHPAD events may arrive through dispatchTouchEvent.
     * Added because dispatchGenericMotionEvent alone cannot handle two-finger input.
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        boolean isTouchpad    = (event.getSource() & InputDevice.SOURCE_TOUCHPAD)
                                     == InputDevice.SOURCE_TOUCHPAD;
        boolean fromDualSense = dsInputProcessor.isKnownDevice(event.getDeviceId());
        if ((isTouchpad || fromDualSense) && dsInputProcessor.isConnected()) {
            if (dsInputProcessor.processMotionEvent(event)) return true;
        }
        return super.dispatchTouchEvent(event);
    }

    /**
     * Applies common settings to a WebView instance.
     */
    static void configureWebView(WebView webView) {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        // Hardware acceleration (enabled at Activity/Application level in the manifest)
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);
        // Override onPermissionRequest so that getUserMedia({audio}) works inside the WebView.
        // Android WebView's default WebChromeClient denies all permission requests silently.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only grant RESOURCE_AUDIO_CAPTURE, and only when the OS-level
                // RECORD_AUDIO permission has already been granted to this app.
                boolean audioGranted = ContextCompat.checkSelfPermission(
                        webView.getContext(), Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED;
                List<String> toGrant = new ArrayList<>();
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && audioGranted) {
                        toGrant.add(resource);
                    }
                }
                if (!toGrant.isEmpty()) {
                    request.grant(toGrant.toArray(new String[0]));
                    Log.i("AlvrWebView", "WebView permission granted: " + toGrant);
                } else {
                    request.deny();
                    Log.w("AlvrWebView", "WebView permission denied (audioOsGranted=" + audioGranted + ")");
                }
            }
        });
        // Allow the ALVR server's self-signed certificate.
        // This app only connects to the local ALVR server, so accepting self-signed certs is safe.
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           SslError error) {
                Log.w("AlvrWebView", "SSL error (self-signed cert expected): " + error);
                handler.proceed();
            }
        });
    }

    // -----------------------------------------------------------------------
    // Display management
    // -----------------------------------------------------------------------

    private void showXrPresentation(Display display) {
        if (xrPresentation != null && xrPresentation.isShowing()) {
            xrPresentation.dismiss();
        }
        xrPresentation = new XrDisplayPresentation(this, display, broker);
        xrPresentation.show();
        Log.i(TAG, "XrDisplayPresentation shown on display " + display.getDisplayId());
    }

    /**
     * Returns true if the given display is a secondary (presentation) display.
     * Displays with {@link Display#FLAG_PRESENTATION} set are used as XR glass outputs.
     */
    private static boolean isPresentationDisplay(Display display) {
        return (display.getFlags() & Display.FLAG_PRESENTATION) != 0;
    }

    // -----------------------------------------------------------------------
    // USB handling
    // -----------------------------------------------------------------------

    private void handleLaunchIntent(Intent intent) {
        if (intent == null) return;
        if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            handleUsbAttach(device);
        }
    }

    /**
     * Checks USB devices that are already connected at app startup.
     * ACTION_USB_DEVICE_ATTACHED is not a sticky broadcast in modern Android, so when the
     * user starts the app manually while an XR device is already plugged in, neither
     * handleLaunchIntent() nor the dynamic usbStateReceiver will deliver the event.
     */
    private void scanConnectedUsbDevices() {
        UsbManager usbManager = (UsbManager) getSystemService(USB_SERVICE);
        if (usbManager == null) return;
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            XrGlassesDevice type = XrGlassesDevice.fromUsbIds(
                    device.getVendorId(), device.getProductId());
            if (type != null) {
                Log.i(TAG, "Found already-connected XR device at startup: " + type.name()
                        + " VID=" + String.format("0x%04X", device.getVendorId())
                        + " PID=" + String.format("0x%04X", device.getProductId()));
                handleUsbAttach(device);
                break; // Only one XR device expected at a time
            }
        }
    }

    private void handleUsbAttach(UsbDevice device) {
        if (device == null) return;

        XrGlassesDevice type = XrGlassesDevice.fromUsbIds(
                device.getVendorId(), device.getProductId());
        if (type == null) {
            Log.d(TAG, "Ignoring unsupported USB device VID="
                    + String.format("0x%04X", device.getVendorId()));
            return;
        }

        Log.i(TAG, "Supported XR device attached: " + type.name());

        UsbManager usbManager = (UsbManager) getSystemService(USB_SERVICE);
        if (usbManager.hasPermission(device)) {
            startImuRelay(device);
        } else {
            // Guard against duplicate permission dialogs.
            // Both handleLaunchIntent() and scanConnectedUsbDevices() can detect the
            // same device within a short window (e.g. fresh install while device is
            // already connected). Showing two dialogs confuses the user and the second
            // dialog may prevent the first grant from being delivered.
            if (pendingPermissionDevice != null
                    && pendingPermissionDevice.getDeviceName().equals(device.getDeviceName())) {
                Log.d(TAG, "Permission already requested for " + device.getDeviceName() + ", skipping");
                return;
            }
            pendingPermissionDevice = device;
            PendingIntent pi = PendingIntent.getBroadcast(
                    this, 0,
                    new Intent(ACTION_USB_PERMISSION),
                    PendingIntent.FLAG_IMMUTABLE);
            usbManager.requestPermission(device, pi);
            Log.d(TAG, "Requested USB permission for " + device.getDeviceName());
        }
    }

    private void startImuRelay(UsbDevice device) {
        // Prevent duplicate starts for the same device.
        // If handleLaunchIntent() and scanConnectedUsbDevices() detect the same
        // already-connected device at nearly the same time, the second
        // startImuRelay() call can trigger a stopRelay() → startRelay() race, in which
        // the old thread's finally block disables the new thread's USB connection.
        // Skip the start if this device is already being relayed.
        if (imuRelayManager.isRunning()
                && device.getDeviceName().equals(imuRelayManager.getDeviceName())) {
            Log.d(TAG, "IMU relay already active for " + device.getDeviceName()
                    + "; ignoring duplicate attach event");
            return;
        }
        if (imuRelayManager.isRunning()) {
            imuRelayManager.stopRelay();
        }
        imuRelayManager.startRelay(device);
        Log.i(TAG, "IMU relay started");
    }
}
