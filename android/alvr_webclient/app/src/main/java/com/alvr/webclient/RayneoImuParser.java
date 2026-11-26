package com.alvr.webclient;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Parses raw 64-byte USB HID frames from RayNeo Air 3s Pro / Air 4 Pro.
 *
 * Both devices share VID=0x1BBB PID=0xAF50 and the same FXR HID protocol
 *
 * IMU frame layout (device → host, 64 bytes):
 *   [0]       magic      0x99  (input frame identifier)
 *   [1]       type       0x65  = IMU data  |  0xC8 = command ACK
 *                               0x41 = sleep notification  |  0x42 = wake notification
 *   [2..3]    reserved
 *   [4..7]    accX       float32 LE  (m/s²)
 *   [8..11]   accY       float32 LE  (m/s²)
 *   [12..15]  accZ       float32 LE  (m/s²)
 *   [16..19]  gyrXDps    float32 LE  (degrees/s)
 *   [20..23]  gyrYDps    float32 LE  (degrees/s)
 *   [24..27]  gyrZDps    float32 LE  (degrees/s)
 *   [28..63]  reserved / additional sensor data (tick, temperature, etc.)
 *
 * Orientation is derived via Mahony complementary filter (sensor fusion:
 * gyro + accel → quaternion); the device does NOT output quaternion directly.
 *
 * Chip-frame to OpenVR Y-up right-hand coordinate transform (initial estimate;
 * adjust if axis mismatch is observed during physical testing):
 *   chip.X (right)   → VR.X:   qx_out = -q1
 *   chip.Z (up)      → VR.Y:   qy_out =  q3
 *   chip.Y (forward) → -VR.Z:  qz_out =  q2
 *   qw_out = q0  (unchanged)
 *
 * This mapping is the same as XREAL Air 2 Ultra, which has a similar physical
 * axis orientation.  Empirical verification is required on real hardware.
 */
public final class RayneoImuParser {

    private static final int  MIN_FRAME_SIZE = 28;  // need offsets 4..27 valid

    private static final byte MAGIC_IN    = (byte) 0x99;
    private static final byte TYPE_IMU    = (byte) 0x65;

    // Offsets within the 64-byte FXR frame
    private static final int OFF_MAGIC  = 0;
    private static final int OFF_TYPE   = 1;
    private static final int OFF_ACC_X  = 4;   // float32 LE m/s²
    private static final int OFF_ACC_Y  = 8;
    private static final int OFF_ACC_Z  = 12;
    private static final int OFF_GYR_X  = 16;  // float32 LE deg/s
    private static final int OFF_GYR_Y  = 20;
    private static final int OFF_GYR_Z  = 24;

    private static final float DEG_TO_RAD = (float) (Math.PI / 180.0);

    // Throttle output to 90 Hz.
    // ALVR's server_openvr event queue is designed for ~90 Hz; sending faster
    // causes the mpsc::channel() to grow without bound (same issue as XREAL 1 kHz).
    private static final long SEND_INTERVAL_NS = 1_000_000_000L / 90;

    // RayNeo: higher Kp for faster accel correction (chip is ~35° tilted, ~500 Hz IMU);
    // lower Ki to reduce integral bias accumulation at high sample rate.
    private final MahonyAhrs ahrs = new MahonyAhrs();

    private long lastSendNs  = 0;
    private long lastFrameNs = 0;   // wall clock at previous frame (for dt)

    /** Resets AHRS state. Call on each (re-)connection. */
    public void reset() {
        ahrs.reset();
        lastSendNs  = 0;
        lastFrameNs = 0;
    }

    /**
     * Parses a raw 64-byte FXR IMU frame, runs Mahony sensor fusion, and returns
     * an {@link ImuPacket} at ≤90 Hz; returns {@code null} if the frame is invalid,
     * not an IMU packet, or the 90 Hz throttle is active.
     *
     * @param buf    raw bytes from {@code UsbDeviceConnection.bulkTransfer()}
     * @param length number of valid bytes in {@code buf}
     */
    public ImuPacket parse(byte[] buf, int length) {
        if (length < MIN_FRAME_SIZE)     return null;
        if (buf[OFF_MAGIC] != MAGIC_IN)  return null;

        if (buf[OFF_TYPE] != TYPE_IMU) {
            // Command ACK / sleep / wake notification — ignore silently
            return null;
        }

        ByteBuffer bb = ByteBuffer.wrap(buf, 0, length).order(ByteOrder.LITTLE_ENDIAN);

        float accX = bb.getFloat(OFF_ACC_X);
        float accY = bb.getFloat(OFF_ACC_Y);
        float accZ = bb.getFloat(OFF_ACC_Z);

        float gyrXDps = bb.getFloat(OFF_GYR_X);
        float gyrYDps = bb.getFloat(OFF_GYR_Y);
        float gyrZDps = bb.getFloat(OFF_GYR_Z);

        // Sanity-check: reject NaN / Inf that would corrupt Mahony state
        if (!Float.isFinite(accX) || !Float.isFinite(accY) || !Float.isFinite(accZ)
         || !Float.isFinite(gyrXDps) || !Float.isFinite(gyrYDps) || !Float.isFinite(gyrZDps)) {
            return null;
        }

        final float gyrX = gyrXDps * DEG_TO_RAD;
        final float gyrY = gyrYDps * DEG_TO_RAD;
        final float gyrZ = gyrZDps * DEG_TO_RAD;

        // dt: use wall-clock difference (RayNeo device timestamp units unknown).
        // Fallback: nominal 60 Hz sample rate.
        long nowNs = System.nanoTime();
        float dt = 1.0f / XrGlassesDevice.RAYNEO_IMU_SAMPLE_RATE_HZ;
        if (lastFrameNs != 0) {
            double dtRaw = (nowNs - lastFrameNs) * 1e-9;
            if (dtRaw > 0 && dtRaw < 0.1) dt = (float) dtRaw;
        }
        lastFrameNs = nowNs;

        // Mahony filter update with Y↔Z swap (chip.Y = dominant up axis, 0.82g at rest).
        // After swap: filter.Z = chip.Y aligns with Mahony reference direction (0, 0, +1).
        // gyrX is negated: without negation the accel correction nearly cancels gyrX during
        // pitch, causing large pitch tracking delay. Negating makes them work together.
        ahrs.update(-gyrX, gyrZ, gyrY, accX, accZ, accY, dt);

        // 90 Hz throttle — continue running Mahony at full rate but cap delivery.
        if (nowNs - lastSendNs < SEND_INTERVAL_NS) return null;
        lastSendNs = nowNs;

        // Post-transform: chip frame → OpenVR Y-up right-hand coordinate system.
        // After Y↔Z swap: filter.X=chip.X, filter.Y=chip.Z, filter.Z=chip.Y.
        //   chip.X (right)   → VR.X:   qx_out = -q1  (-q1 with -gyrX feed → correct pitch)
        //   chip.Y (up)      → VR.Y:   qy_out =  q3
        //   chip.Z (forward) → -VR.Z:  qz_out =  q2
        float qwOut =  ahrs.q0;
        float qxOut = -ahrs.q1;  // -q1 with -gyrX feed → correct pitch direction
        float qyOut =  ahrs.q3;
        float qzOut =  ahrs.q2;

        // Angular velocity: d(qxOut)/dt = d(-q1)/dt ∝ +gyrX, so wVrX = +gyrX
        float wVrX =  gyrX;   // consistent with qxOut direction (d(-q1)/dt ∝ +gyrX)
        float wVrY =  gyrY;   // chip.Y (up) → VR.Y (yaw)
        float wVrZ = -gyrZ;   // chip.Z (fwd) → -VR.Z

        // Use System.nanoTime() for the output timestamp so it is in the same
        // clock domain as the JS performance.now()-based clock used by client.js.
        return new ImuPacket(nowNs, qwOut, qxOut, qyOut, qzOut,
                             wVrX, wVrY, wVrZ, accX, accY, accZ);
    }
}
