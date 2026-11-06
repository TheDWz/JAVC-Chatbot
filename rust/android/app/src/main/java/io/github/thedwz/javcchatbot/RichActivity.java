package io.github.thedwz.javcchatbot;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.webkit.WebChromeClient;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * The rich-reply preview: a WebView showing one model-written page, served from the app in an opaque
 * sandboxed origin (the "sandbox allow-scripts" Content-Security-Policy), like the desktop's preview
 * window. Pages never navigate away; links open in the user's browser. No permissions for page content.
 */
public class RichActivity extends Activity {

    static final String SANDBOX_HOST = "javc-sandbox.invalid";
    private static final int SANDBOX_MAX = 2_100_000; // the page limits the model's HTML to 2,000,000 characters
    private static final String SANDBOX_CSP = "sandbox allow-scripts"; // every page gets at least this
    private static final String ID_EXTRA = "id";

    /** id -> {doc, csp}, with at most 300 pages remembered (the newest ones). */
    private static final Map<String, String[]> docs = Collections.synchronizedMap(
        new LinkedHashMap<String, String[]>(16, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, String[]> eldest) {
                return size() > 300;
            }
        }
    );

    /**
     * Stores a page and its Content-Security-Policy under a random UUID and returns the id.
     * The policy must be "sandbox allow-scripts", optionally followed by more rules.
     */
    static String put(String doc, String csp) {
        if (doc == null || doc.length() > SANDBOX_MAX) throw new IllegalArgumentException("This content is too large to display");
        boolean sandboxed = csp.equals(SANDBOX_CSP) || csp.startsWith(SANDBOX_CSP + "; ");
        if (!sandboxed || csp.indexOf('\r') >= 0 || csp.indexOf('\n') >= 0) throw new IllegalArgumentException("Invalid sandbox policy");
        String id = UUID.randomUUID().toString();
        docs.put(id, new String[] { doc, csp });
        return id;
    }

    private WebView web;

    /** Creates the full-screen WebView and loads the stored page from the sandbox host. */
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        requestWindowFeature(Window.FEATURE_NO_TITLE); // the page gets the whole screen; Back closes it
        super.onCreate(savedInstanceState);
        String id = getIntent().getStringExtra(ID_EXTRA);
        if (id == null || !docs.containsKey(id)) {
            finish();
            return;
        }

        web = new WebView(this);
        FrameLayout frame = new FrameLayout(this);
        frame.addView(web);
        // Android 15+ draws apps edge to edge: keep the page clear of the status and navigation bars
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(b.left, b.top, b.right, b.bottom);
            }
            return insets;
        });
        setContentView(frame);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);

        web.setWebViewClient(
            new WebViewClient() {
                /** Serves the sandbox host's pages from the static map; everything else goes to the network. */
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (!SANDBOX_HOST.equals(request.getUrl().getHost())) return null;
                    return serve(request.getUrl());
                }

                /** The preview never navigates away: sandbox URLs load, everything else opens in the user's browser. */
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (!request.isForMainFrame()) return false;
                    Uri url = request.getUrl();
                    if (SANDBOX_HOST.equals(url.getHost())) return false;
                    String s = url.toString();
                    if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("mailto:")) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, url));
                        } catch (ActivityNotFoundException e) {
                            // no handler for the link; ignore it
                        }
                    }
                    return true;
                }
            }
        );

        // No camera, microphone, location or other permissions for page content.
        web.setWebChromeClient(
            new WebChromeClient() {
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

        web.loadUrl("https://" + SANDBOX_HOST + "/doc/" + id);
    }

    /** The response for a request to the sandbox host: the stored page with its policy, or a 404. */
    private static WebResourceResponse serve(Uri url) {
        String path = url.getPath();
        String[] doc = path != null && path.startsWith("/doc/") ? docs.get(path.substring(5)) : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", doc != null ? doc[1] : SANDBOX_CSP);
        headers.put("Cache-Control", "no-store");
        if (doc == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers, new ByteArrayInputStream(doc[0].getBytes(StandardCharsets.UTF_8)));
    }

    /** Destroys the WebView so its renderer and memory go away with the preview. */
    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
