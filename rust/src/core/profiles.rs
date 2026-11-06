//! Connection profiles (port of profiles.js): pure state functions over the settings JSON.
//! Stored profile: {id, name, endpoint, model, format, meta, keyEnc | keyPlain}. Keys are opaque here; the store encrypts them.
use super::shared::{RENDER_KEYS, clean_theme, s};
use serde_json::{Map, Value, json};

pub struct Template {
    pub id: &'static str,
    pub name: &'static str,
    pub endpoint: &'static str,
}
pub const TEMPLATES: [Template; 4] = [
    Template { id: "nanogpt", name: "NanoGPT", endpoint: "https://nano-gpt.com/api/v1" },
    Template { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1" },
    Template { id: "venice", name: "Venice", endpoint: "https://api.venice.ai/api/v1" },
    Template { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1" },
];

fn norm(u: &str) -> String {
    u.trim().trim_end_matches('/').to_lowercase()
}
pub const KEY_FIELDS: [&str; 2] = ["keyEnc", "keyPlain"];
/// Whether a value counts as set the way JS truthiness does for key fields.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
/// The key fields of `o` that are set.
pub fn key_of(o: &Value) -> Map<String, Value> {
    KEY_FIELDS.iter().filter(|k| truthy(o.get(**k))).map(|k| (k.to_string(), o[*k].clone())).collect()
}
pub fn has_key(p: &Value) -> bool {
    KEY_FIELDS.iter().any(|k| truthy(p.get(*k)))
}
fn fallback_active(profiles: &[Value], id: &str) -> String {
    if profiles.iter().any(|p| s(p, "id") == id) { id.to_string() } else { profiles.first().map(|p| s(p, "id").to_string()).unwrap_or_default() }
}
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

/// Turns whatever is on disk (nothing, the old single-endpoint file, or v2) into v2 state.
/// Templates are NOT profiles: they only exist as starting points in the New profile dialog.
pub fn migrate(raw: &Value) -> Value {
    let effort = |r: &Value| Value::String(s(r, "effort").to_string());
    if raw.get("version").and_then(Value::as_i64) == Some(2) && raw.get("profiles").is_some_and(Value::is_array) {
        // an earlier version pre-created the four templates; drop the ones that never got a key
        let profiles: Vec<Value> = arr(&raw["profiles"]).into_iter().filter(|p| !(TEMPLATES.iter().any(|t| t.id == s(p, "id")) && !has_key(p))).collect();
        let active = fallback_active(&profiles, s(raw, "activeId"));
        return finish_state(json!({ "version": 2, "activeId": active, "effort": effort(raw), "profiles": profiles }), raw);
    }
    let mut state = json!({ "version": 2, "activeId": "", "effort": effort(raw), "profiles": [] });
    let ep = s(raw, "endpoint");
    if !ep.is_empty() {
        // old single-endpoint file becomes one profile
        let host = url::Url::parse(ep).ok().and_then(|u| u.host_str().map(|h| u.port().map_or(h.to_string(), |p| format!("{h}:{p}")))).filter(|h| !h.is_empty());
        let host = host.unwrap_or_else(|| "Custom".into());
        let tpl = TEMPLATES.iter().find(|t| norm(t.endpoint) == norm(ep));
        let slug: String = {
            let mut out = String::new();
            for c in host.to_lowercase().chars() {
                if c.is_ascii_lowercase() || c.is_ascii_digit() {
                    out.push(c);
                } else if !out.ends_with('-') {
                    out.push('-');
                }
            }
            out
        };
        let format = if s(raw, "format").is_empty() { "auto" } else { s(raw, "format") };
        let mut p = json!({
            "id": format!("custom-{slug}"), // stable: migrate() runs on every read until the file is rewritten
            "name": tpl.map_or(host.clone(), |t| t.name.to_string()), "endpoint": ep, "model": s(raw, "model"), "format": format,
            "meta": truthy(raw.get("meta")),
        });
        p.as_object_mut().unwrap().extend(key_of(raw));
        state["activeId"] = p["id"].clone();
        state["profiles"] = json!([p]);
    }
    finish_state(state, raw)
}

/// Personas: {id, name, user, bot, prompt}. 'default' always exists and can't be deleted. `render` (which reply formats are
/// shown and hinted) and `theme` have defaults; `rich` is the old single switch.
fn finish_state(mut state: Value, raw: &Value) -> Value {
    let mut personas: Vec<Value> = arr(raw.get("personas").unwrap_or(&Value::Null))
        .into_iter()
        .filter(|p| p.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty()))
        .map(|p| json!({ "id": s(&p, "id"), "name": s(&p, "name"), "user": s(&p, "user"), "bot": s(&p, "bot"), "prompt": s(&p, "prompt") }))
        .collect();
    if !personas.iter().any(|p| s(p, "id") == "default") {
        personas.insert(0, json!({ "id": "default", "name": "Default", "user": "", "bot": "", "prompt": "" }));
    }
    let rich_off = raw.get("rich") == Some(&Value::Bool(false)); // old single switch: off meant "no HTML/CSS/JS", Markdown stayed on
    let r = raw.get("render").filter(|v| v.is_object()).cloned().unwrap_or(json!({}));
    let render: Map<String, Value> =
        RENDER_KEYS.iter().map(|k| (k.to_string(), Value::Bool(r.get(*k).and_then(Value::as_bool).unwrap_or(!(rich_off && *k != "markdown"))))).collect();
    let mut search = json!({ "enabled": raw.pointer("/search/enabled") == Some(&Value::Bool(true)) }); // web search: {enabled, keyEnc|keyPlain}
    if let Some(sv) = raw.get("search").filter(|v| v.is_object()) {
        search.as_object_mut().unwrap().extend(key_of(sv));
    }
    let pid = s(raw, "personaId");
    let persona_id = if personas.iter().any(|p| s(p, "id") == pid) { pid.to_string() } else { "default".into() };
    let o = state.as_object_mut().unwrap();
    o.insert("search".into(), search);
    o.insert("personas".into(), Value::Array(personas));
    o.insert("personaId".into(), persona_id.into());
    o.insert("render".into(), Value::Object(render));
    o.insert("theme".into(), clean_theme(raw.get("theme")).unwrap_or(json!({ "id": "aurora" })));
    state
}

/// 'p-' plus the time and a random suffix, both base 36 (the JS app's id shape).
pub fn new_id(prefix: &str) -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    format!("{prefix}{}{}", base36(ms), rand36(4))
}
pub fn base36(mut n: u64) -> String {
    let d = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = vec![];
    loop {
        out.push(d[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
pub fn rand36(len: usize) -> String {
    let mut b = vec![0u8; len];
    getrandom::fill(&mut b).expect("system random source");
    b.iter().map(|x| b"0123456789abcdefghijklmnopqrstuvwxyz"[(*x % 36) as usize] as char).collect()
}

/// Insert a profile (made active) or update one (active profile unchanged). Key fields in `p` replace the stored key only when present.
pub fn upsert(state: &Value, p: &Value) -> Value {
    let mut st = state.clone();
    let pid = s(p, "id").to_string();
    let existed = !pid.is_empty() && arr(&state["profiles"]).iter().any(|x| s(x, "id") == pid);
    let profiles = st["profiles"].as_array_mut().unwrap();
    let idx = match profiles.iter().position(|x| !pid.is_empty() && s(x, "id") == pid) {
        Some(i) => i,
        None => {
            profiles.push(json!({ "id": new_id("p-"), "model": "", "format": "auto", "meta": false }));
            profiles.len() - 1
        }
    };
    let target = profiles[idx].as_object_mut().unwrap();
    for k in ["name", "endpoint", "format", "model", "meta", "noTools"] {
        if let Some(v) = p.get(k) {
            target.insert(k.into(), v.clone());
        }
    }
    if p.get("keyEnc").is_some() || p.get("keyPlain").is_some() {
        for k in KEY_FIELDS {
            target.remove(k);
        }
        target.extend(key_of(p));
    }
    let tid = s(&profiles[idx], "id").to_string();
    let active_ok = arr(&state["profiles"]).iter().any(|x| s(x, "id") == s(state, "activeId"));
    if !(existed && active_ok) {
        st["activeId"] = tid.into(); // a new profile becomes active; editing another one doesn't switch
    }
    st
}

pub fn remove(state: &Value, id: &str) -> Value {
    let mut st = state.clone();
    let profiles: Vec<Value> = arr(&state["profiles"]).into_iter().filter(|p| s(p, "id") != id).collect();
    st["activeId"] = fallback_active(&profiles, s(state, "activeId")).into();
    st["profiles"] = Value::Array(profiles);
    st
}

/// What the UI gets: never the keys themselves.
pub fn public_view(state: &Value) -> Value {
    let templates: Vec<Value> = TEMPLATES.iter().map(|t| json!({ "id": t.id, "name": t.name, "endpoint": t.endpoint })).collect();
    let profiles: Vec<Value> = arr(&state["profiles"])
        .iter()
        .map(|p| {
            let fmt = if s(p, "format").is_empty() { "auto" } else { s(p, "format") };
            json!({ "id": s(p, "id"), "name": s(p, "name"), "endpoint": s(p, "endpoint"), "model": s(p, "model"), "format": fmt,
                "meta": truthy(p.get("meta")), "noTools": truthy(p.get("noTools")), "hasKey": has_key(p) })
        })
        .collect();
    json!({
        "activeId": state["activeId"], "effort": state["effort"], "templates": templates, "personas": state["personas"], "personaId": state["personaId"],
        "render": state["render"], "theme": state["theme"], "search": { "enabled": state["search"]["enabled"], "hasKey": has_key(&state["search"]) },
        "profiles": profiles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(st: &Value) -> Vec<String> {
        arr(&st["profiles"]).iter().map(|p| s(p, "id").to_string()).collect()
    }

    #[test]
    fn first_run_is_empty_templates_are_not_profiles() {
        let st = migrate(&Value::Null);
        assert_eq!((arr(&st["profiles"]).len(), s(&st, "activeId")), (0, ""));
        let names: Vec<_> = arr(&public_view(&st)["templates"]).iter().map(|t| s(t, "name").to_string()).collect();
        assert_eq!(names, ["NanoGPT", "OpenRouter", "Venice", "OpenAI"]);
        let url = |id| TEMPLATES.iter().find(|t| t.id == id).unwrap().endpoint;
        assert_eq!(url("nanogpt"), "https://nano-gpt.com/api/v1");
        assert_eq!(url("venice"), "https://api.venice.ai/api/v1");
        assert_eq!(url("openrouter"), "https://openrouter.ai/api/v1");
        assert_eq!(url("openai"), "https://api.openai.com/v1");
    }

    #[test]
    fn old_file_becomes_one_profile() {
        let t = migrate(&json!({ "endpoint": "https://openrouter.ai/api/v1/", "model": "x/y", "effort": "high", "format": "openai", "keyEnc": "ENC" }));
        let p = &t["profiles"][0];
        assert_eq!(arr(&t["profiles"]).len(), 1);
        assert_eq!((s(p, "name"), s(p, "keyEnc"), s(p, "model"), s(p, "format"), s(&t, "effort")), ("OpenRouter", "ENC", "x/y", "openai", "high"));
        assert_eq!(t["activeId"], p["id"]);
        let c = migrate(&json!({ "endpoint": "http://localhost:1234/v1", "keyPlain": "k" }));
        assert_eq!((s(&c["profiles"][0], "name"), s(&c["profiles"][0], "keyPlain")), ("localhost:1234", "k"));
        assert_eq!(c["profiles"][0]["id"], "custom-localhost-1234");
        let a = migrate(&json!({ "endpoint": "http://127.0.0.1:1/v1" }));
        assert_eq!(a["activeId"], migrate(&json!({ "endpoint": "http://127.0.0.1:1/v1" }))["activeId"]);
        let again = migrate(&migrate(&json!({ "endpoint": "https://api.openai.com/v1" })));
        assert_eq!(arr(&again["profiles"]).len(), 1);
    }

    #[test]
    fn v2_drops_seeded_templates_without_key() {
        let seed = |id: &str, k: bool| {
            let mut p = json!({ "id": id, "name": id, "endpoint": format!("https://x/{id}"), "model": "", "format": "auto", "meta": false });
            if k {
                p["keyEnc"] = "K".into();
            }
            p
        };
        let raw = json!({ "version": 2, "activeId": "openai", "effort": "low", "profiles": [seed("nanogpt", true), seed("openrouter", false), seed("venice", false), seed("openai", false), seed("p-mine", false)] });
        let st = migrate(&raw);
        assert_eq!(ids(&st), ["nanogpt", "p-mine"]);
        assert_eq!(st["activeId"], "nanogpt");
        assert_eq!(st["effort"], "low");
        assert_eq!(migrate(&json!({ "version": 2, "activeId": "x", "profiles": [seed("openai", false)] }))["activeId"], "");
    }

    #[test]
    fn upsert_creates_updates_and_handles_keys() {
        let mut st = upsert(&migrate(&Value::Null), &json!({ "name": "Mine", "endpoint": "http://a/v1", "keyPlain": "k1" }));
        let id = s(&st, "activeId").to_string();
        assert!(!id.is_empty() && id.starts_with("p-"));
        assert_eq!(arr(&st["profiles"]).len(), 1);
        st = upsert(&st, &json!({ "id": id, "name": "Renamed" }));
        assert_eq!((s(&st["profiles"][0], "keyPlain"), s(&st["profiles"][0], "name")), ("k1", "Renamed"));
        st = upsert(&st, &json!({ "id": id, "keyEnc": "E" }));
        assert_eq!((st["profiles"][0].get("keyPlain"), s(&st["profiles"][0], "keyEnc")), (None, "E"));
        st = upsert(&st, &json!({ "id": id, "keyEnc": "" }));
        assert_eq!(public_view(&st)["profiles"][0]["hasKey"], false);
    }

    #[test]
    fn editing_inactive_profile_keeps_active() {
        let mut st = upsert(&upsert(&migrate(&Value::Null), &json!({ "name": "A", "endpoint": "http://a" })), &json!({ "name": "B", "endpoint": "http://b" }));
        let (a, b) = (ids(&st)[0].clone(), ids(&st)[1].clone());
        assert_eq!(s(&st, "activeId"), b);
        st = upsert(&st, &json!({ "id": a, "name": "A2" }));
        assert_eq!((s(&st, "activeId"), s(&st["profiles"][0], "name")), (b.as_str(), "A2"));
    }

    #[test]
    fn remove_falls_back() {
        let mut st = upsert(&upsert(&migrate(&Value::Null), &json!({ "name": "A", "endpoint": "http://a" })), &json!({ "name": "B", "endpoint": "http://b" }));
        let (a, b) = (ids(&st)[0].clone(), ids(&st)[1].clone());
        st = remove(&st, &b);
        assert_eq!(s(&st, "activeId"), a);
        st = remove(&st, &a);
        assert_eq!((arr(&st["profiles"]).len(), s(&st, "activeId")), (0, ""));
    }

    #[test]
    fn public_view_never_exposes_keys() {
        let st = upsert(&migrate(&Value::Null), &json!({ "name": "V", "endpoint": "http://v", "keyPlain": "SECRET-KEY" }));
        let j = public_view(&st).to_string();
        assert!(!j.contains("SECRET-KEY") && !j.contains("keyPlain"));
        assert_eq!(public_view(&st)["profiles"][0]["hasKey"], true);
    }

    #[test]
    fn personas_seeded_kept_bad_id_falls_back() {
        assert_eq!(migrate(&json!({}))["personas"], json!([{ "id": "default", "name": "Default", "user": "", "bot": "", "prompt": "" }]));
        assert_eq!(migrate(&json!({}))["personaId"], "default");
        let raw = json!({ "version": 2, "profiles": [], "personas": [{ "id": "ps-1", "name": "P", "user": "U", "bot": "B", "prompt": "x", "junk": 1 }, null, { "name": "no id" }], "personaId": "nope" });
        let st = migrate(&raw);
        let pids: Vec<_> = arr(&st["personas"]).iter().map(|p| s(p, "id").to_string()).collect();
        assert_eq!(pids, ["default", "ps-1"]);
        assert_eq!(st["personas"][1], json!({ "id": "ps-1", "name": "P", "user": "U", "bot": "B", "prompt": "x" }));
        assert_eq!(st["personaId"], "default");
        let mut raw2 = raw.clone();
        raw2["personaId"] = "ps-1".into();
        assert_eq!(migrate(&raw2)["personaId"], "ps-1");
    }

    #[test]
    fn render_defaults_and_old_rich_switch() {
        assert_eq!(migrate(&json!({}))["render"], json!({ "markdown": true, "html": true, "css": true, "js": true }));
        assert_eq!(migrate(&json!({ "version": 2, "profiles": [], "rich": false }))["render"], json!({ "markdown": true, "html": false, "css": false, "js": false }));
        assert_eq!(
            migrate(&json!({ "version": 2, "profiles": [], "rich": false, "render": { "html": true } }))["render"],
            json!({ "markdown": true, "html": true, "css": false, "js": false })
        );
        assert_eq!(migrate(&json!({}))["theme"], json!({ "id": "aurora" }));
    }
}
