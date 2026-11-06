//! Settings + profiles on disk (port of store.js). File access and key encryption are injected, so the same code runs on
//! the desktop (OS keyring), on Android (Keystore) and in the tests.
use super::api::thinking_switch;
use super::disk::Disk;
use super::profiles::{self, has_key};
use super::shared::{RENDER_KEYS, clean_theme, s};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::sync::Mutex;

const FILE: &str = "settings.json";

/// Key encryption: `available()` says whether a keyring works; `enc` gives base64; `dec` fails when it can't decrypt.
pub trait Crypto: Send + Sync {
    fn available(&self) -> bool;
    fn enc(&self, text: &str) -> Result<String>;
    fn dec(&self, data: &str) -> Result<String>;
}

/// The flat view of the active profile used by chat and model fetching.
#[derive(Debug, Clone, PartialEq)]
pub struct Active {
    pub endpoint: String,
    pub model: String,
    pub effort: String,
    pub format: String,
    pub meta: bool,
    pub key: String,
    /// The Linkup key, when search was asked for, is on and has a key.
    pub search: Option<String>,
}

pub struct Store {
    io: Disk,
    crypto: Box<dyn Crypto>,
    notice: Mutex<String>,
    // One operation at a time, so two quick changes can never read the same old file and overwrite each other.
    lock: Mutex<()>,
}

/// The stored endpoint of profile `id`, when it exists.
fn st_endpoint(st: &Value, id: &str) -> Option<String> {
    st["profiles"].as_array().unwrap().iter().find(|p| s(p, "id") == id).map(|p| s(p, "endpoint").to_string())
}

impl Store {
    pub fn new(io: Disk, crypto: Box<dyn Crypto>) -> Self {
        Store { io, crypto, notice: Mutex::new(String::new()), lock: Mutex::new(()) }
    }
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Key fields for a profile: encrypted when a keyring is available, otherwise kept as-is (the file is still private to the user).
    fn enc_key(&self, key: &str) -> Result<Value> {
        Ok(if self.crypto.available() { json!({ "keyEnc": self.crypto.enc(key)? }) } else { json!({ "keyPlain": key }) })
    }
    fn write(&self, st: &Value) -> Result<()> {
        self.io.write(FILE, &serde_json::to_string_pretty(st)?)
    }
    /// Moves a damaged settings file aside under the first free name (settings.json.bad, .bad-2, …), so no earlier copy is overwritten.
    fn quarantine(&self) -> Result<()> {
        let names = self.io.list()?;
        let mut bad = format!("{FILE}.bad");
        let mut i = 2;
        while names.contains(&bad) {
            bad = format!("{FILE}.bad-{i}");
            i += 1;
        }
        self.io.rename(FILE, &bad)?;
        *self.notice.lock().unwrap() = format!("Your settings file was damaged. A copy was kept as {bad}, so profiles and keys need to be set up again.");
        Ok(())
    }
    /// Reads the settings, migrating older formats. A file that can't be parsed is quarantined; a read error propagates and
    /// leaves the file alone. A missing file is not written back, so a first run leaves no settings.json until something is saved.
    fn read(&self) -> Result<Value> {
        let text = self.io.read(FILE)?;
        let mut raw = json!({});
        if let Some(t) = &text {
            match serde_json::from_str::<Value>(t) {
                Ok(Value::Null) => {}
                Ok(v) => raw = v,
                Err(_) => self.quarantine()?, // damaged file: keep it for recovery instead of treating this as a first run and overwriting it
            }
        }
        let mut st = profiles::migrate(&raw);
        let mut changed = text.is_some() && raw.get("version").and_then(Value::as_i64) != Some(2); // persist a migrated file right away so profile ids stay stable
        if self.crypto.available() {
            // upgrade leftover plaintext keys now that a keyring is available
            let n = st["profiles"].as_array().map_or(0, Vec::len);
            let mut targets: Vec<String> = (0..n).map(|i| format!("/profiles/{i}")).collect();
            targets.push("/search".into());
            for t in targets {
                let p = st.pointer_mut(&t).unwrap();
                let plain = s(p, "keyPlain").to_string();
                if !plain.is_empty() {
                    let enc = self.enc_key(&plain)?;
                    let o = p.as_object_mut().unwrap();
                    o.extend(enc.as_object().unwrap().clone());
                    o.remove("keyPlain");
                    changed = true;
                }
            }
        }
        if changed {
            self.write(&st)?;
        }
        Ok(st)
    }
    /// The decrypted key of a stored profile (or the search key), or a clear error when the keyring can't decrypt it.
    fn key_of(&self, p: &Value, what: &str) -> Result<String> {
        let enc = s(p, "keyEnc");
        if !enc.is_empty() {
            return self.crypto.dec(enc).map_err(|_| {
                anyhow!("Couldn't read the saved {what} (the system keyring may be locked or changed). Type the key again and save.")
            });
        }
        Ok(s(p, "keyPlain").to_string())
    }
    fn with_flags(st: &Value) -> Value {
        let mut v = profiles::public_view(st);
        for p in v["profiles"].as_array_mut().unwrap() {
            p["thinkingSwitch"] = thinking_switch(s(p, "endpoint")).into();
        }
        v
    }
    fn commit(&self, st: &Value) -> Result<Value> {
        self.write(st)?;
        Ok(Self::with_flags(st))
    }

    /// The one-time message about a damaged settings file, if there is one; cleared once taken.
    pub fn take_notice(&self) -> String {
        std::mem::take(&mut *self.notice.lock().unwrap())
    }
    pub fn get(&self) -> Result<Value> {
        let _g = self.guard();
        Ok(Self::with_flags(&self.read()?))
    }
    /// Flat view of the active profile. The search key is only decrypted when the caller will search, so a locked keyring
    /// can't break model refresh or chats without search.
    pub fn load(&self, profile: Option<&str>, want_search: bool) -> Result<Active> {
        let _g = self.guard();
        let st = self.read()?;
        let id = profile.unwrap_or(s(&st, "activeId"));
        let Some(p) = st["profiles"].as_array().unwrap().iter().find(|x| s(x, "id") == id) else {
            bail!(if profile.is_some() { "This profile no longer exists" } else { "No profile yet. Use the new-profile button to add one." })
        };
        let search = if want_search && st["search"]["enabled"] == true && has_key(&st["search"]) {
            Some(self.key_of(&st["search"], "search key")?)
        } else {
            None
        };
        let fmt = s(p, "format");
        Ok(Active {
            endpoint: s(p, "endpoint").into(),
            model: s(p, "model").into(),
            effort: s(&st, "effort").into(),
            format: if fmt.is_empty() { "auto".into() } else { fmt.into() },
            meta: p.get("meta") == Some(&Value::Bool(true)),
            key: self.key_of(p, "API key")?,
            search,
        })
    }
    /// The Linkup API key, or "" when none is saved.
    pub fn search_key(&self) -> Result<String> {
        let _g = self.guard();
        self.key_of(&self.read()?["search"], "search key")
    }
    /// Saves web search settings. `key: None` keeps the stored key; `Some("")` clears it.
    pub fn save_search(&self, enabled: Option<bool>, key: Option<&str>) -> Result<Value> {
        let _g = self.guard();
        let mut st = self.read()?;
        if let Some(e) = enabled {
            st["search"]["enabled"] = e.into();
        }
        if let Some(k) = key {
            let o = st["search"].as_object_mut().unwrap();
            o.remove("keyEnc");
            o.remove("keyPlain");
            if !k.trim().is_empty() {
                let enc = self.enc_key(k.trim())?;
                st["search"].as_object_mut().unwrap().extend(enc.as_object().unwrap().clone());
            }
        }
        self.commit(&st)
    }
    /// The API key of profile `id`, or "" for an unknown profile.
    pub fn key(&self, id: &str) -> Result<String> {
        let _g = self.guard();
        let st = self.read()?;
        match st["profiles"].as_array().unwrap().iter().find(|x| s(x, "id") == id) {
            Some(p) => self.key_of(p, "API key"),
            None => Ok(String::new()),
        }
    }
    /// Applies a partial change: {effort, personaId, render, theme} are global; {model, meta, noTools} belong to a profile —
    /// the one named by profileId when it exists, else the active one. Invalid values are ignored.
    pub fn patch(&self, patch: &Value) -> Result<Value> {
        let _g = self.guard();
        let mut st = self.read()?;
        if let Some(pid) = patch.get("personaId").and_then(Value::as_str)
            && st["personas"].as_array().unwrap().iter().any(|p| s(p, "id") == pid)
        {
            st["personaId"] = pid.into();
        }
        if let Some(e) = patch.get("effort").and_then(Value::as_str) {
            st["effort"] = e.into();
        }
        if let Some(r) = patch.get("render").filter(|v| v.is_object()) {
            for k in RENDER_KEYS {
                if let Some(b) = r.get(k).and_then(Value::as_bool) {
                    st["render"][k] = b.into();
                }
            }
        }
        if let Some(t) = clean_theme(patch.get("theme")) {
            st["theme"] = t;
        }
        let mut own = json!({});
        if let Some(m) = patch.get("model").and_then(Value::as_str) {
            own["model"] = m.into();
        }
        if let Some(b) = patch.get("meta").and_then(Value::as_bool) {
            own["meta"] = b.into();
        }
        if let Some(b) = patch.get("noTools").and_then(Value::as_bool) {
            own["noTools"] = b.into(); // whether the profile's current model is known to lack tool support
        }
        // an unknown profileId drops the profile changes rather than inventing a profile
        let dest = match patch.get("profileId").and_then(Value::as_str) {
            Some(pid) if st["profiles"].as_array().unwrap().iter().any(|p| s(p, "id") == pid) => Some(pid.to_string()),
            Some(_) => None,
            None => (!s(&st, "activeId").is_empty()).then(|| s(&st, "activeId").to_string()),
        };
        if !own.as_object().unwrap().is_empty()
            && let Some(pid) = dest
        {
            own["id"] = pid.into();
            st = profiles::upsert(&st, &own); // never create a profile from a patch
        }
        self.commit(&st)
    }
    /// Creates or updates a profile. `key: None` keeps the stored key; `Some("")` clears it.
    pub fn save_profile(&self, id: Option<&str>, name: &str, endpoint: &str, format: &str, key: Option<&str>) -> Result<Value> {
        let _g = self.guard();
        let url = url::Url::parse(endpoint.trim()).map_err(|_| anyhow!("Endpoint must be a valid URL"))?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("Endpoint must start with http:// or https://");
        }
        let host = url.host_str().map(|h| url.port().map_or(h.to_string(), |p| format!("{h}:{p}"))).unwrap_or_default();
        let name = if name.trim().is_empty() { host } else { name.trim().to_string() };
        let new_ep = url.as_str().trim_end_matches('/');
        let mut upd = json!({ "name": name, "endpoint": new_ep, "format": if format.is_empty() { "auto" } else { format } });
        let st = self.read()?;
        if let Some(id) = id {
            upd["id"] = id.into();
            // the model-list discovery flags belong to the old endpoint, so a move forgets them
            if st_endpoint(&st, id).is_some_and(|old| old.trim_end_matches('/') != new_ep) {
                upd["meta"] = false.into();
                upd["noTools"] = false.into();
            }
        }
        if let Some(k) = key {
            let kv = if k.trim().is_empty() { json!({ "keyEnc": "" }) } else { self.enc_key(k.trim())? };
            upd.as_object_mut().unwrap().extend(kv.as_object().unwrap().clone());
        }
        let st = profiles::upsert(&st, &upd);
        self.commit(&st)
    }
    /// Creates or updates a persona and makes it the selected one.
    pub fn save_persona(&self, id: Option<&str>, name: &str, user: &str, bot: &str, prompt: &str) -> Result<Value> {
        let _g = self.guard();
        let mut st = self.read()?;
        let (user, bot, prompt) = (user.trim(), bot.trim(), prompt.trim());
        let name = [name.trim(), bot].into_iter().find(|x| !x.is_empty()).unwrap_or("Persona");
        let personas = st["personas"].as_array_mut().unwrap();
        let id = match id.filter(|id| personas.iter().any(|x| s(x, "id") == *id)) {
            Some(id) => id.to_string(),
            None => profiles::new_id("ps-"),
        };
        let rec = json!({ "id": id, "user": user, "bot": bot, "prompt": prompt, "name": name });
        match personas.iter_mut().find(|x| s(x, "id") == id) {
            Some(x) => *x = rec,
            None => personas.push(rec),
        }
        st["personaId"] = id.into();
        self.commit(&st)
    }
    /// Deletes a persona (never Default); its chats then count as Default's.
    pub fn delete_persona(&self, id: &str) -> Result<Value> {
        if id == "default" {
            bail!("The Default persona can't be deleted");
        }
        let _g = self.guard();
        let mut st = self.read()?;
        st["personas"].as_array_mut().unwrap().retain(|p| s(p, "id") != id);
        if s(&st, "personaId") == id {
            st["personaId"] = "default".into();
        }
        self.commit(&st)
    }
    pub fn delete_profile(&self, id: &str) -> Result<Value> {
        let _g = self.guard();
        let st = profiles::remove(&self.read()?, id);
        self.commit(&st)
    }
    /// Makes profile `id` the active one.
    pub fn activate(&self, id: &str) -> Result<Value> {
        let _g = self.guard();
        let mut st = self.read()?;
        if !st["profiles"].as_array().unwrap().iter().any(|p| s(p, "id") == id) {
            bail!("Unknown profile");
        }
        st["activeId"] = id.into();
        self.commit(&st)
    }
}

#[cfg(test)]
pub mod tests {
    use super::super::disk::tmp;
    use super::*;
    use base64::Engine;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
    /// A reversible stand-in for a keyring (base64), with switches to make it unavailable or fail to decrypt.
    #[derive(Clone, Default)]
    pub struct Rot {
        pub off: Arc<AtomicBool>,
        pub broken: Option<String>, // decrypting this exact blob fails ("*" fails all)
    }
    impl Crypto for Rot {
        fn available(&self) -> bool {
            !self.off.load(Ordering::SeqCst)
        }
        fn enc(&self, t: &str) -> Result<String> {
            Ok(B64.encode(t))
        }
        fn dec(&self, b: &str) -> Result<String> {
            if self.broken.as_deref().is_some_and(|x| x == "*" || x == b) {
                bail!("locked");
            }
            Ok(String::from_utf8(B64.decode(b)?)?)
        }
    }
    fn tmp_store(c: Rot) -> (PathBuf, PathBuf, Store) {
        let dir = tmp("set");
        let file = dir.join("settings.json");
        (dir.clone(), file, Store::new(Disk::new(dir), Box::new(c)))
    }
    fn disk(file: &PathBuf) -> Value {
        serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
    }
    fn err<T: std::fmt::Debug>(r: Result<T>) -> String {
        r.unwrap_err().to_string()
    }

    #[test]
    fn damaged_file_is_quarantined_not_overwritten() {
        let (dir, file, st) = tmp_store(Rot::default());
        let bad = r#"{"version":2,"profiles":[{"id":"p1","keyEnc":"abc""#;
        fs::write(&file, bad).unwrap();
        assert_eq!(st.get().unwrap()["profiles"], json!([]));
        assert!(st.take_notice().contains("damaged"));
        assert_eq!(st.take_notice(), "");
        assert_eq!(fs::read_to_string(dir.join("settings.json.bad")).unwrap(), bad);
        fs::write(&file, "null").unwrap();
        assert_eq!(st.get().unwrap()["profiles"], json!([]));
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        // a second damaged file never overwrites the first backup
        fs::write(&file, "{oops").unwrap();
        st.get().unwrap();
        assert_eq!(fs::read_to_string(dir.join("settings.json.bad")).unwrap(), bad);
        assert_eq!(fs::read_to_string(dir.join("settings.json.bad-2")).unwrap(), "{oops");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reading_without_a_file_writes_nothing() {
        let (dir, file, st) = tmp_store(Rot::default());
        st.get().unwrap();
        assert!(st.load(None, false).is_err());
        assert!(!file.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn read_error_leaves_settings_alone() {
        let (dir, file, st) = tmp_store(Rot::default());
        fs::create_dir(&file).unwrap(); // reading a folder fails with an error that isn't "not found"
        assert!(st.get().is_err());
        assert!(file.is_dir() && !dir.join("settings.json.bad").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn key_keep_and_clear_rules() {
        let (dir, _, st) = tmp_store(Rot::default());
        let v = st.save_profile(None, "P", "http://x/v1/", "", Some("sk-1")).unwrap();
        let id = s(&v, "activeId").to_string();
        assert_eq!(st.key(&id).unwrap(), "sk-1");
        assert_eq!(v["profiles"][0]["hasKey"], true);
        assert_eq!(v["profiles"][0]["endpoint"], "http://x/v1");
        st.save_profile(Some(&id), "Renamed", "http://x/v1", "", None).unwrap();
        assert_eq!(st.key(&id).unwrap(), "sk-1");
        assert!(err(st.save_profile(Some(&id), "", "ftp://x", "", None)).contains("http"));
        assert!(err(st.save_profile(Some(&id), "", "not a url", "", None)).contains("valid URL"));
        assert_eq!(st.key(&id).unwrap(), "sk-1");
        st.save_profile(Some(&id), "Renamed", "http://x/v1", "", Some("")).unwrap();
        assert_eq!(st.key(&id).unwrap(), "");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn undecryptable_key_plaintext_upgrade_patch_never_creates() {
        let (dir, file, st) = tmp_store(Rot::default());
        assert!(err(st.load(None, false)).contains("No profile yet"));
        st.patch(&json!({ "model": "m" })).unwrap();
        assert_eq!(st.get().unwrap()["profiles"], json!([]));
        let id = s(&st.save_profile(None, "P", "http://x", "", Some("sk-1")).unwrap(), "activeId").to_string();
        assert_eq!(st.load(None, false).unwrap().key, "sk-1");
        // a named profile is loaded even when another is active, so a send matches the profile on screen
        let id2 = s(&st.save_profile(None, "Q", "http://y", "", Some("sk-2")).unwrap(), "activeId").to_string();
        assert_ne!(id, id2);
        assert_eq!(st.load(None, false).unwrap().endpoint, "http://y");
        assert_eq!(st.load(Some(&id), false).unwrap().key, "sk-1");
        assert!(err(st.load(Some("gone"), false)).contains("no longer exists"));
        st.activate(&id).unwrap();
        let broken = Store::new(Disk::new(&dir), Box::new(Rot { broken: Some("*".into()), ..Default::default() }));
        assert!(err(broken.load(None, false)).contains("Couldn't read the saved API key"));
        assert!(disk(&file)["profiles"][0].get("keyEnc").is_some());
        let mut raw = disk(&file);
        raw["profiles"][0].as_object_mut().unwrap().remove("keyEnc");
        raw["profiles"][0]["keyPlain"] = "sk-9".into();
        fs::write(&file, raw.to_string()).unwrap();
        assert_eq!(st.key(&id).unwrap(), "sk-9");
        assert!(disk(&file)["profiles"][0].get("keyEnc").is_some());
        assert!(disk(&file)["profiles"][0].get("keyPlain").is_none());
        st.patch(&json!({ "effort": "high", "model": "gpt" })).unwrap();
        let v = st.get().unwrap();
        assert_eq!((s(&v, "effort"), s(&v["profiles"][0], "model")), ("high", "gpt"));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_keyring_keeps_key_plain_then_upgrades() {
        let c = Rot::default();
        c.off.store(true, Ordering::SeqCst);
        let (dir, file, st) = tmp_store(c.clone());
        st.save_profile(None, "P", "http://x", "", Some("sk-1")).unwrap();
        assert_eq!(disk(&file)["profiles"][0]["keyPlain"], "sk-1");
        c.off.store(false, Ordering::SeqCst);
        assert_eq!(st.load(None, false).unwrap().key, "sk-1");
        assert_eq!(disk(&file)["profiles"][0]["keyEnc"], B64.encode("sk-1"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changes_fired_together_are_all_applied() {
        let (dir, _, st) = tmp_store(Rot::default());
        st.save_profile(None, "P", "http://x", "", None).unwrap();
        let st = Arc::new(st);
        let patches = [
            json!({ "model": "m1" }),
            json!({ "effort": "high" }),
            json!({ "render": { "html": false } }),
            json!({ "theme": { "id": "ocean" } }),
            json!({ "meta": true }),
        ];
        let hs: Vec<_> = patches.into_iter().map(|p| {
            let st = st.clone();
            std::thread::spawn(move || st.patch(&p).unwrap())
        }).collect();
        hs.into_iter().for_each(|h| { h.join().unwrap(); });
        let v = st.get().unwrap();
        assert_eq!(v["profiles"][0]["model"], "m1");
        assert_eq!(v["effort"], "high");
        assert_eq!(v["render"]["html"], false);
        assert_eq!(v["theme"]["id"], "ocean");
        assert_eq!(v["profiles"][0]["meta"], true);
        assert!(err(st.activate("nope")).contains("Unknown profile"));
        assert_eq!(st.get().unwrap()["effort"], "high");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn thinking_switch_flag() {
        let (dir, _, st) = tmp_store(Rot::default());
        st.save_profile(None, "D", "https://api.deepseek.com/v1", "", None).unwrap();
        assert_eq!(st.get().unwrap()["profiles"][0]["thinkingSwitch"], true);
        st.save_profile(None, "O", "https://api.openai.com/v1", "", None).unwrap();
        assert_eq!(st.get().unwrap()["profiles"][1]["thinkingSwitch"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn personas_save_select_delete() {
        let (dir, _, st) = tmp_store(Rot::default());
        let v = st.save_persona(None, "", "Dalton", " Captain ", "Arr").unwrap();
        let id = s(&v, "personaId").to_string();
        assert_ne!(id, "default");
        assert_eq!(v["personas"][1], json!({ "id": id, "user": "Dalton", "bot": "Captain", "prompt": "Arr", "name": "Captain" }));
        let v = st.save_persona(Some(&id), "Pirate", "Dalton", "Captain", "Arr!").unwrap();
        assert_eq!(v["personas"].as_array().unwrap().len(), 2);
        assert_eq!(v["personas"][1]["name"], "Pirate");
        assert_eq!(st.patch(&json!({ "personaId": "default" })).unwrap()["personaId"], "default");
        assert_eq!(st.patch(&json!({ "personaId": "nope" })).unwrap()["personaId"], "default");
        assert!(err(st.delete_persona("default")).contains("can't be deleted"));
        st.patch(&json!({ "personaId": id })).unwrap();
        let v = st.delete_persona(&id).unwrap();
        assert_eq!(v["personas"].as_array().unwrap().len(), 1);
        assert_eq!(v["personaId"], "default");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn render_patch_only_booleans() {
        let (dir, _, st) = tmp_store(Rot::default());
        assert_eq!(st.get().unwrap()["render"]["html"], true);
        assert_eq!(st.patch(&json!({ "render": { "html": false } })).unwrap()["render"]["html"], false);
        assert_eq!(st.patch(&json!({ "render": { "css": "no", "bogus": true } })).unwrap()["render"]["css"], true);
        assert!(st.get().unwrap()["render"].get("bogus").is_none());
        assert_eq!(
            st.patch(&json!({ "render": { "markdown": false, "html": true } })).unwrap()["render"],
            json!({ "markdown": false, "html": true, "css": true, "js": true })
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn theme_patch_rules() {
        let (dir, file, st) = tmp_store(Rot::default());
        assert_eq!(st.patch(&json!({ "theme": { "id": "sunset" } })).unwrap()["theme"]["id"], "sunset");
        assert_eq!(st.patch(&json!({ "theme": { "id": "nope" } })).unwrap()["theme"]["id"], "sunset");
        assert_eq!(st.patch(&json!({ "theme": { "id": "custom", "a1": "red", "a2": "#123456" } })).unwrap()["theme"]["id"], "sunset");
        assert_eq!(st.patch(&json!({ "theme": { "id": "custom", "a1": "#ABCDEF", "a2": "#123456", "evil": "<x>" } })).unwrap()["theme"]["id"], "custom");
        assert_eq!(disk(&file)["theme"], json!({ "id": "custom", "a1": "#abcdef", "a2": "#123456" }));
        fs::write(&file, r##"{"version":2,"profiles":[],"theme":{"id":"custom","a1":"url(javascript:1)","a2":"#fff"}}"##).unwrap();
        assert_eq!(st.get().unwrap()["theme"], json!({ "id": "aurora" }));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_tools_flag_booleans_only() {
        let (dir, _, st) = tmp_store(Rot::default());
        st.save_profile(None, "P", "http://x", "", Some("sk-1")).unwrap();
        assert_eq!(st.get().unwrap()["profiles"][0]["noTools"], false);
        assert_eq!(st.patch(&json!({ "model": "m", "noTools": true })).unwrap()["profiles"][0]["noTools"], true);
        assert_eq!(st.patch(&json!({ "noTools": "yes" })).unwrap()["profiles"][0]["noTools"], true);
        assert_eq!(st.patch(&json!({ "noTools": false })).unwrap()["profiles"][0]["noTools"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn patch_types_and_profile_targeting() {
        let (dir, file, st) = tmp_store(Rot::default());
        st.patch(&json!({ "effort": "high" })).unwrap();
        // wrong types are ignored, not zeroed
        st.patch(&json!({ "effort": 5, "model": 7, "meta": "yes", "noTools": 1, "profileId": 3 })).unwrap();
        let raw = disk(&file);
        assert_eq!((s(&raw, "effort"), s(&raw["profiles"][0].clone(), "model")), ("high", ""));
        // a named profile takes the model/meta/noTools changes, the active one is untouched
        let a = s(&st.save_profile(None, "A", "http://a", "", None).unwrap(), "activeId").to_string();
        let v = st.save_profile(None, "B", "http://b", "", None).unwrap();
        let b = s(&v, "activeId").to_string();
        st.patch(&json!({ "profileId": a, "model": "m-a", "meta": true, "noTools": true })).unwrap();
        let v = st.get().unwrap();
        let p = |id: &str| v["profiles"].as_array().unwrap().iter().find(|x| s(x, "id") == id).cloned().unwrap();
        assert_eq!((s(&p(&a), "model"), p(&a)["meta"].clone(), p(&a)["noTools"].clone()), ("m-a", json!(true), json!(true)));
        assert_eq!((s(&p(&b), "model"), p(&b)["meta"].clone()), ("", json!(false)));
        // without profileId the changes land on the active profile, as before
        st.patch(&json!({ "model": "m-b" })).unwrap();
        let v = st.get().unwrap();
        let p = |id: &str| v["profiles"].as_array().unwrap().iter().find(|x| s(x, "id") == id).cloned().unwrap();
        assert_eq!(s(&p(&b), "model"), "m-b");
        // an unknown profileId drops them
        st.patch(&json!({ "profileId": "nope", "model": "x", "meta": true })).unwrap();
        let v = st.get().unwrap();
        assert!(v["profiles"].as_array().unwrap().iter().all(|x| s(x, "model") != "x"));
        // a non-string profileId is simply ignored, like a missing one
        st.patch(&json!({ "model": 9, "profileId": 42 })).unwrap();
        let v = st.get().unwrap();
        let still = v["profiles"].as_array().unwrap().iter().find(|x| s(x, "id") == b).cloned().unwrap();
        assert_eq!(s(&still, "model"), "m-b");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn endpoint_change_forgets_discovery_flags() {
        let (dir, file, st) = tmp_store(Rot::default());
        let id = s(&st.save_profile(None, "P", "http://x/v1", "", None).unwrap(), "activeId").to_string();
        st.patch(&json!({ "meta": true, "noTools": true, "model": "m" })).unwrap();
        assert_eq!((disk(&file)["profiles"][0]["meta"].clone(), disk(&file)["profiles"][0]["noTools"].clone()), (json!(true), json!(true)));
        // a different endpoint: the flags were discovered for the old one
        st.save_profile(Some(&id), "P", "http://y/v1", "", None).unwrap();
        assert_eq!((disk(&file)["profiles"][0]["meta"].clone(), disk(&file)["profiles"][0]["noTools"].clone()), (json!(false), json!(false)));
        assert_eq!(disk(&file)["profiles"][0]["model"], "m"); // the model and key stay
        // the same endpoint (trailing slash and all): the flags stay
        st.patch(&json!({ "meta": true })).unwrap();
        st.save_profile(Some(&id), "P", "http://y/v1/", "", None).unwrap();
        assert_eq!(disk(&file)["profiles"][0]["meta"], json!(true));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn search_settings() {
        let (dir, file, st) = tmp_store(Rot::default());
        assert_eq!(st.get().unwrap()["search"], json!({ "enabled": false, "hasKey": false }));
        st.save_profile(None, "P", "http://x", "", Some("sk-1")).unwrap();
        assert_eq!(st.load(None, true).unwrap().search, None);
        let v = st.save_search(Some(true), Some("lk-1")).unwrap();
        assert_eq!(v["search"], json!({ "enabled": true, "hasKey": true }));
        assert!(!v.to_string().contains("lk-1") && !st.get().unwrap().to_string().contains("lk-1"));
        assert!(!fs::read_to_string(&file).unwrap().contains("lk-1"));
        assert_eq!(st.search_key().unwrap(), "lk-1");
        assert_eq!(st.load(None, true).unwrap().search.as_deref(), Some("lk-1"));
        assert_eq!(st.load(None, false).unwrap().search, None);
        st.save_search(Some(false), None).unwrap();
        assert_eq!(st.search_key().unwrap(), "lk-1");
        assert_eq!(st.load(None, true).unwrap().search, None);
        st.patch(&json!({ "effort": "low", "theme": { "id": "rose" } })).unwrap();
        assert_eq!(st.get().unwrap()["search"]["hasKey"], true);
        let mut raw = disk(&file);
        raw["search"] = json!({ "enabled": true, "keyPlain": "lk-9" });
        fs::write(&file, raw.to_string()).unwrap();
        assert_eq!(st.search_key().unwrap(), "lk-9");
        assert!(disk(&file)["search"].get("keyEnc").is_some() && disk(&file)["search"].get("keyPlain").is_none());
        st.save_search(None, Some("")).unwrap();
        assert_eq!(st.search_key().unwrap(), "");
        assert_eq!(st.get().unwrap()["search"]["hasKey"], false);
        st.save_search(Some(true), Some("lk-2")).unwrap();
        let broken = Store::new(Disk::new(&dir), Box::new(Rot { broken: Some(B64.encode("lk-2")), ..Default::default() }));
        assert!(err(broken.load(None, true)).contains("Couldn't read the saved search key"));
        assert_eq!(broken.load(None, false).unwrap().key, "sk-1");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Files written by the JS app read back unchanged in shape.
    #[test]
    fn reads_js_app_files() {
        let (dir, file, st) = tmp_store(Rot::default());
        let js = json!({ "version": 2, "activeId": "p-1", "effort": "high", "profiles": [{ "id": "p-1", "name": "OR", "endpoint": "https://openrouter.ai/api/v1", "model": "a/b", "format": "auto", "meta": true, "noTools": false, "keyEnc": "djEwABCD" }],
            "search": { "enabled": true, "keyEnc": "djEwXYZ" }, "personas": [{ "id": "default", "name": "Default", "user": "", "bot": "", "prompt": "" }], "personaId": "default",
            "render": { "markdown": true, "html": true, "css": false, "js": true }, "theme": { "id": "ocean" } });
        fs::write(&file, serde_json::to_string_pretty(&js).unwrap()).unwrap();
        let v = st.get().unwrap();
        assert_eq!((s(&v, "activeId"), v["profiles"][0]["hasKey"].clone(), v["render"]["css"].clone()), ("p-1", json!(true), json!(false)));
        st.patch(&json!({ "effort": "low" })).unwrap();
        let mut expect = js.clone();
        expect["effort"] = "low".into();
        assert_eq!(disk(&file), expect); // same fields, same order
        fs::remove_dir_all(dir).unwrap();
    }
}
