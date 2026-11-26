package com.alvr.webclient;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Parses raw USB HID interrupt reports from XREAL Air 2 / Air 2 Ultra.
 *
 * The device outputs raw 24-bit integer sensor data; it does NOT provide
 * a quaternion directly. Orientation is derived via Mahony complementary
 * filter (sensor fusion: gyro + accel -> quaternion).
 *
 * Before any IMU data arrives, sendXrealImuStart() (XrealCommandBuilder)
 * must be called. The device is completely silent without this command.
 *
 * Packet layout:
 *   [0..2)   signature[2]              0x01 0x02 = IMU data | 0xAA 0x53 = init packet
 *   [2..4)   temperature[2]            int16 LE (unused)
 *   [4..12)  timestamp[8]              uint64 LE, nanoseconds (device clock)
 *   [12..14) angular_multiplier[2]     int16 LE
 *   [14..18) angular_divisor[4]        int32 LE
 *   [18..21) angular_velocity_x[3]     int24 LE signed  (raw deg/s)
 *   [21..24) angular_velocity_y[3]     int24 LE signed
 *   [24..27) angular_velocity_z[3]     int24 LE signed
 *   [27..29) acceleration_multiplier[2] int16 LE
 *   [29..33) acceleration_divisor[4]   int32 LE
 *   [33..36) acceleration_x[3]         int24 LE signed  (raw m/s^2)
 *   [36..39) acceleration_y[3]         int24 LE signed
 *   [39..42) acceleration_z[3]         int24 LE signed
 *   [42..64) magnetometer + checksum + padding (unused)
 *
 * Sensor conversion:
 *   gyro (deg/s)  = raw_int24 * angular_multiplier / angular_divisor
 *   gyro (rad/s)  = gyro_dps * PI / 180
 *   accel (m/s^2) = raw_int24 * acceleration_multiplier / acceleration_divisor
 *
 * Chip-frame to OpenVR Y-up right-hand coordinate transform (when worn):
 *   chip.X (right)   -> VR.X:   qx_out = -q1
 *   chip.Z (up)      -> VR.Y:   qy_out =  q3
 *   chip.Y (forward) -> -VR.Z:  qz_out =  q2
 *   qw_out = q0  (unchanged)
 */
public final class XrealImuParser {

    private static final int  MIN_PACKET_SIZE = 42;
    private static final byte SIG0_IMU  = 0x01;
    private static final byte SIG1_IMU  = 0x02;
    private static final byte SIG0_INIT = (byte) 0xAA;
    private static final byte SIG1_INIT = 0x53;

    private static final int OFF_SIG0   = 0;
    private static final int OFF_SIG1   = 1;
    private static final int OFF_TS     = 4;   // uint64 LE nanoseconds
    private static final int OFF_VEL_M  = 12;  // int16 LE angular_multiplier
    private static final int OFF_VEL_D  = 14;  // int32 LE angular_divisor
    private static final int OFF_VEL_X  = 18;  // int24 LE signed
    private static final int OFF_VEL_Y  = 21;
    private static final int OFF_VEL_Z  = 24;
    private static final int OFF_ACC_M  = 27;  // int16 LE acceleration_multiplier
    private static final int OFF_ACC_D  = 29;  // int32 LE acceleration_divisor
    private static final int OFF_ACC_X  = 33;  // int24 LE signed
    private static final int OFF_ACC_Y  = 36;
    private static final int OFF_ACC_Z  = 39;

    private static final float D2R = (float) (Math.PI / 180.0);

    // Throttle tracking sends to 90 Hz.
    // XREAL Air 2 Ultra outputs ~1000 Hz; ALVR's server_openvr is designed for ~90 Hz.
    // Sending at 1000 Hz causes the mpsc::channel() event queue to grow without bound,
    // creating ever-increasing latency (confirmed in client.js log analysis).
    // Mahony filter runs at the full native rate for accuracy; only delivery is throttled.
    private static final long SEND_INTERVAL_NS = 1_000_000_000L / 90;

    private final MahonyAhrs ahrs = new MahonyAhrs();

    private long lastSendNs = 0;

    /** Resets AHRS state. Call on each (re-)connection of the device. */
    public void reset() {
        ahrs.reset();
        lastSendNs = 0;
    }

    /**
     * Parses a raw HID interrupt report, runs Mahony sensor fusion, and returns
     * an ImuPacket at ~90 Hz; returns {@code null} if the packet is invalid,
     * an init packet, or the 90 Hz throttle is active.
     *
     * @param buf    raw bytes from {@code UsbDeviceConnection.bulkTransfer()}
     * @param length number of valid bytes in {@code buf}
     */
    public ImuPacket parse(byte[] buf, int length) {
        if (length < MIN_PACKET_SIZE) return null;

        // Init packet — device reset/boot; reset AHRS and keep running
        if (buf[OFF_SIG0] == SIG0_INIT && buf[OFF_SIG1] == SIG1_INIT) {
            android.util.Log.d("XrealImuParser", "INIT packet (0xAA 0x53) received — resetting AHRS");
            ahrs.reset();
            return null;
        }

        // Accept only IMU data packets
        if (buf[OFF_SIG0] != SIG0_IMU || buf[OFF_SIG1] != SIG1_IMU) {
            // Control response or unknown packet — ignore
            return null;
        }

        ByteBuffer bb = ByteBuffer.wrap(buf, 0, length).order(ByteOrder.LITTLE_ENDIAN);

        // Timestamp from device (nanoseconds, device monotonic clock)
        long timestampNs = bb.getLong(OFF_TS);

        // Gyroscope: raw int24 LE -> deg/s -> rad/s
        short velM = bb.getShort(OFF_VEL_M);
        int   velD = bb.getInt(OFF_VEL_D);
        int velXr = int24LE(buf, OFF_VEL_X);
        int velYr = int24LE(buf, OFF_VEL_Y);
        int velZr = int24LE(buf, OFF_VEL_Z);
        float gyrX = (velD != 0) ? (velXr * velM / (float) velD) * D2R : 0;
        float gyrY = (velD != 0) ? (velYr * velM / (float) velD) * D2R : 0;
        float gyrZ = (velD != 0) ? (velZr * velM / (float) velD) * D2R : 0;

        // Accelerometer: raw int24 LE -> m/s^2
        short accM = bb.getShort(OFF_ACC_M);
        int   accD = bb.getInt(OFF_ACC_D);
        int accXr = int24LE(buf, OFF_ACC_X);
        int accYr = int24LE(buf, OFF_ACC_Y);
        int accZr = int24LE(buf, OFF_ACC_Z);
        float accX = (accD != 0) ? (accXr * accM / (float) accD) : 0;
        float accY = (accD != 0) ? (accYr * accM / (float) accD) : 0;
        float accZ = (accD != 0) ? (accZr * accM / (float) accD) : 0;

        // Calculate dt from device timestamp
        float dt = 0.001f;  // fallback: 1 ms (matches ~1000 Hz native rate)
        if (ahrs.initialized && timestampNs > ahrs.lastTsNs) {
            double dtRaw = (timestampNs - ahrs.lastTsNs) * 1e-9;
            dt = (dtRaw > 0 && dtRaw < 0.1) ? (float) dtRaw : 0.001f;
        }
        ahrs.lastTsNs    = timestampNs;
        ahrs.initialized = true;

        // Mahony filter update with raw chip data (no pre-transform).
        // At rest: chip.Z ~= 0.95 g (gravity reaction), chip.X ~= 0, chip.Y ~= 0.45 g.
        // Mahony expects (0,0,+1) as "up"; feeding chip data directly gives a small
        // (~25 deg) initial tilt from the glasses nose-bridge slope, which converges quickly.
        ahrs.update(gyrX, gyrY, gyrZ, accX, accY, accZ, dt);

        // Post-transform: chip frame -> OpenVR Y-up right-hand coordinate system
        //   chip.X (right)   -> VR.X   (qx_out = -q1, negated for correct handedness)
        //   chip.Z (up)      -> VR.Y   (qy_out =  q3)
        //   chip.Y (forward) -> -VR.Z  (qz_out =  q2, -chip.Y = VR.Z backward)
        float qwOut =  ahrs.q0;
        float qxOut = -ahrs.q1;
        float qyOut =  ahrs.q3;
        float qzOut =  ahrs.q2;

        // Angular velocity in VR frame (same axis mapping as quaternion)
        float wVrX =  gyrX;
        float wVrY =  gyrZ;
        float wVrZ = -gyrY;

        // 90 Hz throttle: Mahony runs at full rate but delivery is capped.
        // Use System.nanoTime() for the output timestamp so it is consistent
        // with the JS performance.now()-based clock domain used by client.js.
        long nowNs = System.nanoTime();
        if (nowNs - lastSendNs < SEND_INTERVAL_NS) return null;
        lastSendNs = nowNs;

        return new ImuPacket(nowNs, qwOut, qxOut, qyOut, qzOut,
                             wVrX, wVrY, wVrZ, accX, accY, accZ);
    }

    /** Reads a signed 24-bit little-endian integer from a byte array. */
    private static int int24LE(byte[] buf, int offset) {
        int lo = buf[offset]     & 0xFF;
        int mi = buf[offset + 1] & 0xFF;
        int hi = buf[offset + 2] & 0xFF;
        // Sign-extend from 24 to 32 bits via left/right arithmetic shift
        return ((lo | (mi << 8) | (hi << 16)) << 8) >> 8;
    }
}
