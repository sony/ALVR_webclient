package com.alvr.webclient;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.InputDevice;

/**
 * Reads the DualSense gyroscope through InputDevice.getSensorManager() (API 31+),
 * integrates it into a body-frame delta rotation and hands it to a sink at ~60 Hz.
 *
 * Touch-count based reset / target selection is done in client.js; this class only
 * reports how much the controller rotated since the previous delta (no data is lost
 * by throttling because deltas are accumulated).
 *
 * Axis convention passed to the sink matches client.js (WebHID path):
 *   x = pitch (right), y = yaw (up), z = roll (towards the player), rad/s integrated.
 * Linux hid-playstation exposes gyro pitch/yaw/roll as ABS_RX/RY/RZ, which Android's
 * input sensor mapper reports as values[0..2] in rad/s.
 */
final class DualSenseGyroRelay implements SensorEventListener {

    interface Sink {
        /** Called on the sensor thread with a unit delta quaternion. */
        void onGyroDelta(double w, double x, double y, double z);
    }

    private static final String TAG = "DualSenseGyroRelay";

    // Maps Android sensor values[] to client axes {x, y, z}: source index and sign.
    private static final int[]   AXIS_INDEX = { 0, 1, 2 };
    private static final float[] AXIS_SIGN  = { +1f, +1f, +1f };

    private static final int    SAMPLING_PERIOD_US = 5_000;              // 200 Hz (no extra permission needed).
    private static final long   SEND_INTERVAL_NS   = 16_000_000L;        // ~60 Hz to JS.
    private static final double MAX_DT_S           = 0.1;                // Skip integration across gaps.
    private static final double DEADBAND_RAD_S     = Math.toRadians(0.5); // Same as client.js DS_GYRO_DEADBAND.

    private final Sink sink;

    private SensorManager sensorManager;
    private Sensor        gyro;
    private HandlerThread thread;

    // Sensor-thread state.
    private long   prevTsNs   = 0;
    private long   lastSendNs = 0;
    private double qw = 1, qx = 0, qy = 0, qz = 0;  // Pending accumulated delta.

    DualSenseGyroRelay(Sink sink) {
        this.sink = sink;
    }

    boolean isRunning() {
        return thread != null;
    }

    /** @return true if a gyroscope was found and the listener registered. */
    boolean start(InputDevice device) {
        if (isRunning()) return true;
        if (device == null) return false;

        SensorManager sm = device.getSensorManager();
        Sensor g = (sm != null) ? sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) : null;
        if (g == null) {
            Log.w(TAG, "No gyroscope on input device \"" + device.getName()
                    + "\" – DualSense gyro disabled (other input unaffected)");
            return false;
        }

        HandlerThread t = new HandlerThread("DualSenseGyro");
        t.start();
        resetIntegration();
        if (!sm.registerListener(this, g, SAMPLING_PERIOD_US, new Handler(t.getLooper()))) {
            Log.w(TAG, "registerListener failed for " + g.getName());
            t.quitSafely();
            return false;
        }
        sensorManager = sm;
        gyro = g;
        thread = t;
        Log.i(TAG, "Gyro started: " + g.getName() + " (vendor=" + g.getVendor()
                + ", maxRange=" + g.getMaximumRange() + " rad/s)");
        return true;
    }

    void stop() {
        if (!isRunning()) return;
        sensorManager.unregisterListener(this);
        thread.quitSafely();
        sensorManager = null;
        gyro = null;
        thread = null;
        Log.i(TAG, "Gyro stopped");
    }

    private void resetIntegration() {
        prevTsNs = 0;
        lastSendNs = 0;
        qw = 1; qx = qy = qz = 0;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        long ts = event.timestamp;
        long prev = prevTsNs;
        prevTsNs = ts;
        if (prev == 0) {
            lastSendNs = ts;
            return;
        }
        double dt = (ts - prev) * 1e-9;
        if (dt <= 0 || dt > MAX_DT_S) return;

        double gx = AXIS_SIGN[0] * event.values[AXIS_INDEX[0]];
        double gy = AXIS_SIGN[1] * event.values[AXIS_INDEX[1]];
        double gz = AXIS_SIGN[2] * event.values[AXIS_INDEX[2]];
        integrate(gx, gy, gz, dt);

        if (ts - lastSendNs >= SEND_INTERVAL_NS) {
            lastSendNs = ts;
            if (qw < 1.0) {  // Skip identity deltas.
                sink.onGyroDelta(qw, qx, qy, qz);
                qw = 1; qx = qy = qz = 0;
            }
        }
    }

    /** pending = pending × exp(ω·dt/2), body-frame increment (same as client.js). */
    private void integrate(double gx, double gy, double gz, double dt) {
        double w = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (w < DEADBAND_RAD_S) return;
        double half = w * dt * 0.5;
        double s = Math.sin(half) / w;
        double bw = Math.cos(half), bx = gx * s, by = gy * s, bz = gz * s;

        double nw = qw * bw - qx * bx - qy * by - qz * bz;
        double nx = qw * bx + qx * bw + qy * bz - qz * by;
        double ny = qw * by - qx * bz + qy * bw + qz * bx;
        double nz = qw * bz + qx * by - qy * bx + qz * bw;
        double n = Math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz);
        qw = nw / n; qx = nx / n; qy = ny / n; qz = nz / n;
        if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }  // Keep the short-arc form.
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
