package com.alvr.webclient;

import android.webkit.JavascriptInterface;

/**
 * JavascriptInterface exposed to receiver.js as {@code window.AlvrNativeBridge}.
 *
 * receiver.js uses the same bridge name as client.js, but because
 * receiver.html is loaded in a separate WebView inside XrDisplayPresentation,
 * this is an independent instance.
 */
public class AlvrReceiverBridge {

    private final DisplayMessageBroker broker;

    public AlvrReceiverBridge(DisplayMessageBroker broker) {
        this.broker = broker;
    }

    /**
     * Sends a message from receiver.js to client.js (e.g. 'ready' notifications).
     *
     * @param jsonMsg JSON string
     */
    @JavascriptInterface
    public void postToClient(String jsonMsg) {
        broker.postToClient(jsonMsg);
    }

    /**
     * Returns app metadata so receiver.js can confirm it is running in the native app.
     *
     * @return JSON string {@code {"platform":"android_native","version":"1.0.0"}}
     */
    @JavascriptInterface
    public String getAppInfo() {
        return "{\"platform\":\"android_native\",\"version\":\"1.0.0\"}";
    }
}
