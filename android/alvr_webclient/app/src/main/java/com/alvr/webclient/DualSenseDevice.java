package com.alvr.webclient;

import android.view.InputDevice;
import android.view.KeyEvent;

/**
 * Bluetooth HID identifiers for DualSense / DualSense Edge and
 * constant mappings for the Android InputDevice API.
 */
public final class DualSenseDevice {

    private DualSenseDevice() {}

    // ---- VID / PID ----------------------------------------------------------
    public static final int VENDOR_ID           = 0x054C;  // Sony
    public static final int PRODUCT_ID_STANDARD = 0x0CE6;  // DualSense
    public static final int PRODUCT_ID_EDGE     = 0x0DF2;  // DualSense Edge

    /**
     * Detect a DualSense by VID/PID first.
     * If the VID/PID does not match, fall back to the device name.
     * The name may vary by Android version.
     */
    public static boolean isDualSense(InputDevice device) {
        if (device == null) return false;
        int vid = device.getVendorId();
        int pid = device.getProductId();
        if (vid == VENDOR_ID
                && (pid == PRODUCT_ID_STANDARD || pid == PRODUCT_ID_EDGE)) {
            return true;
        }
        String name = device.getName();
        return name != null
                && (name.equals("Wireless Controller")
                 || name.equals("DualSense Wireless Controller"));
    }

    public static boolean isGamepadSource(InputDevice device) {
        if (device == null) return false;
        int src = device.getSources();
        return (src & InputDevice.SOURCE_GAMEPAD)  == InputDevice.SOURCE_GAMEPAD
            || (src & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
    }

    // ---- btn0 bit masks ------------------------------------------------------
    public static final int BTN0_DPAD_MASK = 0x0F;  // bits 3:0 = HAT direction (0-8)
    public static final int BTN0_SQUARE    = 0x10;  // KEYCODE_BUTTON_X
    public static final int BTN0_CROSS     = 0x20;  // KEYCODE_BUTTON_A
    public static final int BTN0_CIRCLE    = 0x40;  // KEYCODE_BUTTON_B
    public static final int BTN0_TRIANGLE  = 0x80;  // KEYCODE_BUTTON_Y

    // ---- btn1 bit masks ------------------------------------------------------
    public static final int BTN1_L1      = 0x01;  // KEYCODE_BUTTON_L1
    public static final int BTN1_R1      = 0x02;  // KEYCODE_BUTTON_R1
    public static final int BTN1_SHARE   = 0x10;  // KEYCODE_BUTTON_SELECT
    public static final int BTN1_OPTIONS = 0x20;  // KEYCODE_BUTTON_START
    public static final int BTN1_L3      = 0x40;  // KEYCODE_BUTTON_THUMBL
    public static final int BTN1_R3      = 0x80;  // KEYCODE_BUTTON_THUMBR

    // ---- btn2 bit masks ------------------------------------------------------
    public static final int BTN2_PS       = 0x01;  // KEYCODE_BUTTON_MODE
    public static final int BTN2_TOUCHPAD = 0x02;  // Physical touchpad click (ACTION_BUTTON_PRESS)

    // ---- DPAD HAT conversion ------------------------------------------------
    public static int hatToNibble(float hatX, float hatY) {
        int xi = Math.round(hatX);
        int yi = Math.round(hatY);
        if (xi ==  0 && yi == -1) return 0;
        if (xi == +1 && yi == -1) return 1;
        if (xi == +1 && yi ==  0) return 2;
        if (xi == +1 && yi == +1) return 3;
        if (xi ==  0 && yi == +1) return 4;
        if (xi == -1 && yi == +1) return 5;
        if (xi == -1 && yi ==  0) return 6;
        if (xi == -1 && yi == -1) return 7;
        return 8;
    }

    // ---- Axis scale conversion ----------------------------------------------
    /** Map the stick axis from [-1.0, +1.0] to [0, 255]. */
    public static int axisToStick(float axis) {
        return Math.min(255, Math.max(0, Math.round((axis + 1.0f) * 127.5f)));
    }

    /** Map the trigger axis from [0.0, 1.0] to [0, 255]. */
    public static int axisToTrigger(float axis) {
        return Math.min(255, Math.max(0, Math.round(axis * 255.0f)));
    }

    // ---- KeyCode to btn byte + bit mask conversion --------------------------
    /** @return {byteIndex(0/1/2), mask}, or null for an unknown key. */
    public static int[] keyCodeToBitMask(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_BUTTON_A:      return new int[]{ 0, BTN0_CROSS    };
            case KeyEvent.KEYCODE_BUTTON_B:      return new int[]{ 0, BTN0_CIRCLE   };
            case KeyEvent.KEYCODE_BUTTON_X:      return new int[]{ 0, BTN0_SQUARE   };
            case KeyEvent.KEYCODE_BUTTON_Y:      return new int[]{ 0, BTN0_TRIANGLE };
            case KeyEvent.KEYCODE_BUTTON_L1:     return new int[]{ 1, BTN1_L1       };
            case KeyEvent.KEYCODE_BUTTON_R1:     return new int[]{ 1, BTN1_R1       };
            case KeyEvent.KEYCODE_BUTTON_SELECT: return new int[]{ 1, BTN1_SHARE    };
            case KeyEvent.KEYCODE_BUTTON_START:  return new int[]{ 1, BTN1_OPTIONS  };
            case KeyEvent.KEYCODE_BUTTON_THUMBL: return new int[]{ 1, BTN1_L3       };
            case KeyEvent.KEYCODE_BUTTON_THUMBR: return new int[]{ 1, BTN1_R3       };
            case KeyEvent.KEYCODE_BUTTON_MODE:   return new int[]{ 2, BTN2_PS       };
            default:                             return null;
        }
    }
}
