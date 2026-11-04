package io.github.thedwz.javcchatbot;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.TextUtils;
import android.util.Base64;
import android.webkit.WebResourceResponse;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * What the page can't do on its own inside a WebView (mobile/native.js is the JavaScript side):
 * HTTP with a streamed body and no CORS, private files, Keystore-encrypted API keys, the rich-reply sandbox and the clipboard.
 * Capacitor only accepts calls from the app's own page (main frame, app origin), never from the sandboxed frames.
 */
@CapacitorPlugin(name = "Javc")
public class JavcPlugin extends Plugin {

    // ---- HTTP: resolves with {status, headers} as soon as they arrive, then streams the body as "http" events ----

    private final ExecutorService http = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private final Set<String> stopped = ConcurrentHashMap.newKeySet();

    @PluginMethod
    public void httpStart(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String body = call.getString("body");
        if (id == null || url == null) {
            call.reject("Missing request id or URL");
            return;
        }
        http.execute(() -> {
            HttpURLConnection conn = null;
            boolean answered = false;
            try {
                URL u = new URL(url);
                if (!"http".equals(u.getProtocol()) && !"https".equals(u.getProtocol())) throw new IOException("Only http and https URLs are supported");
                conn = (HttpURLConnection) u.openConnection();
                requests.put(id, conn);
                if (stopped.contains(id)) throw new IOException("Stopped");
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(300_000); // the same 5 minutes Node's fetch waits on the desktop
                conn.setUseCaches(false);
                conn.setRequestMethod(method);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    conn.setRequestProperty(k, headers.getString(k));
                }
                if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(bytes);
                    }
                }
                int status = conn.getResponseCode();
                JSObject h = new JSObject();
                for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) h.put(e.getKey().toLowerCase(Locale.ROOT), TextUtils.join(", ", e.getValue()));
                }
                JSObject head = new JSObject();
                head.put("status", status);
                head.put("headers", h);
                answered = true;
                onMain(() -> call.resolve(head));

                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in != null) {
                    try (InputStream s = in) {
                        byte[] buf = new byte[16384];
                        for (int n; (n = s.read(buf)) != -1 && !stopped.contains(id); ) {
                            if (n > 0) emit(id, "data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                        }
                    }
                }
                emit(id, "end", null);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                if (answered) emit(id, "error", msg);
                else onMain(() -> call.reject(msg));
            } finally {
                requests.remove(id);
                stopped.remove(id);
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void httpAbort(PluginCall call) {
        String id = call.getString("id", "");
        stopped.add(id);
        HttpURLConnection conn = requests.remove(id);
        if (conn != null) http.execute(conn::disconnect); // disconnecting may wait on the network
        call.resolve();
    }

    private void emit(String id, String type, String value) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("type", type);
        if (value != null) ev.put("data".equals(type) ? "data" : "message", value);
        onMain(() -> notifyListeners("http", ev));
    }

    // Everything bound for the page goes through the main thread, so events arrive in the order they were sent.
    private void onMain(Runnable r) {
        getBridge().executeOnMainThread(r);
    }

    // ---- Files, inside the app's private storage only ----

    private File fileAt(String rel) throws IOException {
        File base = getContext().getFilesDir().getCanonicalFile();
        File f = new File(base, rel == null ? "" : rel).getCanonicalFile();
        if (!f.equals(base) && !f.getPath().startsWith(base.getPath() + File.separator)) throw new IOException("Invalid file name");
        return f;
    }

    @PluginMethod
    public void fsRead(PluginCall call) {
        try {
            File f = fileAt(call.getString("path"));
            JSObject r = new JSObject();
            r.put("exists", f.isFile());
            if (f.isFile()) {
                try (InputStream in = new FileInputStream(f)) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(f.length(), Integer.MAX_VALUE));
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
                    r.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
                }
            }
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void fsWrite(PluginCall call) {
        try {
            File f = fileAt(call.getString("path"));
            File tmp = new File(f.getPath() + ".tmp");
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getName());
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) throw new IOException("Could not save " + f.getName()); // a crash mid-write can't leave a half-written file
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void fsRemove(PluginCall call) {
        try {
            File f = fileAt(call.getString("path"));
            if (f.exists() && !f.delete()) throw new IOException("Could not delete " + f.getName());
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void fsList(PluginCall call) {
        try {
            String[] names = fileAt(call.getString("path", "")).list();
            JSObject r = new JSObject();
            r.put("names", new JSArray(Arrays.asList(names == null ? new String[0] : names)));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void fsRename(PluginCall call) {
        try {
            File from = fileAt(call.getString("from")), to = fileAt(call.getString("to"));
            if (!from.renameTo(to)) throw new IOException("Could not rename " + from.getName());
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    // ---- API keys: AES-GCM with a key that never leaves the Android Keystore; stored as base64(iv | ciphertext) ----

    private static final String KEY_ALIAS = "javc-api-keys";
    private static final int IV_BYTES = 12;

    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(KEY_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return g.generateKey();
    }

    private String encryptText(String text) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] iv = c.getIV(), ct = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
        if (iv.length != IV_BYTES) throw new IllegalStateException("Unexpected IV length");
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private String decryptText(String data) throws Exception {
        byte[] all = Base64.decode(data, Base64.NO_WRAP);
        if (all.length <= IV_BYTES) throw new IllegalArgumentException("Not an encrypted key");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, all, 0, IV_BYTES));
        return new String(c.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void cryptoAvailable(PluginCall call) {
        boolean ok;
        try {
            ok = "javc".equals(decryptText(encryptText("javc"))); // some devices have a broken Keystore; test it once
        } catch (Exception e) {
            ok = false;
        }
        JSObject r = new JSObject();
        r.put("available", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("data", encryptText(call.getString("text", "")));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("text", decryptText(call.getString("data", "")));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    // ---- Rich replies: model-written pages served from their own host, in an opaque sandboxed origin (like the desktop) ----

    static final String SANDBOX_HOST = "javc-sandbox.invalid"; // must match SANDBOX in mobile/build.mjs
    private static final int SANDBOX_MAX = 2_100_000; // the page limits the model's HTML to 2,000,000 characters
    private static final Map<String, String> docs = Collections.synchronizedMap(
        new LinkedHashMap<String, String>(16, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
                return size() > 300;
            }
        }
    );

    @PluginMethod
    public void sandboxCreate(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.length() > SANDBOX_MAX) {
            call.reject("This content is too large to display");
            return;
        }
        String id = UUID.randomUUID().toString();
        docs.put(id, html);
        JSObject r = new JSObject();
        r.put("url", "https://" + SANDBOX_HOST + "/doc/" + id);
        call.resolve(r);
    }

    static WebResourceResponse serveSandbox(Uri url) {
        String path = url.getPath();
        String doc = path != null && path.startsWith("/doc/") ? docs.get(path.substring(5)) : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", "sandbox allow-scripts");
        headers.put("Cache-Control", "no-store");
        if (doc == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers, new ByteArrayInputStream(doc.getBytes(StandardCharsets.UTF_8)));
    }

    // ---- Clipboard ----

    @PluginMethod
    public void copyText(PluginCall call) {
        String text = call.getString("text", "");
        onMain(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("JAVC Chatbot", text));
                call.resolve();
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    private static String message(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }
}
