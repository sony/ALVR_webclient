package com.alvr.webclient;

/**
 * Builds legacy CRC-16-CCITT packets for VITURE One / Pro and V2 frames
 * for VITURE Pro 2. Keep the two wire formats on separate entry points.
 *
 * All MCU commands must be wrapped in this packet format; sending raw bytes
 * (e.g. [0x15, 0x01]) is silently ignored by VITURE Pro (PID=0x101D).
 *
 * Packet layout:
 *   [0..2)     0xFF 0xFE          MCU command header
 *   [2..4)     CRC-16-CCITT       of bytes[4..end], big-endian
 *   [4..6)     payload length     little-endian (reserved+cmd+counter+data+end)
 *   [6..14)    reserved           8 bytes, zero-filled
 *   [14..16)   command ID         little-endian
 *   [16..18)   message counter    little-endian, wraps at 0xFFFF
 *   [18..18+N) data bytes
 *   [last]     0x03               end marker
 *
 * CRC-16-CCITT: poly=0x1021, initial value=0xFFFF
 */
public final class VitureCommandBuilder {

    private static final int VITURE_PRO_2_REPORT_SIZE = 64;
    private static final int VITURE_PRO_2_IMU_CONTROL_MSG_ID = 0x0301;

    private static final int[] CRC_TABLE = buildCrcTable();

    private static int[] buildCrcTable() {
        int[] t = new int[256];
        for (int i = 0; i < 256; i++) {
            int c = i << 8;
            for (int j = 0; j < 8; j++) {
                c = ((c & 0x8000) != 0) ? ((c << 1) ^ 0x1021) : (c << 1);
            }
            t[i] = c & 0xFFFF;
        }
        return t;
    }

    private static int crc16(byte[] data, int start, int len) {
        int crc = 0xFFFF;
        for (int i = start; i < start + len; i++) {
            crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ (data[i] & 0xFF)) & 0xFF]) & 0xFFFF;
        }
        return crc;
    }

    private static int msgCounter = 0;

    /**
     * Builds a VITURE MCU command packet with CRC-16-CCITT authentication.
     *
     * @param cmdId command ID (e.g. {@link XrGlassesDevice#VITURE_IMU_CMD_ID} = 0x15)
     * @param data  payload bytes (e.g. {0x01} to enable, {0x00} to disable)
     * @return complete packet bytes ready to send via USB control transfer
     */
    public static byte[] buildVitureCmd(int cmdId, byte[] data) {
        int dLen   = (data != null) ? data.length : 0;
        int pktLen = 18 + dLen + 1;       // total packet size
        byte[] pkt = new byte[pktLen];    // zero-initialised by JVM

        pkt[0] = (byte) 0xFF;
        pkt[1] = (byte) 0xFE;             // MCU command header

        // payload length = reserved(8) + cmdId(2) + counter(2) + data(N) + end(1)
        int payLen = 8 + 2 + 2 + dLen + 1;
        pkt[4] = (byte) (payLen & 0xFF);
        pkt[5] = (byte) ((payLen >> 8) & 0xFF);

        // reserved bytes [6..14) remain zero

        pkt[14] = (byte) (cmdId & 0xFF);
        pkt[15] = (byte) ((cmdId >> 8) & 0xFF);

        msgCounter = (msgCounter + 1) & 0xFFFF;
        pkt[16] = (byte) (msgCounter & 0xFF);
        pkt[17] = (byte) ((msgCounter >> 8) & 0xFF);

        if (data != null && dLen > 0) {
            System.arraycopy(data, 0, pkt, 18, dLen);
        }
        pkt[pktLen - 1] = 0x03;           // end marker

        int crc = crc16(pkt, 4, pktLen - 4);
        pkt[2] = (byte) ((crc >> 8) & 0xFF);
        pkt[3] = (byte) (crc & 0xFF);

        return pkt;
    }

    /** Builds the IMU enable command (cmdId=0x15, data=[0x01]). */
    public static byte[] imuEnable() {
        return buildVitureCmd(XrGlassesDevice.VITURE_IMU_CMD_ID, new byte[]{0x01});
    }

    /** Builds the IMU disable command (cmdId=0x15, data=[0x00]). */
    public static byte[] imuDisable() {
        return buildVitureCmd(XrGlassesDevice.VITURE_IMU_CMD_ID, new byte[]{0x00});
    }

    /**
     * Builds a VITURE Pro 2 V2 frame. The checksum is the unsigned byte sum
     * of the payload only, modulo 2^16.
     */
    public static byte[] buildViturePro2Frame(int msgId, byte[] payload) {
        byte[] data = payload != null ? payload : new byte[0];
        if (data.length > VITURE_PRO_2_REPORT_SIZE - 8) {
            throw new IllegalArgumentException("VITURE Pro 2 payload exceeds the 64-byte HID report");
        }

        byte[] frame = new byte[8 + data.length];
        frame[0] = 0x10;
        frame[1] = 0x00;
        frame[2] = (byte) (msgId & 0xFF);
        frame[3] = (byte) ((msgId >>> 8) & 0xFF);
        frame[4] = (byte) (data.length & 0xFF);
        frame[5] = (byte) ((data.length >>> 8) & 0xFF);

        int checksum = 0;
        for (byte value : data) checksum = (checksum + (value & 0xFF)) & 0xFFFF;
        frame[6] = (byte) (checksum & 0xFF);
        frame[7] = (byte) ((checksum >>> 8) & 0xFF);
        System.arraycopy(data, 0, frame, 8, data.length);
        return frame;
    }

    /** Starts the Pro 2 fused pose stream at 90 Hz. */
    public static byte[] pro2ImuEnable() {
        return buildViturePro2Frame(VITURE_PRO_2_IMU_CONTROL_MSG_ID, new byte[]{0x01, 0x01});
    }

    /** Stops all Pro 2 IMU streams. */
    public static byte[] pro2ImuDisable() {
        return buildViturePro2Frame(VITURE_PRO_2_IMU_CONTROL_MSG_ID, new byte[]{0x00, 0x00});
    }
}
