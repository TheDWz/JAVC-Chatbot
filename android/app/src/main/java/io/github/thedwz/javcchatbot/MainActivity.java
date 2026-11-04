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

    /** Registers the app's native plugin; Capacitor then builds the WebView and loads the page. */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(JavcPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Loads the page, or asks for a WebView update when the WebView is too old. Without WEB_MESSAGE_LISTENER, Capacitor
     * falls back to a bridge that every frame can call, including the sandboxed frames that run model-written HTML, so
     * the app refuses to start rather than run that way. Then installs the sandbox host and the permission policy.
     */
    @Override
    protected void load() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || webViewMajor() < MIN_WEBVIEW) {
            askForWebViewUpdate();
            return;
        }
        super.load();

        // Rich replies are served from their own host with a sandbox CSP, like the desktop's chatbot-sandbox: scheme.
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                /** Serves the sandbox host's pages; everything else goes to Capacitor (the app's files) or the network. */
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (JavcPlugin.SANDBOX_HOST.equals(request.getUrl().getHost())) return JavcPlugin.serveSandbox(request.getUrl());
                    return super.shouldInterceptRequest(view, request);
                }

                /** Frames navigate inside themselves, as on the desktop; links in the app page open in the browser. */
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (!request.isForMainFrame()) return false;
                    return super.shouldOverrideUrlLoading(view, request);
                }
            }
        );

        // No camera, microphone, location or other permissions for page content, like the desktop.
        // Keeps Capacitor's file chooser, which the attach button needs.
        bridge
            .getWebView()
            .setWebChromeClient(
                new BridgeWebChromeClient(bridge) {
                    /** Page content gets no camera, microphone or other permissions. */
                    @Override
                    public void onPermissionRequest(PermissionRequest request) {
                        request.deny();
                    }

                    /** Page content gets no location. */
                    @Override
                    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                        callback.invoke(origin, false, false);
                    }
                }
            );
    }

    /** The major version of the active WebView provider: 0 when there is none, very large when the version can't be read. */
    private int webViewMajor() {
        PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
        if (p == null || p.versionName == null) return 0;
        try {
            return Integer.parseInt(p.versionName.split("\\.")[0]);
        } catch (NumberFormatException e) {
            return Integer.MAX_VALUE; // an unusual version format says nothing about its age; the feature check still applies
        }
    }

    /**
     * Explains that the WebView is too old and offers its Play Store page. That is the page of the provider the phone
     * actually uses (Chrome on many Android 8 and 9 phones, Android System WebView later), so updating it fixes the check.
     */
    private void askForWebViewUpdate() {
        PackageInfo p = WebViewCompat.getCurrentWebViewPackage(this);
        String pkg = p != null ? p.packageName : "com.google.android.webview";
        CharSequence name = "Android System WebView";
        if (p != null && p.applicationInfo != null) name = p.applicationInfo.loadLabel(getPackageManager());
        new AlertDialog.Builder(this)
            .setTitle("Update " + name)
            .setMessage("JAVC Chatbot needs a newer version of " + name + ", which shows its pages. Update it from the Play Store, then open the app again.")
            .setCancelable(false)
            .setPositiveButton("Open Play Store", (d, w) -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
                } catch (ActivityNotFoundException e) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + pkg)));
                }
                finish();
            })
            .setNegativeButton("Close", (d, w) -> finish())
            .show();
    }
}
