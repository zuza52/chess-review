package com.chessreview.app;

import android.app.Activity;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;

/**
 * Chess Review для Android.
 *
 * Интерфейс — тот же PWA-бандл, что и в браузере, но отдаётся встроенным
 * HTTP-сервером на 127.0.0.1. Это даёт «безопасный origin», без которого
 * не работают Web Worker + WASM (Stockfish) и service worker.
 */
public class MainActivity extends Activity {

    private WebView web;
    private AssetServer server;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(30, 28, 26));
        window.setNavigationBarColor(Color.rgb(30, 28, 26));

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(38, 36, 33));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient());
        setContentView(web);

        server = new AssetServer(getAssets());
        int port = -1;
        try {
            port = server.start();
        } catch (IOException ignored) {
        }

        if (port > 0) {
            web.loadUrl("http://127.0.0.1:" + port + "/index.html");
        } else {
            // запасной вариант: движок в таком режиме может не запуститься
            web.loadUrl("file:///android_asset/index.html");
        }
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
