//! What differs between the desktop and Android: where data lives, key encryption, the clipboard, links, the file
//! picker and the sandboxed preview window.
/// A picked file: its name and bytes.
pub type Picked = (String, Vec<u8>);

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
            let files = rfd::FileDialog::new().set_title("Attach files").pick_files().unwrap_or_default();
            done(files.into_iter().filter_map(|p| Some((p.file_name()?.to_string_lossy().into_owned(), std::fs::read(&p).ok()?))).collect());
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
        std::io::Write::write_all(&mut o.open(&f)?, serde_json::json!({ "doc": doc, "csp": csp }).to_string().as_bytes())?;
        std::process::Command::new(std::env::current_exe()?).arg("--preview").arg(&f).spawn()?;
        Ok(())
    }
    /// Android only: send the app to the background.
    pub fn minimize() {}
}
