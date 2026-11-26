package com.alvr.webclient;

/**
 * Builds CRC32-authenticated IMU control command packets for XREAL devices.
 *
 * Without sending the START_IMU_DATA command the device is completely silent;
 * it does NOT stream IMU data automatically.
 *
 * Packet layout:
 *   [0]    head     = 0xAA
 *   [1..4] checksum = CRC32([length(2 LE), msgid, ...data]) little-endian
 *   [5..6] length   = 3 + data.length  (LE16)
 *   [7]    msgid    (e.g. 0x19 = DEVICE_IMU_MSG_START_IMU_DATA)
 *   [8..]  data     (e.g. [0x01] to start, [0x00] to stop)
 *
 * CRC32: IEEE 802.3 (polynomial=0xEDB88320, reflected input/output)
 */
public final class XrealCommandBuilder {

    /** CRC32 (IEEE 802.3, polynomial 0xEDB88320, reflected). */
    private static int crc32(byte[] data) {
        int crc = 0xFFFFFFFF;
        for (byte b : data) {
            crc ^= (b & 0xFF);
            for (int i = 0; i < 8; i++) {
                crc = ((crc & 1) != 0) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
            }
        }
        return crc ^ 0xFFFFFFFF;
    }

    /**
     * Builds an XREAL IMU control command packet.
     *
     * @param msgid command message ID (e.g. {@link XrGlassesDevice#XREAL_IMU_MSG_START_DATA})
     * @param data  payload bytes
     * @return complete packet bytes ready for USB control transfer
     */
    public static byte[] buildXrealCmd(int msgid, byte[] data) {
        int packetLen  = 3 + data.length;   // length field value (covers length+msgid+data)
        int payloadLen = 5 + packetLen;     // total bytes in packet (head+checksum+length+msgid+data)

        // Bytes to CRC: [length_lo, length_hi, msgid, ...data]
        byte[] crcInput = new byte[packetLen];
        crcInput[0] = (byte) (packetLen & 0xFF);
        crcInput[1] = (byte) ((packetLen >> 8) & 0xFF);
        crcInput[2] = (byte) (msgid & 0xFF);
        System.arraycopy(data, 0, crcInput, 3, data.length);

        int checksum = crc32(crcInput);

        byte[] cmd = new byte[payloadLen];
        cmd[0] = (byte) 0xAA;
        cmd[1] = (byte) (checksum         & 0xFF);
        cmd[2] = (byte) ((checksum >>> 8)  & 0xFF);
        cmd[3] = (byte) ((checksum >>> 16) & 0xFF);
        cmd[4] = (byte) ((checksum >>> 24) & 0xFF);
        cmd[5] = crcInput[0];  // packetLen lo
        cmd[6] = crcInput[1];  // packetLen hi
        cmd[7] = (byte) (msgid & 0xFF);
        System.arraycopy(data, 0, cmd, 8, data.length);

        return cmd;
    }

    /** Builds the START_IMU_DATA command (msgid=0x19, data=[0x01]). */
    public static byte[] startImuData() {
        return buildXrealCmd(XrGlassesDevice.XREAL_IMU_MSG_START_DATA,
                             new byte[]{XrGlassesDevice.XREAL_IMU_SIGNAL_START});
    }

    /** Builds the STOP_IMU_DATA command (msgid=0x19, data=[0x00]). */
    public static byte[] stopImuData() {
        return buildXrealCmd(XrGlassesDevice.XREAL_IMU_MSG_START_DATA,
                             new byte[]{XrGlassesDevice.XREAL_IMU_SIGNAL_STOP});
    }
}
