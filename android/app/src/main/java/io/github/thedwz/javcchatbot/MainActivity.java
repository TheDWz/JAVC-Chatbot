package io.github.thedwz.javcchatbot;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    // The page needs a WebView from March 2024 or later (Chrome 123: CSS light-dark() for every colour, field-sizing for the message box).
    private static final int MIN_WEBVIEW = 123;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(JavcPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void load() {
        // Without WEB_MESSAGE_LISTENER, Capacitor falls back to a bridge that every frame can call, including the
        // sandboxed frames that run model-written HTML. Refuse to start rather than run that way.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || webViewMajor() < MIN_WEBVIEW) {
            askForWebViewUpdate();
            return;
        }
        super.load();

        // Rich replies are served from their own host with a sandbox CSP, like the desktop's chatbot-sandbox: scheme.
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (JavcPlugin.SANDBOX_HOST.equals(request.getUrl().getHost())) return JavcPlugin.serveSandbox(request.getUrl());
                    return super.shouldInterceptRequest(view, request);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (!request.isForMainFrame()) return false; // frames navigate inside themselves, as on the desktop
                    return super.shouldOverrideUrlLoading(view, request); // the app page itself: links open in the browser
                }
            }
        );

        // No camera, microphone, location or other permissions for page content, like the desktop.
        // Keeps Capacitor's file chooser, which the attach button needs.
        bridge
            .getWebView()
            .setWebChromeClient(
                new BridgeWebChromeClient(bridge) {
                    @Override
                    public void onPermissionRequest(PermissionRequest request) {
                        request.deny();
                    }

                    @Override
                    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                        callback.invoke(origin, false, false);
                    }
                }
            );
    }

    private int webViewMajor() {
        PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
        if (p == null || p.versionName == null) return 0;
        try {
            return Integer.parseInt(p.versionName.split("\\.")[0]);
        } catch (NumberFormatException e) {
            return Integer.MAX_VALUE; // an unusual version format says nothing about its age; the feature check still applies
        }
    }

    private void askForWebViewUpdate() {
        new AlertDialog.Builder(this)
            .setTitle("Update Android System WebView")
            .setMessage("JAVC Chatbot needs a newer Android System WebView. Update it from the Play Store, then open the app again.")
            .setCancelable(false)
            .setPositiveButton("Open Play Store", (d, w) -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.webview")));
                } catch (ActivityNotFoundException e) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")));
                }
                finish();
            })
            .setNegativeButton("Close", (d, w) -> finish())
            .show();
    }
}
