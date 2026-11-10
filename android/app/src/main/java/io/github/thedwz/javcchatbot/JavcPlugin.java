package io.github.thedwz.javcchatbot;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
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
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
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
    private final Set<String> stopped = ConcurrentHashMap.newKeySet(); // stop requested; read by the worker while it streams
    private final Set<String> active = new HashSet<>(); // started and not finished; guards `stopped` (both under this lock)

    /**
     * Starts an HTTP request on its own thread. The call resolves with {status, headers} once they arrive; the body then
     * follows as "http" events ({id, type: data|end|error}), data as base64. Options: id, url, method, headers, body (text).
     */
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
        synchronized (active) {
            active.add(id);
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
            } catch (Exception | OutOfMemoryError e) { // a huge chat can exhaust memory; report it instead of crashing
                String msg = e instanceof OutOfMemoryError ? "Not enough memory: this chat is too large to send on this phone" : message(e);
                if (answered) emit(id, "error", msg);
                else onMain(() -> call.reject(msg));
            } finally {
                requests.remove(id);
                synchronized (active) {
                    active.remove(id);
                    stopped.remove(id);
                }
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** Stops request `id`. A request that already finished is left alone, so nothing is remembered for it. */
    @PluginMethod
    public void httpAbort(PluginCall call) {
        String id = call.getString("id", "");
        synchronized (active) {
            if (active.contains(id)) stopped.add(id); // a request that hasn't connected yet sees this and doesn't start
        }
        HttpURLConnection conn = requests.remove(id);
        if (conn != null) http.execute(conn::disconnect); // disconnecting may wait on the network
        call.resolve();
    }

    /** Sends one "http" event for request `id`: data (base64), end, or error (with a message). */
    private void emit(String id, String type, String value) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("type", type);
        if (value != null) ev.put("data".equals(type) ? "data" : "message", value);
        onMain(() -> notifyListeners("http", ev));
    }

    /** Runs `r` on the main thread. Everything bound for the page goes this way, so events arrive in the order they were sent. */
    private void onMain(Runnable r) {
        getBridge().executeOnMainThread(r);
    }

    // ---- Files, inside the app's private storage only ----

    /** The file at `rel` inside the app's private files folder; anything that resolves outside it is refused. */
    private File fileAt(String rel) throws IOException {
        File base = getContext().getFilesDir().getCanonicalFile();
        File f = new File(base, rel == null ? "" : rel).getCanonicalFile();
        if (!f.equals(base) && !f.getPath().startsWith(base.getPath() + File.separator)) throw new IOException("Invalid file name");
        return f;
    }

    /** Reads a text file: {exists, text}. A missing file is {exists: false}, not an error. */
    @PluginMethod
    public void fsRead(PluginCall call) {
        try {
            File f = fileAt(call.getString("path"));
            JSObject r = new JSObject();
            r.put("exists", f.isFile());
            if (f.isFile()) r.put("text", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)); // one copy of the bytes, not two
            call.resolve(r);
        } catch (OutOfMemoryError e) {
            call.reject("Not enough memory: this chat is too large to open on this phone");
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Writes a text file atomically: to a .tmp file first, then renamed over the old one, so a crash can't leave half a file. */
    @PluginMethod
    public void fsWrite(PluginCall call) {
        try {
            File f = fileAt(call.getString("path"));
            File tmp = new File(f.getPath() + ".tmp");
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getName());
            try (FileOutputStream fos = new FileOutputStream(tmp); Writer w = new BufferedWriter(new OutputStreamWriter(fos, StandardCharsets.UTF_8), 65536)) {
                w.write(call.getString("text", "")); // encoded as it goes, instead of building the whole file as bytes first
                w.flush();
                fos.getFD().sync();
            }
            if (!tmp.renameTo(f)) throw new IOException("Could not save " + f.getName());
            call.resolve();
        } catch (OutOfMemoryError e) {
            call.reject("Not enough memory to save this chat on this phone");
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Deletes a file; a file that is already gone is fine. */
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

    /** The names in a folder: {names}; a missing folder gives an empty list. */
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

    /** Renames a file, replacing any file already at the new name. */
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

    /** The app's AES key in the Android Keystore, created on first use. */
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

    /** Encrypts `text` with a fresh IV; returns base64(iv | ciphertext). */
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

    /** Decrypts what encryptText produced; throws if the data was changed or the key is not the one it was made with. */
    private String decryptText(String data) throws Exception {
        byte[] all = Base64.decode(data, Base64.NO_WRAP);
        if (all.length <= IV_BYTES) throw new IllegalArgumentException("Not an encrypted key");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, all, 0, IV_BYTES));
        return new String(c.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
    }

    /** Whether the Keystore works on this device: {available}. Some devices have a broken one, so this is a real round trip. */
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

    /** Encrypts an API key: {text} in, {data} out. */
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

    /** Decrypts an API key: {data} in, {text} out. */
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
    private static final String SANDBOX_CSP = "sandbox allow-scripts"; // every page gets at least this; Lib.richDoc adds the CSS/JS-off rules
    private static final Map<String, String[]> docs = Collections.synchronizedMap( // id -> {html, csp}, least recently used first
        new LinkedHashMap<String, String[]>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, String[]> eldest) {
                return size() > 300;
            }
        }
    );

    /**
     * Stores a rich-reply page and its Content-Security-Policy ({html, csp}) and returns its URL ({url}). The policy must be
     * "sandbox allow-scripts", optionally followed by more rules, so every page runs in an opaque origin.
     */
    @PluginMethod
    public void sandboxCreate(PluginCall call) {
        String html = call.getString("html");
        String csp = call.getString("csp", SANDBOX_CSP);
        if (html == null || html.length() > SANDBOX_MAX) {
            call.reject("This content is too large to display");
            return;
        }
        boolean sandboxed = csp.equals(SANDBOX_CSP) || csp.startsWith(SANDBOX_CSP + "; ");
        if (!sandboxed || csp.indexOf('\r') >= 0 || csp.indexOf('\n') >= 0) {
            call.reject("Invalid sandbox policy");
            return;
        }
        String id;
        try { // the same page gets the same id, so re-renders reuse it instead of filling the store with copies
            id = String.format("%064x", new BigInteger(1, MessageDigest.getInstance("SHA-256").digest((csp + "\n" + html).getBytes(StandardCharsets.UTF_8))));
        } catch (Exception e) {
            call.reject(message(e));
            return;
        }
        docs.put(id, new String[] { html, csp });
        JSObject r = new JSObject();
        r.put("url", "https://" + SANDBOX_HOST + "/doc/" + id);
        call.resolve(r);
    }

    /** The response for a request to the sandbox host: the stored page with its policy, or a 404. Called by MainActivity's WebViewClient. */
    static WebResourceResponse serveSandbox(Uri url) {
        String path = url.getPath();
        String[] doc = path != null && path.startsWith("/doc/") ? docs.get(path.substring(5)) : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", doc != null ? doc[1] : SANDBOX_CSP);
        headers.put("Cache-Control", "no-store");
        if (doc == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
        return new WebResourceResponse("text/html", "utf-8", 200, "OK", headers, new ByteArrayInputStream(doc[0].getBytes(StandardCharsets.UTF_8)));
    }

    // ---- Clipboard ----

    /**
     * Saves {data} (text) to a file the user picks with the system's save screen, suggesting {name} with type {mime}.
     * Resolves {saved: false} if they cancel. Used for chat exports.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mime", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "export"));
        startActivityForResult(call, intent, "saveFileDone");
    }

    @ActivityCallback
    private void saveFileDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            JSObject r = new JSObject();
            r.put("saved", false);
            call.resolve(r);
            return;
        }
        String data = call.getString("data", "");
        http.execute(() -> { // off the main thread: an export with images can be many megabytes
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("Could not open the file");
                out.write(data.getBytes(StandardCharsets.UTF_8));
                JSObject r = new JSObject();
                r.put("saved", true);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Copies {text} to the clipboard. */
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

    // ---- Browser ----

    /** Opens {url} (http or https only) in the browser, for MCP sign-in pages. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("Only web addresses can be opened");
            return;
        }
        onMain(() -> {
            try {
                getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("There's no browser to open the sign-in page");
            }
        });
    }

    /** A readable message for an error, falling back to its type when it has none. */
    private static String message(Throwable e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }
}
