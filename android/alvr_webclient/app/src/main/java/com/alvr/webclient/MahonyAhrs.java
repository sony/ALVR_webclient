package com.alvr.webclient;

/**
 * Mahony complementary filter for IMU orientation estimation.
 *
 * Estimates orientation as a unit quaternion by fusing gyroscope integration
 * with accelerometer gravity correction. No magnetometer required; Yaw will
 * drift slowly (~0.5-1 deg/s) due to unobservable Yaw without a magnetometer.
 *
 * Equivalent to the xrealAhrs + mahonyUpdate() implementation in client.js.
 *
 * Gains:
 *   Kp = 0.5   proportional gain — convergence speed
 *   Ki = 0.01  integral gain    — slow gyro-bias correction
 *
 * Reference: Mahony et al., "Complementary filter design on the Special
 *            Orthogonal Group SO(3)", ECC 2005
 */
public final class MahonyAhrs {

    private static final float KP = 0.5f;   // proportional gain
    private static final float KI = 0.01f;  // integral gain

    // Quaternion (w, x, y, z) — identity rotation at start
    public float q0 = 1, q1 = 0, q2 = 0, q3 = 0;

    // Integral error accumulators for gyro-bias correction
    private float integralFBx = 0, integralFBy = 0, integralFBz = 0;

    // Previous sample timestamp for dt calculation (device nanoseconds)
    public long lastTsNs = 0;

    // false until first valid IMU packet; used to gate dt calculation
    public boolean initialized = false;

    // false until initFromAccel() is called after each reset()
    public boolean accelInited = false;

    /** Resets all state. Call on each (re-)connection of the device. */
    public void reset() {
        q0 = 1; q1 = 0; q2 = 0; q3 = 0;
        integralFBx = 0; integralFBy = 0; integralFBz = 0;
        lastTsNs    = 0;
        initialized = false;
        accelInited = false;
    }

    /**
     * Initialises the quaternion from an accelerometer reading so the filter
     * starts at the natural rest orientation rather than the identity quaternion.
     *
     * This eliminates visible convergence drift on startup.
     * Call once after reset(), on the first valid (non-init-packet) IMU sample.
     *
     * Convention: chip.Z points "up" (reaction force ~0.95 g when glasses worn).
     * Mahony expects (0,0,+1) as the body-frame "up" direction.
     *
     * @param accX accelerometer X (m/s², any scale; only direction used)
     * @param accY accelerometer Y
     * @param accZ accelerometer Z (should be ~+9.8 at rest when chip.Z is up)
     */
    public void initFromAccel(float accX, float accY, float accZ) {
        float aNorm = (float) Math.sqrt(accX*accX + accY*accY + accZ*accZ);
        if (aNorm < 0.1f) return;  // near-zero; skip

        float axH = accX / aNorm, ayH = accY / aNorm, azH = accZ / aNorm;

        // Quaternion that rotates reference "up" (0,0,1) to align with measured gravity.
        //   q = (cos(theta/2), cross((0,0,1), acc_hat) * sin(theta/2))
        //   cross((0,0,1), (ax,ay,az)) = (ay, -ax, 0)
        //   qw = sqrt((1 + az_hat) / 2)
        //   qx = ay_hat / (2*qw)
        //   qy = -ax_hat / (2*qw)
        //   qz = 0
        float initQw = (float) Math.sqrt(Math.max(0.0, (1.0 + azH) / 2.0));
        if (initQw > 0.01f) {
            q0 =  initQw;
            q1 =  ayH / (2 * initQw);
            q2 = -axH / (2 * initQw);
            q3 =  0;
            // Renormalise to guard against float rounding
            float qn = (float) Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
            if (qn > 1e-6f) { q0 /= qn; q1 /= qn; q2 /= qn; q3 /= qn; }
        }
        accelInited = true;
    }

    /**
     * Mahony filter update step. Updates quaternion (q0, q1, q2, q3) in-place.
     *
     * @param gx gyroscope X (rad/s)
     * @param gy gyroscope Y (rad/s)
     * @param gz gyroscope Z (rad/s)
     * @param ax accelerometer X (any unit; only direction used)
     * @param ay accelerometer Y
     * @param az accelerometer Z
     * @param dt integration time-step (seconds)
     */
    public void update(float gx, float gy, float gz,
                       float ax, float ay, float az,
                       float dt) {
        float aNorm = (float) Math.sqrt(ax*ax + ay*ay + az*az);
        if (aNorm > 1e-6f) {
            ax /= aNorm; ay /= aNorm; az /= aNorm;

            // Estimated gravity direction in body frame from current quaternion
            float vx = 2*(q1*q3 - q0*q2);
            float vy = 2*(q0*q1 + q2*q3);
            float vz = q0*q0 - q1*q1 - q2*q2 + q3*q3;

            // Error: cross product of estimated and measured gravity
            float ex = ay*vz - az*vy;
            float ey = az*vx - ax*vz;
            float ez = ax*vy - ay*vx;

            if (KI > 0) {
                integralFBx += KI * ex * dt;
                integralFBy += KI * ey * dt;
                integralFBz += KI * ez * dt;
            }

            // Apply proportional + integral feedback to gyro measurement
            gx += KP * ex + integralFBx;
            gy += KP * ey + integralFBy;
            gz += KP * ez + integralFBz;
        }

        // Integrate quaternion rate of change: q_dot = 0.5 * q x [0, omega]
        float halfDt = 0.5f * dt;
        float pq0 = q0, pq1 = q1, pq2 = q2, pq3 = q3;
        q0 += (-pq1*gx - pq2*gy - pq3*gz) * halfDt;
        q1 += ( pq0*gx + pq2*gz - pq3*gy) * halfDt;
        q2 += ( pq0*gy - pq1*gz + pq3*gx) * halfDt;
        q3 += ( pq0*gz + pq1*gy - pq2*gx) * halfDt;

        // Normalise
        float qNorm = (float) Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
        if (qNorm > 1e-10f) {
            q0 /= qNorm; q1 /= qNorm; q2 /= qNorm; q3 /= qNorm;
        } else {
            // Numerical failure — reset to identity
            q0 = 1; q1 = 0; q2 = 0; q3 = 0;
        }
    }
}
