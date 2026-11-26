package com.alvr.webclient;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * JavascriptInterface exposed to client.js as {@code window.AlvrNativeBridge}.
 *
 * client.js detects the native app environment by checking
 * {@code typeof window.AlvrNativeBridge !== 'undefined'}.
 */
public class AlvrClientBridge {

    private final DisplayMessageBroker    broker;
    private final ImuRelayManager         imuRelayManager;
    private final DualSenseInputProcessor dsInputProcessor;
    private final WebView                 webView;
    private final AlvrAudioBridge         audioBridge;

    public AlvrClientBridge(DisplayMessageBroker broker,
                            ImuRelayManager imuRelayManager,
                            DualSenseInputProcessor dsInputProcessor,
                            WebView webView,
                            AlvrAudioBridge audioBridge) {
        this.broker           = broker;
        this.imuRelayManager  = imuRelayManager;
        this.dsInputProcessor = dsInputProcessor;
        this.webView          = webView;
        this.audioBridge      = audioBridge;
    }

    /**
     * Sends a message from client.js to receiver.js.
     * Replacement for BroadcastChannel.postMessage().
     *
     * @param jsonMsg JSON string
     */
    @JavascriptInterface
    public void postToReceiver(String jsonMsg) {
        broker.postToReceiver(jsonMsg);
    }

    /**
     * Entry point for delivering a message from receiver.js to client.js.
     * Called by AlvrReceiverBridge.postToClient() via the broker.
     * This @JavascriptInterface method is not called directly by receiver.js.
     */
    @JavascriptInterface
    public void postToClient(String jsonMsg) {
        broker.postToClient(jsonMsg);
    }

    /**
     * Returns app metadata so client.js can confirm it is running in the native app.
     * Called via {@code window.AlvrNativeBridge.getAppInfo()}.
     *
     * @return JSON string {@code {"platform":"android_native","version":"1.0.0"}}
     */
    @JavascriptInterface
    public String getAppInfo() {
        return "{\"platform\":\"android_native\",\"version\":\"1.0.0\"}";
    }

    /**
     * Called by client.js when the ALVR server tracking WebSocket opens (user pressed Connect).
     * Resumes HID polling so the IMU device starts forwarding data to the server.
     */
    @JavascriptInterface
    public void onServerConnect() {
        imuRelayManager.resumeStreaming();
        dsInputProcessor.resumeStreaming();
    }

    /**
     * Called by client.js when the ALVR server tracking WebSocket closes (user pressed
     * Disconnect, or the server dropped the connection).
     * Pauses HID polling so the USB bus is idle while no server is connected.
     */
    @JavascriptInterface
    public void onServerDisconnect() {
        imuRelayManager.pauseStreaming();
        dsInputProcessor.pauseStreaming();
    }

    /**
     * Called by client.js when running in the native app to start microphone capture.
     * Delegates to AlvrAudioBridge which uses Android's AudioRecord API.
     * PCM frames are delivered back to JavaScript via window.alvrOnMicData().
     */
    @JavascriptInterface
    public void startMicCapture() {
        audioBridge.start(webView);
    }

    /**
     * Called by client.js to stop microphone capture (e.g. on disconnect or page unload).
     */
    @JavascriptInterface
    public void stopMicCapture() {
        audioBridge.stop();
    }

    /**
     * Called by client.js triggerHaptics() when running in the native app.
     * Forwards the haptics request to the connected DualSense via VibratorManager (API 31+).
     *
     * @param durationMs vibration duration in milliseconds
     * @param amplitude  vibration intensity (0.0–1.0)
     */
    @JavascriptInterface
    public void triggerHaptics(int durationMs, float amplitude) {
        dsInputProcessor.triggerHaptics(durationMs, amplitude);
    }
}
