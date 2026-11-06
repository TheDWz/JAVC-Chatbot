//! What differs between the desktop and Android: where data lives, key encryption, the clipboard, links, the file
//! picker and the sandboxed preview window.
/// A picked file: its name and bytes.
pub type Picked = (String, Vec<u8>);

/// Reads at most this much of a file: one byte past the 25 MB attachment limit, so the limit check still fires without
/// a huge file being loaded (the Android picker's rule).
const READ_CAP: u64 = 25 * 1024 * 1024 + 1;
/// The names and (capped) bytes of up to MAX_FILES + 1 files; one extra so the "max files" note still shows. Unreadable
/// files are skipped.
pub fn read_files(paths: Vec<std::path::PathBuf>) -> Vec<Picked> {
    use std::io::Read;
    let read = |p: &std::path::Path| -> Option<Picked> {
        let mut bytes = vec![];
        std::fs::File::open(p).ok()?.take(READ_CAP).read_to_end(&mut bytes).ok()?;
        Some((p.file_name()?.to_string_lossy().into_owned(), bytes))
    };
    paths.iter().filter_map(|p| read(p)).take(crate::attach::MAX_FILES + 1).collect()
}

#[cfg(not(target_os = "android"))]
pub use desktop::*;
#[cfg(target_os = "android")]
pub use crate::android::*;

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::*;
    use crate::core::store::Crypto;
    use std::path::PathBuf;
    use std::sync::Mutex;

    pub const TOUCH: bool = false;

    /// ~/.config/javc-chatbot on Linux, %APPDATA%\javc-chatbot on Windows: where the Electron app kept its data.
    pub fn data_dir() -> PathBuf {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("javc-chatbot")
    }
    /// The folder of the app before the JAVC rename.
    pub fn legacy_dir() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("chatbot"))
    }
    pub fn crypto() -> Box<dyn Crypto> {
        Box::new(crate::crypto::Keyring::default())
    }

    // The clipboard is kept open: on X11 and Wayland the copied text lives only as long as its owner.
    static CLIP: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
    pub fn copy_text(text: &str) -> anyhow::Result<()> {
        let mut c = CLIP.lock().unwrap();
        if c.is_none() {
            *c = Some(arboard::Clipboard::new()?);
        }
        Ok(c.as_mut().unwrap().set_text(text)?)
    }
    /// Opens a link in the system browser (only http, https and mailto get here).
    pub fn open_url(url: &str) {
        if crate::markdown::safe_href(url) {
            let _ = open::that_detached(url);
        }
    }
    /// Asks for files and hands their names and bytes to `done` (on a worker thread).
    pub fn pick_files(done: impl FnOnce(Vec<Picked>) + Send + 'static) {
        std::thread::spawn(move || {
            done(read_files(rfd::FileDialog::new().set_title("Attach files").pick_files().unwrap_or_default()));
        });
    }
    /// Opens the sandboxed preview window: this program again with `--preview`, so the webview has its own process.
    pub fn preview(doc: &str, csp: &str) -> anyhow::Result<()> {
        let mut name = [0u8; 8];
        getrandom::fill(&mut name)?;
        let f = std::env::temp_dir().join(format!("javc-preview-{}.json", name.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        let mut h = o.open(&f)?;
        let started = (|| -> anyhow::Result<std::process::Child> {
            std::io::Write::write_all(&mut h, serde_json::json!({ "doc": doc, "csp": csp }).to_string().as_bytes())?;
            drop(h);
            Ok(std::process::Command::new(std::env::current_exe()?).arg("--preview").arg(&f).spawn()?)
        })();
        match started {
            Ok(mut child) => {
                std::thread::spawn(move || child.wait()); // reap it when the window closes (no zombie per preview)
                Ok(()) // the preview process deletes the file once it has read it
            }
            Err(e) => {
                let _ = std::fs::remove_file(&f);
                Err(e)
            }
        }
    }
    /// Android only: send the app to the background.
    pub fn minimize() {}
}
