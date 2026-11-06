//! File access for the store and chats (port of disk.js): one folder, flat file names.
use anyhow::{Result, anyhow, bail};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// File access rooted at one folder, with flat file names. `read` gives None for a missing file; `write` is atomic and
/// owner-only; `remove` of a missing file is fine; `list` of a missing folder is empty.
#[derive(Clone, Debug)]
pub struct Disk {
    root: PathBuf,
}

impl Disk {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Disk { root: root.into() }
    }
    /// The full path of `name`, which must be a plain file name (no folders, no `..`, no `:` — on Windows `C:x` joined to the root escapes it).
    fn at(&self, name: &str) -> Result<PathBuf> {
        if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." {
            bail!("Invalid file name");
        }
        Ok(self.root.join(name))
    }
    pub fn read(&self, name: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.at(name)?) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    pub fn write(&self, name: &str, text: &str) -> Result<()> {
        let f = self.at(name)?;
        fs::create_dir_all(&self.root)?;
        // a unique temp name: two app instances saving the same file must not clobber each other's temp file
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd)?;
        let tmp = self.root.join(format!("{name}.{}.tmp", rnd.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        let mut o = fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        let r = (|| -> Result<()> {
            let mut h = o.open(&tmp)?;
            h.write_all(text.as_bytes())?;
            h.sync_all()?;
            drop(h);
            fs::rename(&tmp, &f)?; // a crash mid-write can't leave a half-written file
            Ok(())
        })();
        if r.is_err() {
            let _ = fs::remove_file(&tmp); // never leave the temp file behind on a failed save
        }
        r
    }
    pub fn remove(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.at(name)?) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
    /// When `name` was last written; None if it's missing or the platform can't tell.
    pub fn modified(&self, name: &str) -> Option<std::time::SystemTime> {
        fs::metadata(self.at(name).ok()?).ok()?.modified().ok()
    }
    pub fn list(&self) -> Result<Vec<String>> {
        match fs::read_dir(&self.root) {
            Ok(rd) => Ok(rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        Ok(fs::rename(self.at(from)?, self.at(to)?)?)
    }
}

/// Moves settings and chats from the old data folder (the app was named "chatbot" before the JAVC rename).
/// Each item moves on its own and is retried on every launch, so a move that was interrupted is finished later.
/// Nothing in `to` is ever overwritten: settings only move into a folder that has none, and chats are merged file by
/// file into an existing chats folder (the chat list adds files that aren't in its index). Returns what was moved.
pub fn migrate_legacy(from: &Path, to: &Path) -> Result<Vec<String>> {
    migrate_with(from, to, &|a, b| fs::rename(a, b))
}

fn migrate_with(from: &Path, to: &Path, rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> Result<Vec<String>> {
    let (mut moved, mut failed) = (vec![], vec![]);
    // Each move is tried on its own, so one item that can't move (a locked file, say) doesn't hold back the others.
    let mut mv = |name: String| {
        let dest = to.join(&name);
        let r = fs::create_dir_all(dest.parent().unwrap()).and_then(|_| rename(&from.join(&name), &dest));
        match r {
            Ok(()) => moved.push(name),
            Err(e) => failed.push(e.to_string()),
        }
    };
    for name in ["settings.json", "settings.json.bad"] {
        if from.join(name).exists() && !to.join(name).exists() {
            mv(name.into());
        }
    }
    if from.join("chats").exists() {
        if !to.join("chats").exists() {
            mv("chats".into());
        } else {
            for e in fs::read_dir(from.join("chats"))? {
                let n = e?.file_name().to_string_lossy().into_owned();
                if n.ends_with(".json") && n != "_index.json" && !to.join("chats").join(&n).exists() {
                    mv(Path::new("chats").join(&n).to_string_lossy().into_owned());
                }
            }
        }
    }
    if !failed.is_empty() {
        let done = if moved.is_empty() { "nothing".to_string() } else { moved.join(", ") };
        return Err(anyhow!("Moved {done}; {} item(s) will be retried next launch ({})", failed.len(), failed.join("; ")));
    }
    Ok(moved)
}

#[cfg(test)]
pub use tests::tmp;

#[cfg(test)]
mod tests {
    use super::*;

    pub fn tmp(tag: &str) -> PathBuf {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("javc-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn disk_basics() {
        let dir = tmp("disk");
        let d = Disk::new(dir.join("sub"));
        assert_eq!(d.read("nope.json").unwrap(), None);
        assert!(d.list().unwrap().is_empty()); // folder not created yet
        d.write("a.json", "x").unwrap();
        assert_eq!(d.read("a.json").unwrap().as_deref(), Some("x"));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(dir.join("sub/a.json")).unwrap().permissions()) & 0o777, 0o600);
        d.rename("a.json", "b.json").unwrap();
        assert_eq!(d.list().unwrap(), vec!["b.json"]);
        d.remove("b.json").unwrap();
        d.remove("b.json").unwrap(); // removing twice is fine
        for bad in ["../x", "a/b", "a\\b", "..", "", "C:x", "a:b"] {
            assert!(d.read(bad).unwrap_err().to_string().contains("Invalid file name"), "{bad}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_leave_no_temp_files() {
        let dir = tmp("disktmp");
        let d = Disk::new(&dir);
        d.write("a.json", "one").unwrap();
        d.write("a.json", "two").unwrap();
        d.write("b.json", "x").unwrap();
        assert_eq!(d.read("a.json").unwrap().as_deref(), Some("two"));
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrate_legacy_moves_once_never_overwrites() {
        let root = tmp("mig");
        let (from, to) = (root.join("chatbot"), root.join("javc-chatbot"));
        assert!(migrate_legacy(&from, &to).unwrap().is_empty());
        assert!(!to.exists());
        fs::create_dir_all(from.join("chats")).unwrap();
        fs::write(from.join("settings.json"), r#"{"old":1}"#).unwrap();
        fs::write(from.join("chats/a.json"), "{}").unwrap();
        fs::create_dir_all(to.join("Crashpad")).unwrap();
        assert_eq!(migrate_legacy(&from, &to).unwrap(), vec!["settings.json", "chats"]);
        assert_eq!(fs::read_to_string(to.join("settings.json")).unwrap(), r#"{"old":1}"#);
        assert!(to.join("chats/a.json").exists() && !from.join("settings.json").exists());
        fs::write(from.join("settings.json"), r#"{"stale":1}"#).unwrap();
        assert!(migrate_legacy(&from, &to).unwrap().is_empty());
        assert_eq!(fs::read_to_string(to.join("settings.json")).unwrap(), r#"{"old":1}"#);
        assert!(from.join("settings.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrate_legacy_interrupted_move_merges_chats() {
        let root = tmp("mig2");
        let (from, to) = (root.join("chatbot"), root.join("javc-chatbot"));
        fs::create_dir_all(from.join("chats")).unwrap();
        fs::create_dir_all(to.join("chats")).unwrap();
        fs::write(from.join("chats/a.json"), "old-a").unwrap();
        fs::write(from.join("chats/b.json"), "old-b").unwrap();
        fs::write(from.join("chats/_index.json"), "[]").unwrap();
        fs::write(to.join("chats/a.json"), "new-a").unwrap();
        assert_eq!(migrate_legacy(&from, &to).unwrap(), vec![Path::new("chats").join("b.json").to_string_lossy()]);
        assert_eq!(fs::read_to_string(to.join("chats/a.json")).unwrap(), "new-a");
        assert!(!to.join("chats/_index.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrate_legacy_failed_item_does_not_hold_back_others() {
        let root = tmp("mig3");
        let (from, to) = (root.join("chatbot"), root.join("javc-chatbot"));
        fs::create_dir_all(from.join("chats")).unwrap();
        fs::write(from.join("settings.json"), r#"{"old":1}"#).unwrap();
        fs::write(from.join("chats/a.json"), "{}").unwrap();
        let locked = |a: &Path, b: &Path| {
            if a.ends_with("settings.json") { Err(std::io::Error::other("EBUSY")) } else { fs::rename(a, b) }
        };
        let e = migrate_with(&from, &to, &locked).unwrap_err().to_string();
        assert!(e.contains("Moved chats"), "{e}");
        assert!(to.join("chats/a.json").exists());
        assert_eq!(migrate_legacy(&from, &to).unwrap(), vec!["settings.json"]);
        fs::remove_dir_all(root).unwrap();
    }
}
