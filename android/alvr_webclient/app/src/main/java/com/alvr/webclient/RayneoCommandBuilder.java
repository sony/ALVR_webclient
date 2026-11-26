package com.alvr.webclient;

/**
 * Builds 64-byte FXR output frames for RayNeo Air 3s Pro / Air 4 Pro.
 *
 * Frame layout (all fields little-endian unless otherwise noted):
 *   [0]       magic      0x66  (constant for all host→device frames)
 *   [1]       command    see RAYNEO_CMD_* constants in XrGlassesDevice
 *   [2]       value      command parameter (0x00 for most commands)
 *   [3..63]   padding    0x00
 */
public final class RayneoCommandBuilder {

    private RayneoCommandBuilder() {}   // utility class – no instances

    /** Enable IMU streaming (device will start sending 0x99 / 0x65 frames). */
    public static byte[] buildImuOn() {
        return buildFrame(XrGlassesDevice.RAYNEO_CMD_IMU_ON, (byte) 0x00);
    }

    /** Disable IMU streaming. */
    public static byte[] buildImuOff() {
        return buildFrame(XrGlassesDevice.RAYNEO_CMD_IMU_OFF, (byte) 0x00);
    }

    /** Request device-info string (response type 0x00). */
    public static byte[] buildDeviceInfo() {
        return buildFrame((byte) 0x00, (byte) 0x00);
    }

    // -----------------------------------------------------------------------

    private static byte[] buildFrame(byte command, byte value) {
        byte[] frame = new byte[XrGlassesDevice.RAYNEO_FRAME_SIZE];
        frame[0] = XrGlassesDevice.RAYNEO_FRAME_OUT_MAGIC;
        frame[1] = command;
        frame[2] = value;
        // frame[3..63] are zero-initialised by Java
        return frame;
    }
}
