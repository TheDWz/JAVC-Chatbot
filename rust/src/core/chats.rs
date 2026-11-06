//! Chat history (port of chats.js): one JSON file per chat, plus _index.json (id, title, updated, personaId) so
//! listing doesn't open every chat. Each chat holds only its own messages, which is what keeps chats isolated.
use super::disk::Disk;
use anyhow::{Result, bail};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::Mutex;

const INDEX: &str = "_index.json"; // '_' can't appear in an id, so it never collides with a chat

pub struct Chats {
    io: Disk,
    lock: Mutex<()>, // one operation at a time, so the index is never rewritten from a stale copy
}

/// The file name of chat `id`; rejects anything that isn't a plain id, so a name can never point outside the folder.
fn file(id: &str) -> Result<String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        bail!("Invalid chat id");
    }
    Ok(format!("{id}.json"))
}
/// The index entry of a chat: the fields it has among id, title, updated and personaId.
fn entry(c: &Value) -> Value {
    let mut o = Map::new();
    for k in ["id", "title", "updated", "personaId"] {
        if let Some(v) = c.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    Value::Object(o)
}
fn id_of(c: &Value) -> &str {
    c.get("id").and_then(Value::as_str).unwrap_or("")
}
fn sorted(mut ix: Vec<Value>) -> Vec<Value> {
    let t = |c: &Value| c.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
    ix.sort_by(|a, b| t(b).total_cmp(&t(a)));
    ix
}

impl Chats {
    pub fn new(io: Disk) -> Self {
        Chats { io, lock: Mutex::new(()) }
    }
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The chat file names in the folder, or None when the folder can't be listed.
    fn chat_files(&self) -> Option<Vec<String>> {
        self.io.list().ok().map(|v| v.into_iter().filter(|n| n.ends_with(".json") && n != INDEX).collect())
    }
    /// Index entries read from the given chat files. A corrupt file, or one whose id doesn't match its name, is skipped
    /// instead of losing the whole list (an entry under the wrong id could never be opened, and would be re-added forever).
    fn entries(&self, names: &[String]) -> Vec<Value> {
        names
            .iter()
            .filter_map(|n| {
                let c: Value = serde_json::from_str(&self.io.read(n).ok()??).ok()?;
                (c.get("id").and_then(Value::as_str).map(|id| format!("{id}.json")).as_deref() == Some(n.as_str())).then(|| entry(&c))
            })
            .collect()
    }
    /// The saved index, or None when it's missing or damaged.
    fn read_index(&self) -> Option<Vec<Value>> {
        match serde_json::from_str(&self.io.read(INDEX).ok()??).ok()? {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }
    /// The index, rebuilt from the chat files when it's missing or damaged.
    fn index(&self) -> Vec<Value> {
        self.read_index().unwrap_or_else(|| self.entries(&self.chat_files().unwrap_or_default()))
    }
    fn write_index(&self, ix: &[Value]) -> Result<()> {
        self.io.write(INDEX, &serde_json::to_string(ix)?)
    }

    /// All chats, newest first. The index is checked against the chat files, so an interrupted save or delete can't hide a
    /// chat or list a deleted one: entries without a file are dropped and files missing from the index are added.
    pub fn list(&self) -> Result<Vec<Value>> {
        let _g = self.guard();
        let (names, saved) = (self.chat_files(), self.read_index());
        let Some(names) = names else { return Ok(sorted(saved.unwrap_or_default())) }; // can't see the folder: show what the index says
        let ix = match &saved {
            None => self.entries(&names),
            Some(saved) => {
                let on_disk: HashSet<&str> = names.iter().map(|n| &n[..n.len() - 5]).collect();
                let kept: Vec<Value> = saved.iter().filter(|c| on_disk.contains(id_of(c))).cloned().collect();
                let known: HashSet<&str> = kept.iter().map(id_of).collect();
                let added = self.entries(&names.iter().filter(|n| !known.contains(&n[..n.len() - 5])).cloned().collect::<Vec<_>>());
                if kept.len() == saved.len() && added.is_empty() { saved.clone() } else { [kept, added].concat() }
            }
        };
        if saved.as_ref() != Some(&ix) && (!ix.is_empty() || saved.is_some()) {
            self.write_index(&ix)?;
        }
        Ok(sorted(ix))
    }
    /// The full chat `id`; an error if it no longer exists.
    pub fn load(&self, id: &str) -> Result<Value> {
        let _g = self.guard();
        match self.io.read(&file(id)?)? {
            None => bail!("This chat no longer exists"),
            Some(t) => Ok(serde_json::from_str(&t)?),
        }
    }
    /// Writes the chat, then its index entry.
    pub fn save(&self, chat: &Value) -> Result<()> {
        let _g = self.guard();
        let id = chat.get("id").and_then(Value::as_str).unwrap_or("");
        self.io.write(&file(id)?, &serde_json::to_string(chat)?)?;
        let mut ix: Vec<Value> = self.index().into_iter().filter(|c| id_of(c) != id).collect();
        ix.push(entry(chat));
        self.write_index(&ix)
    }
    /// Deletes the chat, then its index entry.
    pub fn remove(&self, id: &str) -> Result<()> {
        let _g = self.guard();
        self.io.remove(&file(id)?)?;
        let ix: Vec<Value> = self.index().into_iter().filter(|c| id_of(c) != id).collect();
        self.write_index(&ix)
    }
}

#[cfg(test)]
mod tests {
    use super::super::disk::tmp;
    use super::*;
    use serde_json::json;
    use std::fs;

    fn ids(v: &[Value]) -> Vec<&str> {
        v.iter().map(id_of).collect()
    }

    #[test]
    fn keeps_chats_separate_sorted_deletable_and_rejects_bad_ids() {
        let dir = tmp("chats");
        let c = Chats::new(Disk::new(&dir));
        c.save(&json!({ "id": "a1", "title": "A", "updated": 1, "messages": [{ "role": "user", "content": "alpha" }] })).unwrap();
        c.save(&json!({ "id": "b2", "title": "B", "updated": 2, "messages": [{ "role": "user", "content": "beta" }] })).unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["b2", "a1"]);
        assert_eq!(c.load("a1").unwrap()["messages"], json!([{ "role": "user", "content": "alpha" }]));
        c.remove("a1").unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["b2"]);
        assert!(c.load("a1").unwrap_err().to_string().contains("no longer exists"));
        assert!(c.load("../x").unwrap_err().to_string().contains("Invalid chat id"));
        assert!(c.save(&json!({ "id": "../../evil" })).unwrap_err().to_string().contains("Invalid chat id"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_reads_index_rebuilds_and_stays_in_step() {
        let dir = tmp("chats2");
        let c = Chats::new(Disk::new(&dir));
        c.save(&json!({ "id": "a1", "title": "A", "updated": 1, "messages": [] })).unwrap();
        c.save(&json!({ "id": "b2", "title": "B", "updated": 2, "messages": [] })).unwrap();
        fs::write(dir.join("a1.json"), "not json").unwrap(); // list must not open chat files
        assert_eq!(ids(&c.list().unwrap()), ["b2", "a1"]);
        fs::remove_file(dir.join("_index.json")).unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["b2"]); // rebuilt by scanning; the corrupt chat is skipped
        assert!(dir.join("_index.json").exists());
        c.remove("b2").unwrap();
        assert!(c.list().unwrap().is_empty());
        assert!(c.load("_index").unwrap_err().to_string().contains("Invalid chat id"));
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saves_fired_together_all_land() {
        let dir = tmp("chats3");
        let c = std::sync::Arc::new(Chats::new(Disk::new(&dir)));
        let hs: Vec<_> = ["a1", "b2", "c3", "d4"]
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let c = c.clone();
                let id = id.to_string();
                std::thread::spawn(move || c.save(&json!({ "id": id, "title": id, "updated": i, "messages": [] })).unwrap())
            })
            .collect();
        hs.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(ids(&c.list().unwrap()), ["d4", "c3", "b2", "a1"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn index_keeps_persona_id() {
        let dir = tmp("chats4");
        let c = Chats::new(Disk::new(&dir));
        c.save(&json!({ "id": "a1", "title": "A", "updated": 1, "personaId": "ps-1", "messages": [] })).unwrap();
        assert_eq!(c.list().unwrap()[0]["personaId"], "ps-1");
        fs::remove_file(dir.join("_index.json")).unwrap();
        assert_eq!(c.list().unwrap()[0]["personaId"], "ps-1");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_follows_the_files() {
        let dir = tmp("chats5");
        let c = Chats::new(Disk::new(&dir));
        c.save(&json!({ "id": "a1", "title": "A", "updated": 1, "messages": [] })).unwrap();
        fs::write(dir.join("b2.json"), r#"{"id":"b2","title":"B","updated":2,"messages":[]}"#).unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["b2", "a1"]);
        fs::remove_file(dir.join("a1.json")).unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["b2"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_files_whose_id_does_not_match() {
        let dir = tmp("chats6");
        let c = Chats::new(Disk::new(&dir));
        c.save(&json!({ "id": "a1", "title": "A", "updated": 1, "messages": [] })).unwrap();
        fs::write(dir.join("b2.json"), r#"{"title":"no id","updated":2,"messages":[]}"#).unwrap();
        fs::write(dir.join("c3.json"), r#"{"id":"zz","title":"wrong id","updated":3,"messages":[]}"#).unwrap();
        assert_eq!(ids(&c.list().unwrap()), ["a1"]);
        let before = fs::read_to_string(dir.join("_index.json")).unwrap();
        c.list().unwrap();
        assert_eq!(fs::read_to_string(dir.join("_index.json")).unwrap(), before);
        fs::remove_dir_all(dir).unwrap();
    }
}
