package com.alvr.webclient;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/**
 * Relays messages between the primary WebView (client.js) and the secondary
 * WebView (receiver.js).
 *
 * BroadcastChannel only works within the same browser process, so it cannot
 * cross independent WebView instances. This class acts as the bridge,
 * delivering messages via evaluateJavascript().
 */
public class DisplayMessageBroker {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile WebView clientWebView;
    private volatile WebView receiverWebView;

    public void setClientWebView(WebView v)   { clientWebView   = v; }
    public void setReceiverWebView(WebView v) { receiverWebView = v; }

    /**
     * Called from client.js; delivers a message to receiver.js.
     *
     * @param jsonMsg JSON string passed from AlvrClientBridge.postToReceiver()
     */
    public void postToReceiver(String jsonMsg) {
        mainHandler.post(() -> {
            WebView rv = receiverWebView;
            if (rv != null) {
                rv.evaluateJavascript(
                        "window.alvrReceiverOnMessage && window.alvrReceiverOnMessage("
                                + escapeJsonArg(jsonMsg) + ")", null);
            }
        });
    }

    /**
     * Called from receiver.js; delivers a message to client.js.
     *
     * @param jsonMsg JSON string passed from AlvrReceiverBridge.postToClient()
     */
    public void postToClient(String jsonMsg) {
        mainHandler.post(() -> {
            WebView cv = clientWebView;
            if (cv != null) {
                cv.evaluateJavascript(
                        "window.alvrClientOnMessage && window.alvrClientOnMessage("
                                + escapeJsonArg(jsonMsg) + ")", null);
            }
        });
    }

    /**
     * Escapes a JSON string so it can be safely passed as a JS string literal.
     * JSON uses double quotes, so we wrap with single quotes.
     * Only backslashes and single quotes inside the JSON need escaping.
     */
    private static String escapeJsonArg(String json) {
        // JSON uses double quotes, so wrapping in single quotes is safe.
        // Escape any backslashes and single quotes that may appear in JSON values.
        return "'" + json.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }
}
