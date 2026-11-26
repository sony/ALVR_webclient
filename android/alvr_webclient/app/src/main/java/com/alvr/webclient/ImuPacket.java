package com.alvr.webclient;

/**
 * Normalised IMU data packet produced by the device-specific parsers.
 *
 * All values use the OpenXR / ALVR coordinate convention:
 *   X = right, Y = up, Z = backward (right-handed)
 *
 * The orientation quaternion is normalised (unit quaternion).
 * Angular velocity is in rad/s; linear acceleration is in m/s².
 */
public final class ImuPacket {

    /** Monotonic timestamp in nanoseconds (device clock, not wall clock). */
    public final long timestampNs;

    /** Head orientation quaternion (w, x, y, z). */
    public final float qw, qx, qy, qz;

    /** Angular velocity in rad/s (x, y, z). */
    public final float gyrX, gyrY, gyrZ;

    /** Linear acceleration in m/s² (x, y, z). */
    public final float accX, accY, accZ;

    public ImuPacket(long timestampNs,
                     float qw, float qx, float qy, float qz,
                     float gyrX, float gyrY, float gyrZ,
                     float accX, float accY, float accZ) {
        this.timestampNs = timestampNs;
        this.qw = qw; this.qx = qx; this.qy = qy; this.qz = qz;
        this.gyrX = gyrX; this.gyrY = gyrY; this.gyrZ = gyrZ;
        this.accX = accX; this.accY = accY; this.accZ = accZ;
    }

    // -----------------------------------------------------------------------
    // VITURE Euler angles -> OpenXR quaternion
    // -----------------------------------------------------------------------

    /**
     * Converts VITURE Euler angles to an OpenXR Y-up quaternion.
     *
     * @param rollZ  physical roll around the OpenXR Z axis (rad)
     * @param pitchX physical pitch around the OpenXR X axis (rad)
     * @param yawY   physical yaw around the OpenXR Y axis (rad)
     * @return float[4] = { w, x, y, z }
     */
    public static float[] vitureEulerToQuat(float rollZ, float pitchX, float yawY) {
        float cr = (float) Math.cos(rollZ  * 0.5);
        float sr = (float) Math.sin(rollZ  * 0.5);
        float cp = (float) Math.cos(pitchX * 0.5);
        float sp = (float) Math.sin(pitchX * 0.5);
        float cy = (float) Math.cos(yawY   * 0.5);
        float sy = (float) Math.sin(yawY   * 0.5);

        // qY(yaw) * qX(pitch) * qZ(roll): roll remains head-local after yaw.
        float w = cr * cp * cy + sr * sp * sy;
        float x = cr * sp * cy + sr * cp * sy;
        float y = cr * cp * sy - sr * sp * cy;
        float z = sr * cp * cy - cr * sp * sy;

        // Normalise
        float norm = (float) Math.sqrt(w*w + x*x + y*y + z*z);
        if (norm > 1e-6f) { w /= norm; x /= norm; y /= norm; z /= norm; }

        return new float[]{ w, x, y, z };
    }
}
