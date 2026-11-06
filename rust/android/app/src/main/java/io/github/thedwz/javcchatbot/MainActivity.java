package io.github.thedwz.javcchatbot;

import android.app.NativeActivity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The app's only Activity; its UI is a Slint window rendered by the Rust library (javc) over
 * android.app.NativeActivity. The Rust code calls the methods below over JNI; the static initializer
 * loads libjavc.so, which exports the native method filesPicked by name.
 */
public class MainActivity extends NativeActivity {

    static {
        System.loadLibrary("javc");
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

    /** Encrypts an API key for storage, using the Android Keystore key that never leaves the hardware. */
    public String encryptKey(String text) throws Exception {
        return encryptText(text);
    }

    /** Decrypts an API key stored by encryptKey; throws if the stored data was changed. */
    public String decryptKey(String data) throws Exception {
        return decryptText(data);
    }

    // ---- Clipboard ----

    /** Copies `text` to the system clipboard, on the UI thread as ClipboardManager requires. */
    public void copyText(String text) {
        runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("JAVC Chatbot", text));
        });
    }

    // ---- Links ----

    /** Opens `url` in the user's browser or mail app; anything that isn't http/https/mailto is ignored. */
    public void openUrl(String url) {
        if (url == null) return;
        if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("mailto:")) return;
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (ActivityNotFoundException e) {
                // no handler for the link; ignore it, like a browser would
            }
        });
    }

    // ---- File picker: the only way to read files, since the Slint UI has no system dialogs ----

    private static final int PICK_FILES = 42;
    private static final int MAX_FILE_BYTES = 25 * 1024 * 1024; // the Rust side rejects anything bigger
    private final ExecutorService pickerExecutor = Executors.newSingleThreadExecutor();

    /** Opens the system document picker, allowing multiple files. The result arrives in onActivityResult. */
    public void pickFiles() {
        runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(i, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                filesPicked(new String[0], new byte[0][]);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    uris.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        if (uris.isEmpty()) {
            filesPicked(new String[0], new byte[0][]);
            return;
        }
        pickerExecutor.execute(() -> {
            List<String> names = new ArrayList<>();
            List<byte[]> contents = new ArrayList<>();
            for (Uri uri : uris) {
                byte[] bytes = readFileUpTo(uri, MAX_FILE_BYTES + 1); // one extra byte tells the Rust side it's too big
                if (bytes == null) continue; // a file that can't be opened is skipped
                names.add(displayName(uri));
                contents.add(bytes);
            }
            filesPicked(names.toArray(new String[0]), contents.toArray(new byte[0][]));
        });
    }

    /** Reads `uri` into memory, stopping after `limit` bytes (so a huge file can't exhaust memory). Null when unreadable. */
    private byte[] readFileUpTo(Uri uri, int limit) {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; out.size() < limit && (n = in.read(buf)) != -1; ) {
                out.write(buf, 0, Math.min(n, limit - out.size()));
            }
            return out.toByteArray();
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    /** The file's name from the document provider, or its last path segment, or "file". */
    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int col = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (col >= 0 && !c.isNull(col)) {
                    String name = c.getString(col);
                    if (name != null) return name;
                }
            }
        } catch (Exception e) {
            // fall back to the path below
        }
        String path = uri.getLastPathSegment();
        return path != null ? path : "file";
    }

    /** The file picker's answer: the picked files' names and their (possibly truncated) contents. */
    private static native void filesPicked(String[] names, byte[][] data);

    // ---- Rich-reply preview ----

    /** Opens the model-written page `doc` in the sandboxed preview, with the Content-Security-Policy `csp`. */
    public void openPreview(String doc, String csp) {
        String id = RichActivity.put(doc, csp); // Intent extras can't carry a 2 MB page, so it goes through a static map
        Intent i = new Intent(this, RichActivity.class);
        i.putExtra("id", id);
        startActivity(i);
    }

    // ---- Window ----

    /** Hides the app, like the desktop's close button: the task stays in recents with its state. */
    public void minimize() {
        runOnUiThread(() -> moveTaskToBack(true));
    }

    // ---- Logging and diagnostics ----

    /** The Rust side's log output, for adb logcat. */
    public void log(String msg) {
        Log.i("javc", msg);
    }

    /** The self-test selection from the launch intent (only in debuggable builds), or null. */
    public String selfTest() {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) return null;
        return getIntent().getStringExtra("selftest");
    }
}
