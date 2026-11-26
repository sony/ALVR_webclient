package com.alvr.webclient;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Point;
import android.os.Bundle;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;

/**
 * Full-screen Presentation shown on the secondary XR display.
 *
 * Hosts a WebView that loads receiver.html at the display's native resolution
 * (e.g. 3840x1080). Messages between client.js and receiver.js are relayed
 * through DisplayMessageBroker.
 */
public class XrDisplayPresentation extends Presentation {

    private static final String TAG = "XrDisplayPresentation";

    private final DisplayMessageBroker broker;
    private WebView receiverWebView;

    public XrDisplayPresentation(Context context, Display display,
                                  DisplayMessageBroker broker) {
        super(context, display);
        this.broker = broker;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Configure full-screen mode (hide status bar and navigation bar).
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        receiverWebView = new WebView(getContext());
        MainActivity.configureWebView(receiverWebView);

        AlvrReceiverBridge receiverBridge = new AlvrReceiverBridge(broker);
        receiverWebView.addJavascriptInterface(receiverBridge, "AlvrNativeBridge");

        broker.setReceiverWebView(receiverWebView);

        setContentView(receiverWebView);

        // Log the XR display's native resolution for diagnostics.
        Point size = new Point();
        getDisplay().getRealSize(size);
        Log.i(TAG, "XR display native resolution: " + size.x + "x" + size.y);

        receiverWebView.loadUrl("file:///android_asset/web_client/receiver.html");
    }

    @Override
    public void onStop() {
        super.onStop();
        broker.setReceiverWebView(null);
    }
}
