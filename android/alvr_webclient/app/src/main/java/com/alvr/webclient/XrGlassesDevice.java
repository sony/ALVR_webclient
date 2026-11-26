package com.alvr.webclient;

/**
 * Identifies the type of connected XR glasses and provides HID protocol constants.
 *
 * Supported devices:
 *   XREAL Air 2           VID=0x3318 PID=0x0424
 *   XREAL Air 2 Ultra     VID=0x3318 PID=0x0426
 *   XREAL Air 2 Pro       VID=0x3318 PID=0x0428
 *   XREAL Air 2 Ultra     VID=0x3318 PID=0x0432
 *   XREAL Air 2 Ultra     VID=0x3318 PID=0x0436  (alt firmware)
 *   VITURE One            VID=0x35CA PID=0x1011
 *   VITURE Pro            VID=0x35CA PID=0x101D
 *   VITURE Pro 2          VID=0x35CA PID=0x1301
 *   RayNeo Air 3s Pro     VID=0x1BBB PID=0xAF50
 *   RayNeo Air 4 Pro      VID=0x1BBB PID=0xAF50
 */
public enum XrGlassesDevice {

    XREAL_AIR2(0x3318, 0x0424, DeviceFamily.XREAL),
    XREAL_AIR2_ULTRA_426(0x3318, 0x0426, DeviceFamily.XREAL),
    XREAL_AIR2_PRO(0x3318, 0x0428, DeviceFamily.XREAL),
    XREAL_AIR2_ULTRA(0x3318, 0x0432, DeviceFamily.XREAL),
    XREAL_AIR2_ULTRA_436(0x3318, 0x0436, DeviceFamily.XREAL),  // alt firmware
    VITURE_ONE(0x35CA, 0x1011, DeviceFamily.VITURE),
    VITURE_PRO(0x35CA, 0x101D, DeviceFamily.VITURE),
    VITURE_PRO_2(0x35CA, 0x1301, DeviceFamily.VITURE_PRO_2),
    RAYNEO_AIR(0x1BBB, 0xAF50, DeviceFamily.RAYNEO);

    public enum DeviceFamily { XREAL, VITURE, VITURE_PRO_2, RAYNEO }

    public final int vendorId;
    public final int productId;
    public final DeviceFamily family;

    XrGlassesDevice(int vendorId, int productId, DeviceFamily family) {
        this.vendorId  = vendorId;
        this.productId = productId;
        this.family    = family;
    }

    /** Returns the matching device or null if the VID/PID is not supported. */
    public static XrGlassesDevice fromUsbIds(int vendorId, int productId) {
        for (XrGlassesDevice d : values()) {
            if (d.vendorId == vendorId && d.productId == productId) return d;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // XREAL Air 2 / Air 2 Pro / Air 2 Ultra – HID protocol constants
    // -----------------------------------------------------------------------

    /**
     * HID report ID for IMU data packets on XREAL devices.
     * Each packet is 64 bytes with signature bytes [0x01, 0x02] at offset 0.
     * Reports have no Report ID prefix (reportId=0 in HID descriptor).
     */
    public static final byte XREAL_IMU_REPORT_ID = 0x01;

    /** Nominal IMU sample rate for XREAL Air 2 series (Hz). */
    public static final int XREAL_IMU_SAMPLE_RATE_HZ = 416;

    /** Polling timeout in milliseconds for XREAL USB bulk/interrupt reads. */
    public static final int XREAL_POLL_TIMEOUT_MS = 5;

    // XREAL IMU control messages
    public static final int  XREAL_IMU_MSG_START_DATA = 0x19;
    public static final byte XREAL_IMU_SIGNAL_START   = 0x01;
    public static final byte XREAL_IMU_SIGNAL_STOP    = 0x00;

    // -----------------------------------------------------------------------
    // VITURE One / Pro – HID protocol constants
    // -----------------------------------------------------------------------

    /** IMU enable/disable command ID for VITURE devices. */
    public static final int VITURE_IMU_CMD_ID = 0x15;

    /** Nominal IMU sample rate for VITURE devices (Hz). */
    public static final int VITURE_IMU_SAMPLE_RATE_HZ = 60;

    /** Polling timeout in milliseconds for VITURE USB interrupt reads. */
    public static final int VITURE_POLL_TIMEOUT_MS = 20;

    // -----------------------------------------------------------------------
    // RayNeo Air 3s Pro / Air 4 Pro – HID FXR protocol constants
    // -----------------------------------------------------------------------

    /** Magic byte identifying all host→device (output) frames. */
    public static final byte RAYNEO_FRAME_OUT_MAGIC = (byte) 0x66;

    /** Magic byte identifying all device→host (input) frames. */
    public static final byte RAYNEO_FRAME_IN_MAGIC  = (byte) 0x99;

    // Input frame types (buf[1] after 0x99 magic)
    public static final byte RAYNEO_PROTO_ACK_IMU_DATA  = (byte) 0x65;  // IMU data packet
    public static final byte RAYNEO_PROTO_ACK_COMMAND   = (byte) 0xC8;  // command acknowledged
    public static final byte RAYNEO_PROTO_NOTIFY_SLEEP  = (byte) 0x41;  // device entered sleep
    public static final byte RAYNEO_PROTO_NOTIFY_WAKE   = (byte) 0x42;  // device woke up

    // Output command IDs (buf[1] in a 0x66 frame)
    public static final byte RAYNEO_CMD_IMU_ON      = (byte) 0x01;  // start IMU streaming
    public static final byte RAYNEO_CMD_IMU_OFF     = (byte) 0x02;  // stop IMU streaming

    /** Size of all RayNeo FXR HID frames (both directions). */
    public static final int  RAYNEO_FRAME_SIZE         = 64;

    /** Nominal IMU sample rate for RayNeo devices (Hz). */
    public static final int  RAYNEO_IMU_SAMPLE_RATE_HZ = 60;

    /** Polling timeout in milliseconds for RayNeo USB interrupt reads. */
    public static final int  RAYNEO_POLL_TIMEOUT_MS    = 20;

    // -----------------------------------------------------------------------
    // USB control transfer constants (HID SET_REPORT)
    // -----------------------------------------------------------------------

    public static final int USB_DIR_OUT                = 0x00;
    public static final int USB_TYPE_CLASS             = 0x20;
    public static final int USB_RECIP_INTERFACE        = 0x01;
    public static final int USB_HID_SET_REPORT         = 0x09;
    public static final int USB_HID_REPORT_TYPE_OUTPUT = 0x0200;
    public static final int USB_CTRL_TIMEOUT_MS        = 1000;
}
