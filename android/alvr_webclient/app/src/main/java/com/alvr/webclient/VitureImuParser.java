package com.alvr.webclient;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Parses raw USB HID interrupt reports from VITURE One / Pro XR Glasses.
 * Pro 2 Protocol V2 reports use the separate {@link #parsePro2(byte[], int)} path.
 *
 * Packet layout (64 bytes):
 *   [0..2)   header        0xFF 0xFC = IMU data  |  0xFF 0xFD = MCU ACK / IMU data (Pro)
 *   [2..4)   CRC-16-CCITT  big-endian (not verified here)
 *   [4..6)   payload length little-endian
 *   [6..10)  timestamp     uint32 device timebase (not used; System.nanoTime() instead)
 *   [10..18) reserved / cmd-id / counter
 *   [18..22) Euler angle 0 big-endian float32, degrees  (raw yaw)
 *   [22..26) Euler angle 1 big-endian float32, degrees  (raw roll)
 *   [26..30) Euler angle 2 big-endian float32, degrees  (raw pitch)
 *
 * Axis remapping to OpenXR's Y-up coordinate system:
 *   roll  (Z) = -raw0
 *   pitch (X) = -raw1
 *   yaw   (Y) =  raw2
 *
 * Orientation is converted to a unit quaternion via ImuPacket.vitureEulerToQuat().
 * Angular velocity is estimated from successive quaternion differences.
 * VITURE does not expose raw accelerometer data; accX/Y/Z are reported as 0.
 */
public final class VitureImuParser {

    private static final int VITURE_PRO_2_POSE_EVENT_MSG_ID = 0x7308;
    private static final int VITURE_PRO_2_RAW_EVENT_MSG_ID = 0x7309;
    private static final int VITURE_PRO_2_ACK_MSG_ID = 0x2301;
    private static final int VITURE_PRO_2_FRAME_HEADER_SIZE = 8;

    public enum Pro2PacketType { POSE, ACK, IGNORED, INVALID }

    public static final class Pro2ParseResult {
        public final Pro2PacketType type;
        public final ImuPacket packet;
        public final int messageId;
        public final int status;
        public final long deviceTimestamp;
        public final String error;

        private Pro2ParseResult(Pro2PacketType type, ImuPacket packet, int messageId,
                                int status, long deviceTimestamp, String error) {
            this.type = type;
            this.packet = packet;
            this.messageId = messageId;
            this.status = status;
            this.deviceTimestamp = deviceTimestamp;
            this.error = error;
        }
    }

    private static final byte   HEADER_0   = (byte) 0xFF;
    private static final byte   HEADER_IMU = (byte) 0xFC;  // 0xFF 0xFC = IMU data packet
    private static final byte   HEADER_ACK = (byte) 0xFD;  // 0xFF 0xFD = MCU ACK (or IMU on Pro)

    private static final int MIN_PACKET_SIZE = 30;  // need bytes up to offset 30

    private static final int OFF_HEADER_0 = 0;
    private static final int OFF_HEADER_1 = 1;
    private static final int OFF_EULER_0  = 18;  // big-endian float32, degrees (raw yaw)
    private static final int OFF_EULER_1  = 22;  // big-endian float32, degrees (raw roll)
    private static final int OFF_EULER_2  = 26;  // big-endian float32, degrees (raw pitch)

    private static final float D2R = (float) (Math.PI / 180.0);

    // State for angular velocity estimation from successive quaternion differences
    private long  prevTimestampNs = 0;
    private float prevQw = 1, prevQx = 0, prevQy = 0, prevQz = 0;
    private long  pro2PrevTimestampNs = 0;
    private float pro2PrevQw = 1, pro2PrevQx = 0, pro2PrevQy = 0, pro2PrevQz = 0;

    /** Resets state used only by the Pro 2 fused-pose stream. */
    public void resetPro2() {
        pro2PrevTimestampNs = 0;
        pro2PrevQw = 1;
        pro2PrevQx = 0;
        pro2PrevQy = 0;
        pro2PrevQz = 0;
    }

    private static Pro2ParseResult pro2Result(Pro2PacketType type, ImuPacket packet,
                                               int messageId, int status,
                                               long deviceTimestamp, String error) {
        return new Pro2ParseResult(type, packet, messageId, status, deviceTimestamp, error);
    }

    /**
     * Parses a VITURE Protocol V2 frame from the Pro 2 HID report.
     * The report may contain zero padding after the declared frame.
     */
    public Pro2ParseResult parsePro2(byte[] buf, int length) {
        if (buf == null || length < VITURE_PRO_2_FRAME_HEADER_SIZE || length > buf.length) {
            return pro2Result(Pro2PacketType.INVALID, null, -1, -1, 0,
                    "invalid frame length");
        }
        if ((buf[0] & 0xFF) != 0x10 || (buf[1] & 0xFF) != 0x00) {
            return pro2Result(Pro2PacketType.INVALID, null, -1, -1, 0,
                    "invalid preamble");
        }

        ByteBuffer frame = ByteBuffer.wrap(buf, 0, length).order(ByteOrder.LITTLE_ENDIAN);
        int messageId = frame.getShort(2) & 0xFFFF;
        int payloadLength = frame.getShort(4) & 0xFFFF;
        int frameLength = VITURE_PRO_2_FRAME_HEADER_SIZE + payloadLength;
        if (frameLength > length) {
            return pro2Result(Pro2PacketType.INVALID, null, messageId, -1, 0,
                    "truncated frame");
        }

        int checksum = 0;
        for (int i = VITURE_PRO_2_FRAME_HEADER_SIZE; i < frameLength; i++) {
            checksum = (checksum + (buf[i] & 0xFF)) & 0xFFFF;
        }
        int expectedChecksum = frame.getShort(6) & 0xFFFF;
        if (checksum != expectedChecksum) {
            return pro2Result(Pro2PacketType.INVALID, null, messageId, -1, 0,
                    "checksum mismatch");
        }

        if (messageId == VITURE_PRO_2_ACK_MSG_ID) {
            if (payloadLength != 1) {
                return pro2Result(Pro2PacketType.INVALID, null, messageId, -1, 0,
                        "invalid IMU control ACK length");
            }
            return pro2Result(Pro2PacketType.ACK, null, messageId, buf[8] & 0xFF, 0, null);
        }
        if (messageId == VITURE_PRO_2_RAW_EVENT_MSG_ID) {
            return pro2Result(Pro2PacketType.IGNORED, null, messageId, -1, 0, null);
        }
        if (messageId != VITURE_PRO_2_POSE_EVENT_MSG_ID) {
            return pro2Result(Pro2PacketType.IGNORED, null, messageId, -1, 0, null);
        }
        if (payloadLength != 24) {
            return pro2Result(Pro2PacketType.INVALID, null, messageId, -1, 0,
                    "invalid pose payload length");
        }

        long deviceTimestamp = Integer.toUnsignedLong(frame.getInt(12));
        float qw = frame.getFloat(16);
        float qx = frame.getFloat(20);
        float qy = frame.getFloat(24);
        float qz = frame.getFloat(28);
        float norm = (float) Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
        if (!Float.isFinite(qw) || !Float.isFinite(qx) || !Float.isFinite(qy)
                || !Float.isFinite(qz) || !Float.isFinite(norm) || norm < 0.5f || norm > 1.5f) {
            return pro2Result(Pro2PacketType.INVALID, null, messageId, -1, deviceTimestamp,
                    "invalid pose quaternion");
        }
        qw /= norm;
        qx /= norm;
        qy /= norm;
        qz /= norm;

        long timestampNs = System.nanoTime();
        double dt = pro2PrevTimestampNs == 0
                ? 0
                : (timestampNs - pro2PrevTimestampNs) * 1e-9;
        if (pro2PrevTimestampNs != 0) {
            double dot = qw*pro2PrevQw + qx*pro2PrevQx + qy*pro2PrevQy + qz*pro2PrevQz;
            if (dot < 0) {
                qw = -qw;
                qx = -qx;
                qy = -qy;
                qz = -qz;
            }
            double continuousDot = Math.min(1.0, Math.abs(
                    qw*pro2PrevQw + qx*pro2PrevQx + qy*pro2PrevQy + qz*pro2PrevQz));
            double angle = 2.0 * Math.acos(continuousDot);
            double maxAngle = dt > 0 && dt < 0.1
                    ? Math.max(Math.toRadians(20), 25 * dt)
                    : Math.toRadians(120);
            if (angle > maxAngle) {
                return pro2Result(Pro2PacketType.INVALID, null, messageId, -1,
                        deviceTimestamp, "pose jump");
            }
        }

        float gyrX = 0, gyrY = 0, gyrZ = 0;
        if (dt > 0 && dt < 0.1) {
            float dqw = qw - pro2PrevQw, dqx = qx - pro2PrevQx;
            float dqy = qy - pro2PrevQy, dqz = qz - pro2PrevQz;
            float inv2dt = (float) (2.0 / dt);
            float pw = pro2PrevQw, px = pro2PrevQx, py = pro2PrevQy, pz = pro2PrevQz;
            gyrX = inv2dt * ( dqx*pw - dqw*px - dqz*py + dqy*pz);
            gyrY = inv2dt * ( dqy*pw + dqz*px - dqw*py - dqx*pz);
            gyrZ = inv2dt * ( dqz*pw - dqy*px + dqx*py - dqw*pz);
        }

        pro2PrevTimestampNs = timestampNs;
        pro2PrevQw = qw;
        pro2PrevQx = qx;
        pro2PrevQy = qy;
        pro2PrevQz = qz;
        ImuPacket packet = new ImuPacket(timestampNs, qw, qx, qy, qz,
                gyrX, gyrY, gyrZ, 0f, 0f, 0f);
        return pro2Result(Pro2PacketType.POSE, packet, messageId, -1,
                deviceTimestamp, null);
    }

    /**
     * Parses a raw HID interrupt report into an {@link ImuPacket}.
     *
     * @param buf    raw bytes from {@code UsbDeviceConnection.bulkTransfer()}
     * @param length number of valid bytes in {@code buf}
     * @return parsed ImuPacket, or {@code null} if not a valid IMU data packet
     */
    public ImuPacket parse(byte[] buf, int length) {
        if (length < MIN_PACKET_SIZE) return null;
        if (buf[OFF_HEADER_0] != HEADER_0) return null;

        final boolean isFdPacket = (buf[OFF_HEADER_1] == HEADER_ACK);   // 0xFF 0xFD

        if (buf[OFF_HEADER_1] != HEADER_IMU && buf[OFF_HEADER_1] != HEADER_ACK) {
            // Unknown packet type — ignore
            return null;
        }

        // Read Euler angles as big-endian float32 (VITURE_PROTOCOL.md)
        ByteBuffer bb = ByteBuffer.wrap(buf, 0, length).order(ByteOrder.BIG_ENDIAN);
        float raw0 = bb.getFloat(OFF_EULER_0);  // physical roll  (degrees)
        float raw1 = bb.getFloat(OFF_EULER_1);  // physical pitch (degrees)
        float raw2 = bb.getFloat(OFF_EULER_2);  // physical yaw   (degrees)

        // Reject packets whose Euler angles are NaN or Infinite.
        // Genuine MCU ACK packets (0xFF 0xFD) that carry command status rather than sensor
        // data typically have zeros or invalid floats at the Euler offsets.  Filtering them
        // here avoids injecting garbage quaternions while still allowing 0xFF 0xFD packets
        // that carry valid Euler data (VITURE Pro firmware behaviour on Android).
        if (Float.isNaN(raw0) || Float.isInfinite(raw0)
         || Float.isNaN(raw1) || Float.isInfinite(raw1)
         || Float.isNaN(raw2) || Float.isInfinite(raw2)) {

            return null;
        }


        // Map VITURE's physical axes to OpenXR: X=pitch, Y=yaw, Z=roll.
        float rollZ  = -raw0;
        float pitchX = -raw1;
        float yawY   =  raw2;

        float[] q = ImuPacket.vitureEulerToQuat(
            rollZ * D2R, pitchX * D2R, yawY * D2R);
        float qw = q[0], qx = q[1], qy = q[2], qz = q[3];

        // Use system monotonic clock for timestamp (consistent with JS performance.now() domain)
        long timestampNs = System.nanoTime();

        // Estimate angular velocity from quaternion derivative: omega ~= 2 * dq/dt * q*
        float gyrX = 0, gyrY = 0, gyrZ = 0;
        if (prevTimestampNs != 0) {
            double dt = (timestampNs - prevTimestampNs) * 1e-9;
            if (dt > 0 && dt < 0.1) {
                float dqw = qw - prevQw, dqx = qx - prevQx;
                float dqy = qy - prevQy, dqz = qz - prevQz;
                float inv2dt = (float) (2.0 / dt);
                float pw = prevQw, px = prevQx, py = prevQy, pz = prevQz;
                gyrX = inv2dt * ( dqx*pw - dqw*px - dqz*py + dqy*pz);
                gyrY = inv2dt * ( dqy*pw + dqz*px - dqw*py - dqx*pz);
                gyrZ = inv2dt * ( dqz*pw - dqy*px + dqx*py - dqw*pz);
            }
        }
        prevTimestampNs = timestampNs;
        prevQw = qw; prevQx = qx; prevQy = qy; prevQz = qz;

        // VITURE does not expose raw accelerometer data via HID; report zeros.
        return new ImuPacket(timestampNs, qw, qx, qy, qz, gyrX, gyrY, gyrZ, 0f, 0f, 0f);
    }
}
