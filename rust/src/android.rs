//! Android: the platform API of platform.rs, done by calling the app's Java activity (android/, MainActivity) over JNI.
//! The Java side holds what needs the Android framework: the Keystore key, the clipboard, the file picker, links, the
//! preview WebView and moving the app to the background.
use crate::core::store::Crypto;
use anyhow::{Result, anyhow};
use jni::objects::{JByteArray, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub use slint::android::AndroidApp;

pub const TOUCH: bool = true;

static APP: OnceLock<AndroidApp> = OnceLock::new();

/// Keeps the activity handle for the calls below; run first thing in android_main.
pub fn init(app: &AndroidApp) {
    let _ = APP.set(app.clone());
}
fn app() -> &'static AndroidApp {
    APP.get().expect("android::init")
}

/// Calls `f` with a JNI env for this thread and the activity. A Java exception becomes an error with its message.
fn call<T>(f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>) -> Result<T> {
    // SAFETY: both pointers come from android-activity and live as long as the process
    let vm = unsafe { JavaVM::from_raw(app().vm_as_ptr().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    // the UI thread stays attached for the app's life, so its local references would pile up without a frame per call
    env.with_local_frame(16, |env| -> Result<T> {
        let activity = unsafe { JObject::from_raw(app().activity_as_ptr().cast()) };
        match f(env, &activity) {
            Ok(v) => Ok(v),
            Err(jni::errors::Error::JavaException) => {
                let ex = env.exception_occurred()?;
                env.exception_clear()?;
                let msg = env.call_method(&ex, "getMessage", "()Ljava/lang/String;", &[]).and_then(|m| m.l()).ok();
                let msg = msg.filter(|m| !m.is_null()).and_then(|m| env.get_string(&JString::from(m)).ok().map(String::from));
                Err(anyhow!(msg.unwrap_or_else(|| "Android error".into())))
            }
            Err(e) => Err(e.into()),
        }
    })
}
/// activity.<name>(String) -> String
fn str_to_str(name: &str, arg: &str) -> Result<String> {
    call(|env, a| {
        let s = env.new_string(arg)?;
        let r = env.call_method(a, name, "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&s)])?.l()?;
        Ok(env.get_string(&JString::from(r))?.into())
    })
}
/// activity.<name>(String...) with no result
fn void(name: &str, sig: &str, args: &[&str]) -> Result<()> {
    call(|env, a| {
        let strs = args.iter().map(|s| env.new_string(s)).collect::<jni::errors::Result<Vec<_>>>()?;
        let vals: Vec<JValue> = strs.iter().map(|s| JValue::Object(s)).collect();
        env.call_method(a, name, sig, &vals)?;
        Ok(())
    })
}

/// The app's private files folder (getFilesDir), where the Capacitor app kept settings.json and chats/.
pub fn data_dir() -> PathBuf {
    app().internal_data_path().unwrap_or_else(|| PathBuf::from("."))
}
/// The old "chatbot" folder only existed on the desktop.
pub fn legacy_dir() -> Option<PathBuf> {
    None
}

/// API keys: AES-GCM with a key that never leaves the Android Keystore (alias javc-api-keys), stored as base64(iv | ciphertext),
/// exactly as the Capacitor app did, so its saved keys keep working.
struct Keystore;
impl Crypto for Keystore {
    fn available(&self) -> bool {
        static OK: OnceLock<bool> = OnceLock::new();
        // some devices have a broken Keystore; test it once with a real round trip
        *OK.get_or_init(|| self.enc("javc").and_then(|e| self.dec(&e)).is_ok_and(|t| t == "javc"))
    }
    fn enc(&self, text: &str) -> Result<String> {
        str_to_str("encryptKey", text)
    }
    fn dec(&self, data: &str) -> Result<String> {
        str_to_str("decryptKey", data)
    }
}
pub fn crypto() -> Box<dyn Crypto> {
    Box::new(Keystore)
}

pub fn copy_text(text: &str) -> Result<()> {
    void("copyText", "(Ljava/lang/String;)V", &[text])
}
/// Opens a link in the browser (only http, https and mailto get here).
pub fn open_url(url: &str) {
    if crate::markdown::safe_href(url) {
        let _ = void("openUrl", "(Ljava/lang/String;)V", &[url]);
    }
}

type Picked = super::platform::Picked;
static PICK: Mutex<Option<Box<dyn FnOnce(Vec<Picked>) + Send>>> = Mutex::new(None);
/// Shows the system file picker; `done` gets the chosen files (or none if cancelled), from MainActivity.filesPicked.
/// A request while the picker is already open is ignored (a double tap would open two pickers, and the second result
/// would find no callback).
pub fn pick_files(done: impl FnOnce(Vec<Picked>) + Send + 'static) {
    {
        let mut pick = PICK.lock().unwrap();
        if pick.is_some() {
            return;
        }
        *pick = Some(Box::new(done));
    }
    if void("pickFiles", "()V", &[]).is_err()
        && let Some(f) = PICK.lock().unwrap().take()
    {
        f(vec![]);
    }
}
static PICKED: Mutex<Vec<Picked>> = Mutex::new(vec![]);
/// MainActivity.filePicked(String name, byte[] data): one picked file, read on a Java worker thread. Files come one at a
/// time so Java never holds them all: a few large ones would exceed its heap.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_thedwz_javcchatbot_MainActivity_filePicked(mut env: JNIEnv, _this: JClass, name: JString, data: JByteArray) {
    let name: String = env.get_string(&name).map(Into::into).unwrap_or_default();
    let bytes = env.convert_byte_array(data).unwrap_or_default();
    PICKED.lock().unwrap().push((name, bytes));
}
/// MainActivity.filesPicked(): the picker is done; `done` gets the files sent so far (none if cancelled).
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_thedwz_javcchatbot_MainActivity_filesPicked(_env: JNIEnv, _this: JClass) {
    let files = std::mem::take(&mut *PICKED.lock().unwrap());
    if let Some(f) = PICK.lock().unwrap().take() {
        f(files);
    }
}

/// MainActivity.copyFailed(): the clipboard rejected the text copy_text sent.
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_thedwz_javcchatbot_MainActivity_copyFailed(_env: JNIEnv, _this: JClass) {
    crate::app::copy_failed();
}

/// Opens the rich-reply preview: RichActivity's WebView serves the page with its CSP, in an opaque sandboxed origin.
pub fn preview(doc: &str, csp: &str) -> Result<()> {
    void("openPreview", "(Ljava/lang/String;Ljava/lang/String;)V", &[doc, csp])
}
/// The back button with nothing open: send the app to the background, like the Capacitor app.
pub fn minimize() {
    let _ = void("minimize", "()V", &[]);
}

/// A line in logcat (tag "javc").
pub fn log(msg: &str) {
    let _ = void("log", "(Ljava/lang/String;)V", &[msg]);
}
/// The "selftest" intent extra of a debug build (null otherwise), e.g. `adb shell am start -n …/.MainActivity --es selftest 1`.
pub fn self_test_mode() -> Option<String> {
    call(|env, a| {
        let r = env.call_method(a, "selfTest", "()Ljava/lang/String;", &[])?.l()?;
        Ok(if r.is_null() { None } else { Some(env.get_string(&JString::from(r))?.into()) })
    })
    .ok()
    .flatten()
}
