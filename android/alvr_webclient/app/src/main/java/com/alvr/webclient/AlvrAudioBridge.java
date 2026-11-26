package com.alvr.webclient;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

/**
 * Captures microphone audio using Android's AudioRecord API and forwards
 * PCM frames to the ALVR web client running in a WebView.
 *
 * This bridge is used instead of getUserMedia() because file:// origin pages
 * in Android WebView are not treated as a secure context, which prevents
 * getUserMedia() from obtaining microphone access on many devices.
 *
 * PCM format: 48 kHz, mono, 16-bit little-endian (matches ALVR server expectation).
 * Frame size: ~20 ms (960 samples × 2 bytes = 1 920 bytes).
 *
 * Each frame is delivered to JavaScript via:
 *   window.alvrOnMicData(base64EncodedPcm)
 *
 * Lifecycle:
 *   start(webView) – begin recording; safe to call multiple times (idempotent)
 *   stop()         – stop recording and release AudioRecord; safe to call multiple times
 */
public class AlvrAudioBridge {

    private static final String TAG = "AlvrAudioBridge";

    private static final int SAMPLE_RATE    = 48_000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT   = AudioFormat.ENCODING_PCM_16BIT;
    /** ~20 ms worth of samples: 960 samples × 2 bytes = 1 920 bytes. */
    private static final int FRAME_BYTES    = 1_920;

    private AudioRecord audioRecord;
    private Thread      captureThread;
    private volatile boolean running = false;
    private WebView     webView;

    /**
     * Starts microphone capture and begins forwarding PCM frames to the WebView.
     * If already running, this call is ignored.
     *
     * @param wv The WebView that hosts the ALVR web client. Must not be null.
     */
    public synchronized void start(WebView wv) {
        if (running) {
            Log.w(TAG, "start() called while already running – ignored");
            return;
        }
        webView = wv;

        int minBuf  = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
        int bufSize = Math.max(minBuf, FRAME_BYTES * 4);

        audioRecord = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufSize);

        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord initialization failed – RECORD_AUDIO permission may be missing");
            audioRecord.release();
            audioRecord = null;
            return;
        }

        audioRecord.startRecording();
        running = true;

        captureThread = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
            byte[] buf = new byte[FRAME_BYTES];
            while (running) {
                int read = audioRecord.read(buf, 0, FRAME_BYTES);
                if (read > 0) {
                    final String b64 = Base64.encodeToString(buf, 0, read, Base64.NO_WRAP);
                    WebView wvRef = webView;
                    if (wvRef != null) {
                        wvRef.post(() -> wvRef.evaluateJavascript(
                                "window.alvrOnMicData && window.alvrOnMicData('" + b64 + "')",
                                null));
                    }
                }
            }
        }, "AlvrAudioCapture");
        captureThread.start();

        Log.i(TAG, "AudioRecord started (48 kHz, mono, 16-bit)");
    }

    /**
     * Stops microphone capture and releases the AudioRecord resource.
     * Safe to call even if recording has not been started.
     */
    public synchronized void stop() {
        if (!running) return;
        running = false;
        webView = null;

        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (IllegalStateException e) {
                Log.w(TAG, "AudioRecord.stop() failed: " + e.getMessage());
            }
            audioRecord.release();
            audioRecord = null;
        }

        if (captureThread != null) {
            captureThread.interrupt();
            captureThread = null;
        }

        Log.i(TAG, "AudioRecord stopped");
    }
}
