//! The app's behavior (port of renderer.js plus the main-process side of main.js): it owns the window, the settings
//! and chat stores, and the reply in progress. Everything here runs on the UI thread; file and keyring work goes to a
//! worker (`bg`) and replies stream on the tokio runtime, and both report back through the event loop.
use crate::attach::{self, MAX_FILES, fmt_size};
use crate::core::api::{self, Delta, ModelInfo, Reply, Search};
use crate::core::chats::Chats;
use crate::core::disk::{Disk, migrate_legacy};
use crate::core::shared::{self, AttKind, Attachment, Render, THEMES, s};
use crate::core::store::Store;
use crate::markdown::{self, Block};
use crate::platform;
use crate::*;
use anyhow::Result;
use serde_json::{Value, json};
use slint::{ComponentHandle, Model, ModelRc, SharedString, StyledText, Timer, TimerMode, VecModel};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// What the worker threads share: the stores, the HTTP client and the runtime.
pub struct Svc {
    pub store: Store,
    pub chats: Chats,
    pub http: reqwest::Client,
    pub rt: tokio::runtime::Runtime,
    pub dir: std::path::PathBuf,
}
static SVC: OnceLock<Arc<Svc>> = OnceLock::new();
fn svc() -> Arc<Svc> {
    SVC.get().expect("services").clone()
}

thread_local! { static APP: RefCell<Option<App>> = const { RefCell::new(None) }; }
/// Runs `f` with the app (UI thread only).
fn with(f: impl FnOnce(&mut App)) {
    APP.with(|a| {
        match a.try_borrow_mut() {
            Ok(mut a) => {
                if let Some(app) = a.as_mut() {
                    f(app)
                }
            }
            Err(_) => eprintln!("javc: a UI call was dropped (the app was busy in another call)"), // never expected; `later` avoids it
        }
    })
}
type Job = Box<dyn FnOnce() + Send>;
/// A worker thread whose jobs run in the order they were sent, so an older save can never land after a newer save or a
/// delete.
fn spawn_queue(name: &str) -> std::sync::mpsc::Sender<Job> {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            for job in rx {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)); // one bad job must not stop the queue
            }
        })
        .expect("worker thread");
    tx
}
// Settings and chat files get separate queues: a keyring unlock prompt holding up a settings job must not freeze the chats.
static STORE_Q: LazyLock<std::sync::mpsc::Sender<Job>> = LazyLock::new(|| spawn_queue("javc-store"));
static CHATS_Q: LazyLock<std::sync::mpsc::Sender<Job>> = LazyLock::new(|| spawn_queue("javc-chats"));
fn run_on<T: Send + 'static>(
    q: &std::sync::mpsc::Sender<Job>,
    work: impl FnOnce(&Svc) -> Result<T> + Send + 'static,
    done: impl FnOnce(&mut App, Result<T>) + Send + 'static,
) {
    let sv = svc();
    let _ = q.send(Box::new(move || {
        // a panic still reports back, so flags like `saving` are always cleared
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&sv))).unwrap_or_else(|_| Err(anyhow::anyhow!("Something went wrong (internal error)")));
        let _ = slint::invoke_from_event_loop(move || with(|a| done(a, r)));
    }));
}
/// Does settings `work` on the store thread (in order), then `done` with its result back on the UI thread.
fn bg<T: Send + 'static>(work: impl FnOnce(&Svc) -> Result<T> + Send + 'static, done: impl FnOnce(&mut App, Result<T>) + Send + 'static) {
    run_on(&STORE_Q, work, done)
}
/// The same for chat files, on their own thread.
fn bg_chats<T: Send + 'static>(work: impl FnOnce(&Svc) -> Result<T> + Send + 'static, done: impl FnOnce(&mut App, Result<T>) + Send + 'static) {
    run_on(&CHATS_Q, work, done)
}
/// Runs `f` with the app after the current event is handled (so it never runs inside another `with`).
fn later(f: impl FnOnce(&mut App) + 'static) {
    Timer::single_shot(Duration::ZERO, move || with(f));
}

fn ss(t: impl AsRef<str>) -> SharedString {
    SharedString::from(t.as_ref())
}
fn strings(v: impl IntoIterator<Item = String>) -> ModelRc<SharedString> {
    ModelRc::new(VecModel::from(v.into_iter().map(SharedString::from).collect::<Vec<_>>()))
}
fn model<T: Clone + 'static>(v: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(v))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn hex_color(h: &str) -> slint::Color {
    let c = |i| u8::from_str_radix(h.get(i..i + 2).unwrap_or("88"), 16).unwrap_or(0x88);
    slint::Color::from_rgb_u8(c(1), c(3), c(5))
}
/// #rrggbb from hue 0-360 and saturation/value 0-1.
pub fn hsv_hex(h: f32, s: f32, v: f32) -> String {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match (h / 60.0) as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    let to = |u: f32| ((u + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", to(r), to(g), to(b))
}
pub fn hex_hsv(hex: &str) -> (f32, f32, f32) {
    let c = hex_color(hex);
    let (r, g, b) = (c.red() as f32 / 255.0, c.green() as f32 / 255.0, c.blue() as f32 / 255.0);
    let max = r.max(g).max(b);
    let d = max - r.min(g).min(b);
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, if max == 0.0 { 0.0 } else { d / max }, max)
}

const NO_REASONING: &str = "This model didn't return any reasoning.";
const WAITING: &str = "Waiting for reasoning…";
const LEVELS: [(&str, &str, &str); 8] = [
    ("", "Disabled", "Send no reasoning field at all (legacy models like GPT-3.5)"),
    ("none", "None", "Reasoning off"),
    ("minimal", "Minimal", "Barely any thinking"),
    ("low", "Low", "Quick, light reasoning"),
    ("medium", "Medium", "Balanced"),
    ("high", "High", "Deeper reasoning"),
    ("xhigh", "Extra high", "Very deep, slower"),
    ("max", "Max", "Maximum effort, slowest"),
];
const FORMATS: [&str; 4] = ["auto", "openrouter", "openai", "thinking"];
const MODEL_CAP: usize = 200; // rendering hundreds of rows on every keystroke is slow; the count line tells the user to keep typing

/// Text from the stream waiting to be drawn: deltas are batched so a fast stream redraws once per frame.
#[derive(Default)]
struct Incoming {
    reasoning: String,
    content: String,
    scheduled: bool,
}

pub struct App {
    ui: AppWindow,
    msgs: Rc<VecModel<Msg>>,
    state: Value,    // the public settings view
    settings: Value, // the active profile plus the global reasoning level
    chat: Value,
    chat_list: Vec<Value>,
    busy: bool,
    pending: Vec<Attachment>,
    model_info: HashMap<String, ModelInfo>,
    model_options: Vec<(String, String)>, // (value, label) of the model select
    model_shown: Vec<String>,
    cancel: Option<CancellationToken>,
    incoming: Arc<Mutex<Incoming>>,
    reply_row: Option<usize>,
    armed: Option<String>,
    arm_timer: Timer,
    editing_persona: Option<String>,
    ps_timer: Timer,
    dup_source: Option<Value>,
    editing_id: Option<String>,
    key_dirty: bool,
    p_timer: Timer,
    prefs_dirty: bool,
    search_key_dirty: bool,
    search_load: u32,
    toast_timer: Timer,
    err_timer: Timer,
    #[cfg_attr(target_os = "android", allow(dead_code))] // files dropped on the window (desktop)
    drops: Vec<std::path::PathBuf>,
    converting: usize,              // attachment conversions still running; sending waits for them
    checkpoint: Option<Instant>,    // when the reply in progress was last saved
    ck_base: Option<Arc<Value>>,    // the chat as saved when the reply started; checkpoints add the reply so far to it
    ck_every: Duration,             // how often to checkpoint: big chats (attached images) less often
    ck_busy: bool,                  // a checkpoint is still being written; the next one waits
    unsaved: Vec<(u32, Value)>,     // model/reasoning patches not saved yet, oldest first; laid over `settings`
    patch_id: u32,
    models_gen: u32,                // the latest model fetch; older results are dropped
    saving: bool,                   // a dialog's Save is in flight; a second click does nothing
}

/// Lays patches that aren't saved yet over `set` (the active profile's settings), oldest first: effort is global, the
/// model choices only count for the profile they were made in.
fn overlay_unsaved(set: &mut Value, unsaved: &[(u32, Value)], active: &Value) {
    for (_, p) in unsaved {
        if let Some(e) = p.get("effort") {
            set["effort"] = e.clone();
        }
        if p.get("profileId") == Some(active) {
            for k in ["model", "noTools", "meta"] {
                if let Some(v) = p.get(k) {
                    set[k] = v.clone();
                }
            }
        }
    }
}
/// About how many bytes of text (attachments included) `v` holds; walks the strings, copies nothing.
fn text_bytes(v: &Value) -> usize {
    match v {
        Value::String(t) => t.len(),
        Value::Array(a) => a.iter().map(text_bytes).sum(),
        Value::Object(o) => o.values().map(text_bytes).sum(),
        _ => 0,
    }
}
/// How often to save a streaming reply: every 5 s, plus 5 s per MB of chat (each save rewrites the whole file), at most 60 s.
fn checkpoint_every(bytes: usize) -> Duration {
    Duration::from_secs((5 + 5 * bytes as u64 / 1_000_000).min(60))
}
fn new_chat(persona: &str) -> Value {
    json!({ "id": format!("{}{}", crate::core::profiles::base36(now() as u64), crate::core::profiles::rand36(6)), "title": "", "created": now(), "updated": now(), "personaId": persona, "messages": [] })
}

/// The user's text with `inline code` (same rule as renderer.js: a backtick pair on one line), as StyledText.
fn user_styled(text: &str) -> StyledText {
    StyledText::from_markdown(&user_md(text)).unwrap_or_else(|_| StyledText::from_plain_text(text))
}
fn user_md(text: &str) -> String {
    fn esc(out: &mut String, t: &str) {
        for c in t.chars() {
            match c {
                '\u{e541}' => {}
                c if c.is_ascii_punctuation() => {
                    out.push('\\');
                    out.push(c);
                }
                c => out.push(c),
            }
        }
    }
    static CODE: OnceLock<regex::Regex> = OnceLock::new();
    let re = CODE.get_or_init(|| regex::Regex::new("`([^`\n]+)`").unwrap());
    let (mut md, mut at) = (String::new(), 0);
    for m in re.find_iter(text) {
        esc(&mut md, &text[at..m.start()]);
        // a code span can't hold a backtick or the placeholder, and the regex already rules out the first
        md.push_str(&format!("`{}`", text[m.start() + 1..m.end() - 1].replace('\u{e541}', "")));
        at = m.end();
    }
    esc(&mut md, &text[at..]);
    md
}

/// A data URL image as a small Slint image, for chips.
fn thumb(url: &str) -> slint::Image {
    use base64::Engine;
    let img = url
        .find(',')
        .and_then(|i| base64::engine::general_purpose::STANDARD.decode(&url[i + 1..]).ok())
        .and_then(|b| image::load_from_memory(&b).ok())
        .map(|i| i.thumbnail(360, 360).to_rgba8());
    match img {
        Some(i) => {
            let (w, h) = i.dimensions();
            slint::Image::from_rgba8(slint::SharedPixelBuffer::clone_from_slice(i.as_raw(), w, h))
        }
        None => slint::Image::default(),
    }
}
fn chip(name: &str, size: u64, image_url: Option<&str>) -> AttChip {
    AttChip { name: ss(name), size: ss(fmt_size(size)), is_image: image_url.is_some(), img: image_url.map(thumb).unwrap_or_default() }
}

fn styled(md: &str, plain: &str) -> StyledText {
    StyledText::from_markdown(md).unwrap_or_else(|_| StyledText::from_plain_text(plain))
}
/// A reply's display blocks for the Slint view.
fn md_blocks(text: &str, r: Render) -> Vec<MdBlock> {
    let bs = std::panic::catch_unwind(|| markdown::blocks(text, r)).unwrap_or_else(|_| vec![Block::Plain(text.into())]); // a renderer bug must never lose the reply
    bs.into_iter()
        .map(|b| {
            let mut m = MdBlock::default();
            match b {
                Block::Text { md, plain, level, indent, bullet, quote } => {
                    m.text = styled(&md, &plain);
                    m.plain = ss(plain);
                    m.level = level as i32;
                    m.indent = indent as i32;
                    m.bullet = ss(bullet);
                    m.quote = quote as i32;
                }
                Block::Code { lang, code } => {
                    m.kind = 1;
                    m.preview = r.html && matches!(lang.to_ascii_lowercase().as_str(), "html" | "htm" | "svg");
                    m.lang = ss(lang);
                    m.code = ss(code);
                }
                Block::Table { rows } => {
                    m.kind = 2;
                    m.cols = rows.iter().map(Vec::len).max().unwrap_or(1) as i32;
                    m.rows = model(rows.into_iter().map(|r| TableRow { cells: model(r.iter().map(|(md, p)| styled(md, p)).collect()) }).collect());
                }
                Block::Rule => m.kind = 3,
                Block::Html(h) => {
                    m.kind = 4;
                    m.lang = ss("html");
                    m.code = ss(h);
                    m.preview = true;
                }
                Block::Plain(t) => {
                    m.kind = 5;
                    m.plain = ss(t);
                }
            }
            m
        })
        .collect()
}

impl App {
    fn render(&self) -> Render {
        Render::from_value(&self.state["render"])
    }

    // ---- small pieces ----
    fn toast(&mut self, text: &str) {
        self.ui.set_toast_text(ss(text));
        self.ui.set_toast_shown(true);
        self.toast_timer.start(TimerMode::SingleShot, Duration::from_millis(1800), || with(|a| a.ui.set_toast_shown(false)));
    }
    /// Red pop-up for failures; long server messages stay a little longer so they can be read.
    fn show_error(&mut self, text: &str) {
        self.ui.set_err_text(ss(text));
        self.ui.set_err_shown(true);
        let ms = (3500 + text.chars().count() as u64 * 25).min(8000);
        self.err_timer.start(TimerMode::SingleShot, Duration::from_millis(ms), || with(|a| a.ui.set_err_shown(false)));
    }
    fn copy(&mut self, text: &str) {
        match platform::copy_text(text) {
            Ok(()) => self.toast("Copied"),
            Err(_) => self.toast("Copy failed"),
        }
    }
    fn apply_theme(&self, t: &Value) {
        let (a1, a2) = shared::theme_colors(t);
        let th = self.ui.global::<Theme>();
        th.set_a1(hex_color(&a1));
        th.set_a2(hex_color(&a2));
    }
    fn focus_input(&self) {
        self.ui.invoke_focus_input();
    }
    fn scroll_down(&self) {
        // shortcut: wrapped text settles its height over a frame or two, so scroll again once it has; a layout-done hook would be exact
        for ms in [16, 150] {
            let w = self.ui.as_weak();
            Timer::single_shot(Duration::from_millis(ms), move || {
                if let Some(ui) = w.upgrade() {
                    ui.invoke_scroll_bottom();
                }
            });
        }
    }

    /// `settings` is a flat view of the active profile plus the global reasoning level.
    fn apply_state(&mut self, st: Value) {
        self.state = st;
        let st = &self.state;
        let mut set = arr(&st["profiles"]).into_iter().find(|p| p["id"] == st["activeId"]).unwrap_or(json!({}));
        set["effort"] = st["effort"].clone();
        overlay_unsaved(&mut set, &self.unsaved, &st["activeId"]);
        self.settings = set;
        let profiles = arr(&st["profiles"]);
        self.ui.set_has_profiles(!profiles.is_empty());
        self.ui.set_profile_names(strings(profiles.iter().map(|p| s(p, "name").to_string())));
        self.ui.set_profile_index(profiles.iter().position(|p| p["id"] == st["activeId"]).map_or(0, |i| i as i32));
        self.apply_theme(&self.state["theme"].clone());
        let personas = arr(&self.state["personas"]);
        self.ui.set_persona_names(strings(personas.iter().map(|p| s(p, "name").to_string())));
        self.ui.set_persona_index(personas.iter().position(|p| p["id"] == self.state["personaId"]).unwrap_or(0) as i32);
    }
    /// A chat whose persona is missing or was deleted counts as Default.
    fn persona_id_of(&self, c: &Value) -> String {
        let id = s(c, "personaId");
        if arr(&self.state["personas"]).iter().any(|p| s(p, "id") == id) { id.into() } else { "default".into() }
    }
    fn persona_of(&self, c: &Value) -> Value {
        let id = self.persona_id_of(c);
        arr(&self.state["personas"]).into_iter().find(|p| s(p, "id") == id).unwrap_or(json!({}))
    }
    fn refresh_persona_ui(&self) {
        let bot = s(&self.persona_of(&self.chat), "bot").to_string();
        self.ui.set_placeholder(ss(format!("Message {}…", if bot.is_empty() { "JAVC Chatbot" } else { &bot })));
    }
    fn active(&self) -> String {
        s(&self.state, "activeId").to_string()
    }
    fn has_messages(&self) -> bool {
        self.chat["messages"].as_array().is_some_and(|m| !m.is_empty())
    }

    fn show_empty(&mut self) {
        self.msgs.set_vec(vec![]);
        let model = s(&self.settings, "model").to_string();
        let (line, action) = if self.active().is_empty() {
            ("Create a profile (endpoint + API key) to get started.".to_string(), 1)
        } else if !model.is_empty() {
            let ps = self.persona_of(&self.chat);
            let (bot, user) = (s(&ps, "bot"), s(&ps, "user"));
            let who = if bot.is_empty() { model } else if user.is_empty() { bot.into() } else { format!("{bot} as {user}") };
            (format!("Chatting with {who}"), 0)
        } else {
            ("Open settings and fetch models to get started.".to_string(), 2)
        };
        self.ui.set_empty_line(ss(line));
        self.ui.set_empty_action(action);
    }

    // ---- reasoning level ----
    fn tools_ok(&self) -> bool {
        // Models that say they lack `tools` get no search. After a restart modelInfo is empty, so fall back to the flag saved with the profile.
        match self.model_info.get(s(&self.settings, "model")) {
            Some(m) => m.tools,
            None => self.settings["noTools"] != true,
        }
    }
    fn render_levels(&mut self) {
        let model = s(&self.settings, "model").to_string();
        let def = self.model_info.get(&model).and_then(|m| m.default.clone()).unwrap_or_default();
        self.ui.set_side_model(ss(if model.is_empty() { "No model selected" } else { &model }));
        let effort = s(&self.settings, "effort").to_string();
        self.ui.set_levels(model_vec(LEVELS.iter().map(|(v, n, d)| Level {
            value: ss(v),
            name: ss(n),
            desc: ss(d),
            model_default: !v.is_empty() && *v == def,
            checked: *v == effort,
        })));
        let mut note = "Levels the model does not support are rejected and show an error.".to_string();
        if self.settings["thinkingSwitch"] == true {
            note += " On this provider, None turns thinking off.";
        }
        self.ui.set_side_note(ss(note));
    }
    /// Saves a model or reasoning choice. Until it's saved it stays in `unsaved`, so a state that comes back meanwhile
    /// (an older patch's, a theme save's) can't put the old choice back on screen; a failed save is shown and dropped.
    fn patch(&mut self, p: Value) {
        self.patch_id += 1;
        let id = self.patch_id;
        self.unsaved.push((id, p.clone()));
        bg(
            move |sv| sv.store.patch(&p),
            move |a, r| {
                a.unsaved.retain(|(i, _)| *i != id); // saved (now in the state) or failed (dropped)
                match r {
                    Ok(st) => a.apply_state(st),
                    Err(e) => {
                        a.show_error(&format!("Could not save the choice: {e}"));
                        a.apply_state(a.state.clone()); // back to what is saved, so the UI doesn't show an unsaved choice
                    }
                }
                a.render_model_btn();
                a.render_levels();
                if !a.has_messages() {
                    a.show_empty(); // its "Chatting with" line names the model
                }
            },
        );
    }
    fn pick_level(&mut self, v: &str) {
        self.settings["effort"] = v.into();
        self.patch(json!({ "effort": v }));
        self.render_levels();
        let name = LEVELS.iter().find(|l| l.0 == v).map_or("", |l| l.1);
        self.toast(&format!("Reasoning: {name}"));
    }

    // ---- model picker ----
    fn render_model_btn(&self) {
        let m = s(&self.settings, "model");
        let label = self.model_options.iter().find(|o| o.0 == m).map(|o| o.1.clone()).filter(|_| !m.is_empty());
        self.ui.set_model_label(ss(label.unwrap_or_else(|| "No model selected".into())));
    }
    fn open_model_pop(&mut self) {
        if self.active().is_empty() {
            return self.open_profile_dialog(true, None);
        }
        self.ui.set_model_query(ss(""));
        self.ui.set_model_pop(true);
        self.filter_models();
    }
    fn filter_models(&mut self) {
        let q = self.ui.get_model_query().trim().to_string();
        let all: Vec<String> = self.model_options.iter().map(|o| o.0.clone()).filter(|v| !v.is_empty()).collect();
        let hits: Vec<String> = shared::match_models(&all, &q).into_iter().cloned().collect();
        self.model_shown = hits.iter().take(MODEL_CAP).cloned().collect();
        let cur = s(&self.settings, "model").to_string();
        self.ui.set_model_rows(model_vec(self.model_shown.iter().map(|id| ModelRow { id: ss(id), current: *id == cur })));
        self.ui.set_model_note(ss(if all.is_empty() { "No models loaded yet. Click the refresh button to fetch them.".into() } else { format!("No models match “{q}”.") }));
        self.ui.set_model_count(ss(if all.is_empty() {
            String::new()
        } else {
            format!("{} of {} models{}", hits.len(), all.len(), if hits.len() > MODEL_CAP { format!(" · showing the first {MODEL_CAP}, keep typing to narrow") } else { String::new() })
        }));
        let hi = if q.split_whitespace().next().is_some() { 0 } else { self.model_shown.iter().position(|m| *m == cur).unwrap_or(0) };
        self.ui.set_model_hi(hi as i32);
    }
    fn model_key(&mut self, k: &str) {
        let n = self.model_shown.len() as i32;
        if n == 0 {
            return;
        }
        let hi = self.ui.get_model_hi();
        match k {
            "down" => self.ui.set_model_hi((hi + 1).rem_euclid(n)),
            "up" => self.ui.set_model_hi((hi - 1).rem_euclid(n)),
            "enter" => {
                if let Some(id) = self.model_shown.get(hi as usize).cloned() {
                    self.pick_model(&id);
                }
            }
            _ => {}
        }
    }
    fn pick_model(&mut self, id: &str) {
        self.settings["model"] = id.into();
        let no_tools = self.model_info.get(id).is_some_and(|m| !m.tools);
        self.settings["noTools"] = no_tools.into();
        let p = json!({ "model": id, "noTools": no_tools, "profileId": self.active() });
        self.patch(p);
        self.render_levels();
        if !self.has_messages() {
            self.show_empty();
        }
        self.render_model_btn();
        self.ui.set_model_pop(false);
    }
    fn set_models(&mut self, infos: Vec<ModelInfo>) {
        self.model_info = infos.iter().map(|m| (m.id.clone(), m.clone())).collect();
        let ids: Vec<String> = infos.iter().map(|m| m.id.clone()).collect();
        let saved = s(&self.settings, "model").to_string();
        if !ids.is_empty() {
            // remember whether the current model lacks tools, so that is still known after a restart
            let meta = infos.iter().any(|m| m.meta);
            self.settings["meta"] = meta.into();
            let mut p = json!({ "meta": meta, "profileId": self.active() });
            if let Some(k) = self.model_info.get(&saved) {
                self.settings["noTools"] = (!k.tools).into();
                p["noTools"] = (!k.tools).into();
            }
            self.patch(p);
        } // an empty list says nothing about the gateway
        let mut opts: Vec<(String, String)> = ids.iter().map(|i| (i.clone(), i.clone())).collect();
        // the saved choice is only ever changed by the user: keep it visible even if the provider stopped listing it
        if !saved.is_empty() && !ids.contains(&saved) {
            opts.insert(0, (saved.clone(), format!("{saved} (not in list)")));
        } else if saved.is_empty() {
            opts.insert(0, (String::new(), if ids.is_empty() { "No models returned" } else { "Select a model…" }.into()));
        }
        self.model_options = opts;
        self.render_levels();
        self.render_model_btn();
        if self.ui.get_model_pop() {
            self.filter_models();
        }
    }
    fn fetch_models(&mut self) {
        if self.active().is_empty() {
            return self.open_profile_dialog(true, None);
        }
        let pid = self.active();
        self.models_gen += 1;
        let fetch = self.models_gen;
        self.ui.set_fetching(true);
        let sv = svc();
        let pid2 = pid.clone();
        sv.rt.spawn(async move {
            let sv2 = svc();
            let r = async {
                let st = tokio::task::spawn_blocking(move || sv2.store.load(Some(&pid2), false)).await??;
                api::list_models_detailed(&svc().http, &st.endpoint, &st.key).await
            }
            .await;
            let _ = slint::invoke_from_event_loop(move || {
                with(|a| {
                    if fetch != a.models_gen {
                        return; // a newer fetch (after a profile edit or switch) owns the list now
                    }
                    a.ui.set_fetching(false);
                    if pid != a.active() {
                        return;
                    }
                    match r {
                        Ok(infos) => {
                            let n = infos.len();
                            a.set_models(infos);
                            a.toast(&format!("{n} model{} loaded", if n == 1 { "" } else { "s" }));
                            if !a.has_messages() {
                                a.show_empty();
                            }
                        }
                        Err(e) => a.show_error(&format!("Fetch models failed: {e}")),
                    }
                })
            });
        });
    }

    // ---- messages ----
    fn user_msg(text: &str, chips: Vec<AttChip>) -> Msg {
        Msg { user: true, text: ss(text), styled: user_styled(text), chips: model(chips), ..Default::default() }
    }
    fn assistant_done(&self, text: &str, reasoning: &str) -> Msg {
        let shown = if text.is_empty() { "(The model returned no text.)" } else { text };
        Msg {
            user: false,
            text: ss(text),
            blocks: model(md_blocks(shown, self.render())),
            reasoning: ss(if reasoning.is_empty() { NO_REASONING } else { reasoning }),
            no_reasoning: reasoning.is_empty(),
            done: true,
            ..Default::default()
        }
    }
    fn render_chat(&mut self) {
        if !self.has_messages() {
            return self.show_empty();
        }
        let mut rows = vec![];
        for m in arr(&self.chat["messages"]) {
            if m["role"] == "assistant" {
                rows.push(self.assistant_done(s(&m, "content"), s(&m, "reasoning")));
                continue;
            }
            let urls: Vec<String> = m["content"]
                .as_array()
                .map(|parts| parts.iter().filter(|p| p["type"] == "image_url").map(|p| s(&p["image_url"], "url").to_string()).collect())
                .unwrap_or_default();
            let mut k = 0;
            let chips = arr(&m["files"])
                .iter()
                .map(|f| {
                    let url = (f["kind"] == "image").then(|| {
                        k += 1;
                        urls.get(k - 1).cloned().unwrap_or_default()
                    });
                    chip(s(f, "name"), f["size"].as_u64().unwrap_or(0), url.as_deref())
                })
                .collect();
            rows.push(Self::user_msg(s(&m, "text"), chips));
        }
        self.msgs.set_vec(rows);
        self.scroll_down();
    }
    fn toggle_reasoning(&mut self, i: usize) {
        if let Some(mut m) = self.msgs.row_data(i) {
            m.open = !m.open;
            self.msgs.set_row_data(i, m);
        }
    }
    /// Draws what streamed in since the last frame.
    fn flush_incoming(&mut self) {
        let (r, c) = {
            let mut inc = self.incoming.lock().unwrap();
            inc.scheduled = false;
            (std::mem::take(&mut inc.reasoning), std::mem::take(&mut inc.content))
        };
        let Some(i) = self.reply_row else { return };
        let Some(mut m) = self.msgs.row_data(i) else { return };
        let stick = self.ui.invoke_near_bottom();
        if !r.is_empty() {
            if m.no_reasoning {
                m.reasoning = ss("");
            }
            m.reasoning = ss(format!("{}{r}", m.reasoning));
            m.no_reasoning = false;
            m.thinking = true;
        }
        if !c.is_empty() {
            m.text = ss(format!("{}{c}", m.text));
            m.waiting = false;
        }
        if !m.text.is_empty() && !self.ck_busy && self.checkpoint.is_some_and(|t| t.elapsed() >= self.ck_every)
            && let Some(base) = self.ck_base.clone()
        {
            // the reply so far, so closing the app mid-reply keeps it; the finished reply replaces it. The chat is
            // copied on the chats thread, not here: with attached images it can be megabytes.
            self.checkpoint = Some(Instant::now());
            self.ck_busy = true;
            let reply = json!({ "role": "assistant", "content": m.text.as_str(), "reasoning": if m.no_reasoning { "" } else { m.reasoning.as_str() } });
            bg_chats(
                move |sv| {
                    let mut chat = (*base).clone();
                    chat["messages"].as_array_mut().unwrap().push(reply);
                    sv.chats.save(&chat)
                },
                |a, _| a.ck_busy = false,
            );
        }
        self.msgs.set_row_data(i, m);
        if stick && !c.is_empty() {
            self.scroll_down();
        }
    }

    fn set_busy(&mut self, b: bool) {
        self.busy = b; // switching/creating/deleting chats is locked so a late reply can't land in the wrong chat
        self.ui.set_busy(b);
    }

    fn send(&mut self) {
        let text = self.ui.get_draft().trim().to_string();
        if (text.is_empty() && self.pending.is_empty()) || self.busy {
            return;
        }
        if self.active().is_empty() {
            return self.open_profile_dialog(true, None);
        }
        if s(&self.settings, "model").is_empty() {
            return self.show_error("Pick a model first: open the model picker (fetch models if the list is empty).");
        }
        if self.converting > 0 {
            return self.toast("Wait for the attachments to finish loading");
        }
        let atts = std::mem::take(&mut self.pending);
        self.render_chips();
        self.ui.set_draft(ss(""));
        if !self.has_messages() {
            self.msgs.set_vec(vec![]);
        }
        let chips = atts.iter().map(|a| chip(&a.name, a.size, if let AttKind::Image(u) = &a.kind { Some(u.as_str()) } else { None })).collect();
        self.msgs.push(Self::user_msg(&text, chips));
        let files: Vec<Value> = atts.iter().map(|a| json!({ "name": a.name, "size": a.size, "kind": if matches!(a.kind, AttKind::Image(_)) { "image" } else { "text" } })).collect();
        self.chat["messages"].as_array_mut().unwrap().push(json!({ "role": "user", "content": shared::build_content(&text, &atts), "text": text, "files": files }));
        // saved before the request, so closing the app mid-reply can't lose what was sent
        if s(&self.chat, "title").is_empty() {
            let t = if !text.is_empty() { text.clone() } else { atts.first().map_or("New chat".into(), |a| a.name.clone()) };
            self.chat["title"] = t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect::<String>().into();
        }
        let prev_updated = std::mem::replace(&mut self.chat["updated"], now().into()); // put back if the turn fails
        let base = self.persist();
        self.ck_every = checkpoint_every(text_bytes(&base["messages"]));
        self.ck_base = Some(base);
        self.checkpoint = Some(Instant::now());
        self.msgs.push(Msg { reasoning: ss(WAITING), no_reasoning: true, waiting: true, ..Default::default() });
        self.reply_row = Some(self.msgs.row_count() - 1);
        self.scroll_down();
        self.set_busy(true);
        let messages = shared::request_messages(&self.chat, Some(&self.persona_of(&self.chat)), Some(self.render()));
        let want_search = self.tools_ok();
        // the profile and choices on screen, even if saving them is still queued: endpoint and model always match
        let (pid, model, effort) = (self.active(), s(&self.settings, "model").to_string(), s(&self.settings, "effort").to_string());
        let cancel = CancellationToken::new();
        self.cancel = Some(cancel.clone());
        *self.incoming.lock().unwrap() = Incoming::default();
        let inc = self.incoming.clone();
        svc().rt.spawn(async move {
            let r: Result<Reply> = async {
                let sv = svc();
                let st = tokio::task::spawn_blocking(move || sv.store.load(Some(&pid), want_search)).await??;
                let extra = api::reasoning_params(&st.endpoint, &effort, &st.format, st.meta);
                let echo_reasoning = api::echoes_reasoning(&st.endpoint, &st.format, st.meta);
                let search = if want_search { st.search.clone().map(|k| Search { echo_reasoning, ..Search::linkup(k) }) } else { None };
                let mut on_delta = |d: Delta| {
                    let mut i = inc.lock().unwrap();
                    i.reasoning += &d.reasoning;
                    i.content += &d.content;
                    if !i.scheduled {
                        i.scheduled = true;
                        let _ = slint::invoke_from_event_loop(|| with(|a| a.flush_incoming()));
                    }
                };
                api::chat_stream(&svc().http, &st.endpoint, &st.key, &model, messages, extra, &mut on_delta, &cancel, search.as_ref()).await
            }
            .await;
            let _ = slint::invoke_from_event_loop(move || with(|a| a.reply_finished(r, text, atts, prev_updated)));
        });
    }
    fn reply_finished(&mut self, r: Result<Reply>, text: String, atts: Vec<Attachment>, prev_updated: Value) {
        self.cancel = None;
        self.checkpoint = None;
        self.ck_base = None;
        let row = self.reply_row.take();
        match r {
            Ok(out) => {
                self.chat["messages"].as_array_mut().unwrap().push(json!({ "role": "assistant", "content": out.content, "reasoning": out.reasoning })); // reasoning is display-only, never sent back
                if let Some(i) = row {
                    let open = self.msgs.row_data(i).is_some_and(|m| m.open);
                    let mut m = self.assistant_done(&out.content, &out.reasoning);
                    m.open = open;
                    self.msgs.set_row_data(i, m);
                }
                self.scroll_down();
                self.chat["updated"] = now().into();
                self.persist();
                if let Some(e) = out.error {
                    self.show_error(&format!("Reply was cut off: {e}"));
                } else if out.stopped {
                    self.toast("Stopped");
                }
            }
            Err(e) => {
                // drop the failed turn (also from disk) and put the draft back in front of whatever was typed meanwhile
                self.chat["messages"].as_array_mut().unwrap().pop();
                self.chat["updated"] = prev_updated; // nothing was added, so the chat keeps its place in the history
                if self.has_messages() {
                    self.persist();
                } else {
                    self.chat["title"] = "".into(); // a chat that never got a reply isn't kept
                    let id = s(&self.chat, "id").to_string();
                    bg_chats(move |sv| sv.chats.remove(&id), |a, _| a.refresh_list(|_| {}));
                }
                let n = self.msgs.row_count();
                if n >= 2 {
                    self.msgs.remove(n - 1);
                    self.msgs.remove(n - 2);
                }
                if self.msgs.row_count() == 0 {
                    self.show_empty();
                }
                let draft = self.ui.get_draft().to_string();
                self.ui.set_draft(ss([text, draft].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n")));
                let mut all = atts;
                all.append(&mut self.pending);
                all.truncate(MAX_FILES);
                self.pending = all;
                self.render_chips();
                let msg = e.to_string();
                if msg == "Stopped" { self.toast("Stopped") } else { self.show_error(&msg) }
            }
        }
        self.set_busy(false);
        self.focus_input();
    }

    // ---- attachments ----
    fn render_chips(&self) {
        self.ui.set_pending(model_vec(self.pending.iter().map(|a| chip(&a.name, a.size, if let AttKind::Image(u) = &a.kind { Some(u.as_str()) } else { None }))));
    }
    /// Converts files into attachments off the UI thread (not on the store thread: a big PDF must not hold up saves).
    fn attach(&mut self, load: impl FnOnce() -> Vec<platform::Picked> + Send + 'static) {
        let room = MAX_FILES.saturating_sub(self.pending.len());
        self.converting += 1;
        svc().rt.spawn_blocking(move || {
            // a panic here would leave `converting` stuck and block sending
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let files = load();
                let (mut out, mut notes) = (vec![], vec![]);
                for (name, bytes) in &files {
                    if out.len() >= room {
                        notes.push(format!("Max {MAX_FILES} files per message"));
                        break;
                    }
                    match attach::attachment(name, bytes) {
                        Ok((a, note)) => {
                            out.push(a);
                            notes.extend(note);
                        }
                        Err(e) => notes.push(e),
                    }
                }
                (out, notes)
            }))
            .unwrap_or_else(|_| (vec![], vec!["Couldn't read the attachment".to_string()]));
            let _ = slint::invoke_from_event_loop(move || {
                with(|a| {
                    let (atts, notes) = r;
                    a.converting -= 1;
                    a.pending.extend(atts);
                    a.pending.truncate(MAX_FILES);
                    a.render_chips();
                    if let Some(n) = notes.last() {
                        a.toast(n);
                    }
                })
            });
        });
    }
    fn attach_paths(&mut self, paths: Vec<std::path::PathBuf>) {
        self.attach(move || platform::read_files(paths));
    }

    // ---- chat history ----
    /// Saves the open chat; returns the copy being saved.
    fn persist(&mut self) -> Arc<Value> {
        let chat = Arc::new(self.chat.clone());
        let saved = chat.clone();
        bg_chats(
            move |sv| {
                sv.chats.save(&chat)?;
                sv.chats.list()
            },
            |a, r| match r {
                Ok(l) => {
                    a.chat_list = l;
                    a.render_list();
                }
                Err(e) => a.show_error(&format!("Could not save chat: {e}")),
            },
        );
        saved
    }
    fn refresh_list(&mut self, then: impl FnOnce(&mut App) + Send + 'static) {
        bg_chats(
            |sv| sv.chats.list(),
            move |a, r| match r {
                Ok(l) => {
                    a.chat_list = l;
                    a.render_list();
                    then(a);
                }
                Err(e) => a.show_error(&format!("Could not load chats: {e}")),
            },
        );
    }
    fn start_new(&mut self) {
        if self.busy {
            return;
        }
        self.chat = new_chat(s(&self.state, "personaId"));
        self.show_empty();
        self.refresh_persona_ui();
        self.render_list();
        self.focus_input();
        if self.ui.get_narrow() {
            self.ui.set_hist_open(false);
        }
    }
    fn open_chat(&mut self, id: String) {
        if self.busy || id == s(&self.chat, "id") {
            return;
        }
        bg_chats(
            move |sv| sv.chats.load(&id),
            |a, r| match r {
                // a reply started while this loaded: it owns the open chat until it's done
                Ok(_) if a.busy => {}
                Ok(c) if !c["messages"].is_array() => a.show_error("Could not open chat: the file is damaged (no message list)"),
                Ok(c) => {
                    a.chat = c;
                    a.render_chat();
                    a.refresh_persona_ui();
                    a.render_list();
                    a.focus_input();
                    if a.ui.get_narrow() {
                        a.ui.set_hist_open(false);
                    }
                }
                Err(e) => a.show_error(&format!("Could not open chat: {e}")),
            },
        );
    }
    fn confirm_delete(&mut self, id: String) {
        if self.busy {
            return;
        }
        if self.armed.as_deref() != Some(&id) {
            // first click arms, second click within 3s deletes
            self.armed = Some(id);
            self.render_list();
            self.arm_timer.start(TimerMode::SingleShot, Duration::from_secs(3), || {
                with(|a| {
                    a.armed = None;
                    a.render_list();
                })
            });
            return;
        }
        self.armed = None;
        self.arm_timer.stop();
        bg_chats(
            move |sv| sv.chats.remove(&id).map(|_| id),
            |a, r| match r {
                Ok(id) => {
                    if id == s(&a.chat, "id") {
                        a.chat = new_chat(s(&a.state, "personaId"));
                        a.show_empty();
                        a.refresh_persona_ui();
                    }
                    a.refresh_list(|_| {});
                }
                Err(e) => a.show_error(&format!("Could not delete chat: {e}")),
            },
        );
    }
    fn render_list(&self) {
        use chrono::{Local, TimeZone};
        let today = Local::now().date_naive().and_hms_opt(0, 0, 0).and_then(|d| Local.from_local_datetime(&d).earliest()).map_or(0, |d| d.timestamp_millis());
        let day = 86_400_000;
        let group = |t: i64| {
            if t >= today {
                "Today"
            } else if t >= today - day {
                "Yesterday"
            } else if t >= today - 7 * day {
                "Previous 7 days"
            } else {
                "Older"
            }
        };
        let mut rows = vec![];
        let mut last = "";
        let pid = s(&self.state, "personaId").to_string();
        for c in self.chat_list.iter().filter(|c| self.persona_id_of(c) == pid) {
            let g = group(c["updated"].as_f64().unwrap_or(0.0) as i64);
            if g != last {
                rows.push(ChatRow { group: ss(g), ..Default::default() });
                last = g;
            }
            let title = s(c, "title");
            rows.push(ChatRow {
                id: ss(s(c, "id")),
                title: ss(if title.is_empty() { "New chat" } else { title }),
                active: c["id"] == self.chat["id"],
                armed: self.armed.as_deref() == Some(s(c, "id")),
                ..Default::default()
            });
        }
        if rows.is_empty() {
            let name = arr(&self.state["personas"]).into_iter().find(|p| p["id"] == self.state["personaId"]).map(|p| s(&p, "name").to_string());
            rows.push(ChatRow { group: ss(format!("No chats with {} yet", name.as_deref().unwrap_or("this persona"))), ..Default::default() });
        }
        self.ui.set_chats(model(rows));
    }

    /// Escape and the Android back button close whatever is on top. False when nothing was open.
    fn close_top(&mut self) -> bool {
        // Settings is the only dialog that opens another (the profile editor) on top of itself, so close any other one first.
        if self.ui.get_pdlg() {
            self.ui.set_pdlg(false);
        } else if self.ui.get_psdlg() {
            self.ui.set_psdlg(false);
        } else if self.ui.get_dupdlg() {
            self.ui.set_dupdlg(false);
        } else if self.ui.get_prefs() {
            self.ui.set_prefs(false);
            self.prefs_closed();
        } else if self.ui.get_side_open() {
            self.ui.set_side_open(false);
        } else if self.ui.get_model_pop() {
            self.ui.set_model_pop(false);
        } else if self.ui.get_narrow() && self.ui.get_hist_open() {
            self.ui.set_hist_open(false);
        } else {
            return false;
        }
        true
    }

    // ---- personas ----
    /// The persona is fixed per chat; switching filters the list and opens a fresh chat if the open one belongs elsewhere.
    fn persona_changed(&mut self, st: Value) {
        self.apply_state(st);
        if self.persona_id_of(&self.chat.clone()) != s(&self.state, "personaId") {
            self.chat = new_chat(s(&self.state, "personaId"));
            self.show_empty();
        } else if !self.has_messages() {
            self.show_empty();
        }
        self.refresh_persona_ui();
        self.render_list();
    }
    fn select_persona(&mut self, id: String) {
        if self.busy {
            return;
        }
        bg(
            move |sv| sv.store.patch(&json!({ "personaId": id })),
            |a, r| match r {
                Ok(st) => a.persona_changed(st),
                Err(e) => {
                    a.show_error(&e.to_string());
                    a.apply_state(a.state.clone());
                }
            },
        );
    }
    fn open_persona_dialog(&mut self, is_new: bool) {
        let p = if is_new { json!({}) } else { arr(&self.state["personas"]).into_iter().find(|p| p["id"] == self.state["personaId"]).unwrap_or(json!({})) };
        self.editing_persona = (!is_new).then(|| s(&p, "id").to_string());
        self.ui.set_ps_new(is_new);
        self.ui.set_ps_name(ss(s(&p, "name")));
        self.ui.set_ps_user(ss(s(&p, "user")));
        self.ui.set_ps_bot(ss(s(&p, "bot")));
        self.ui.set_ps_prompt(ss(s(&p, "prompt")));
        self.ui.set_ps_deletable(!is_new && s(&p, "id") != "default");
        self.ps_timer.stop();
        self.ui.set_ps_del_armed(false);
        self.ui.set_ps_err(ss(""));
        self.ui.set_psdlg(true);
    }
    fn ps_save(&mut self) {
        if std::mem::replace(&mut self.saving, true) {
            return;
        }
        self.ui.set_ps_err(ss(""));
        let (id, name, user, bot, prompt) =
            (self.editing_persona.clone(), self.ui.get_ps_name().to_string(), self.ui.get_ps_user().to_string(), self.ui.get_ps_bot().to_string(), self.ui.get_ps_prompt().to_string());
        bg(
            move |sv| sv.store.save_persona(id.as_deref(), &name, &user, &bot, &prompt),
            |a, r| match a.save_done(r) {
                Ok(st) => {
                    a.ui.set_psdlg(false);
                    a.persona_changed(st);
                    a.toast("Saved");
                }
                Err(e) => a.ui.set_ps_err(ss(e.to_string())),
            },
        );
    }
    fn ps_delete(&mut self) {
        if !self.ui.get_ps_del_armed() {
            // first click arms, second click within 3s deletes
            self.ui.set_ps_del_armed(true);
            self.ps_timer.start(TimerMode::SingleShot, Duration::from_secs(3), || with(|a| a.ui.set_ps_del_armed(false)));
            return;
        }
        let id = self.editing_persona.clone().unwrap_or_default();
        bg(
            move |sv| sv.store.delete_persona(&id),
            |a, r| match r {
                Ok(st) => {
                    a.ui.set_psdlg(false);
                    a.persona_changed(st);
                    a.toast("Persona deleted");
                }
                Err(e) => a.ui.set_ps_err(ss(e.to_string())),
            },
        );
    }

    // ---- duplicate a chat into another persona: a copy with a new id; the original stays where it is ----
    fn open_dup(&mut self, id: &str) {
        let Some(c) = self.chat_list.iter().find(|c| s(c, "id") == id).cloned() else { return };
        self.ui.set_dup_err(ss(""));
        let title = s(&c, "title");
        self.ui.set_dup_sub(ss(format!("Copy “{}” into:", if title.is_empty() { "New chat" } else { title })));
        let personas = arr(&self.state["personas"]);
        let own = self.persona_id_of(&c);
        let idx = personas.iter().position(|p| s(p, "id") != own).or_else(|| personas.iter().position(|p| s(p, "id") == own)).unwrap_or(0);
        self.ui.set_dup_index(idx as i32);
        self.dup_source = Some(c);
        self.ui.set_dupdlg(true);
    }
    fn dup_confirm(&mut self, idx: usize) {
        self.ui.set_dup_err(ss(""));
        let Some(src) = self.dup_source.clone() else { return };
        let Some(pid) = arr(&self.state["personas"]).get(idx).map(|p| s(p, "id").to_string()) else { return };
        if std::mem::replace(&mut self.saving, true) {
            return;
        }
        let fresh = new_chat(&pid);
        bg(
            move |sv| {
                let mut copy = sv.chats.load(s(&src, "id"))?;
                let t = s(&copy, "title");
                copy["title"] = format!("{} (copy)", if t.is_empty() { "New chat" } else { t }).into();
                for k in ["id", "created", "updated"] {
                    copy[k] = fresh[k].clone();
                }
                copy["personaId"] = pid.clone().into();
                sv.chats.save(&copy)?;
                let st = sv.store.patch(&json!({ "personaId": pid }))?;
                Ok((st, sv.chats.list()?, s(&copy, "id").to_string()))
            },
            |a, r| match a.save_done(r) {
                Ok((st, list, id)) => {
                    a.ui.set_dupdlg(false);
                    a.persona_changed(st);
                    a.chat_list = list;
                    a.render_list();
                    a.open_chat(id);
                    a.toast("Chat duplicated");
                }
                Err(e) => a.ui.set_dup_err(ss(e.to_string())),
            },
        );
    }

    // ---- profiles ----
    fn open_profile_dialog(&mut self, is_new: bool, id: Option<String>) {
        let id = id.unwrap_or_else(|| self.active());
        self.editing_id = (!is_new).then(|| id.clone());
        self.ui.set_pdlg_new(is_new);
        self.p_timer.stop();
        self.ui.set_p_del_armed(false);
        self.ui.set_p_err(ss(""));
        let p = if is_new { json!({}) } else { arr(&self.state["profiles"]).into_iter().find(|x| s(x, "id") == id).unwrap_or(json!({})) };
        self.ui.set_p_name(ss(s(&p, "name")));
        self.ui.set_p_endpoint(ss(s(&p, "endpoint")));
        self.ui.set_p_format(FORMATS.iter().position(|f| *f == s(&p, "format")).unwrap_or(0) as i32);
        self.ui.set_p_key_shown(false);
        self.ui.set_p_key(ss(""));
        self.key_dirty = false;
        if !is_new {
            // saving without typing a key keeps the stored one
            let opened = id.clone();
            bg(
                move |sv| sv.store.key(&id),
                move |a, r| {
                    // only into the dialog that asked: it may have been closed, or reopened on another profile
                    if !a.ui.get_pdlg() || a.editing_id.as_deref() != Some(&opened) {
                        return;
                    }
                    match r {
                        Ok(k) if !a.key_dirty => a.ui.set_p_key(ss(k)),
                        Ok(_) => {}
                        Err(e) => a.ui.set_p_err(ss(e.to_string())),
                    }
                },
            );
        }
        self.ui.set_pdlg(true);
    }
    /// Switching/saving/deleting a profile: reload everything that depends on the endpoint, then fetch its models.
    fn on_profile_changed(&mut self, st: Value) {
        self.apply_state(st);
        self.model_info.clear();
        let m = s(&self.settings, "model").to_string();
        self.model_options = vec![(m.clone(), if m.is_empty() { "No model selected".into() } else { m })];
        self.render_model_btn();
        self.ui.set_model_pop(false);
        self.render_levels();
        if !self.has_messages() {
            self.show_empty();
        }
        if self.active().is_empty() {
            return;
        }
        let ep = s(&self.settings, "endpoint");
        let local = regex::Regex::new(r"(?i)^https?://(localhost|127\.|\[::1\]|10\.|192\.168\.)").unwrap().is_match(ep);
        if self.settings["hasKey"] == true || local {
            self.fetch_models();
        } else {
            let n = s(&self.settings, "name").to_string();
            self.toast(&format!("{n}: add your API key in settings"));
        }
    }
    /// A new profile, or an edit to the active one, reloads models etc. Touching another profile only refreshes the lists.
    fn profile_saved(&mut self, st: Value, switched: bool) {
        if switched { self.on_profile_changed(st) } else { self.apply_state(st) }
        if self.ui.get_prefs() {
            self.render_profiles();
        }
    }
    fn p_template(&mut self, i: usize) {
        match arr(&self.state["templates"]).get(i) {
            Some(t) => {
                self.ui.set_p_name(ss(s(t, "name")));
                self.ui.set_p_endpoint(ss(s(t, "endpoint")));
            }
            None => {
                self.ui.set_p_name(ss(""));
                self.ui.set_p_endpoint(ss(""));
            }
        }
    }
    /// A dialog's save came back: allow the next click, and pass the result on.
    fn save_done<T>(&mut self, r: T) -> T {
        self.saving = false;
        r
    }
    fn p_save(&mut self) {
        if std::mem::replace(&mut self.saving, true) {
            return; // a second click while the first save runs would create the profile twice
        }
        self.ui.set_p_err(ss(""));
        let id = self.editing_id.clone();
        let (name, endpoint) = (self.ui.get_p_name().to_string(), self.ui.get_p_endpoint().to_string());
        let format = FORMATS.get(self.ui.get_p_format() as usize).copied().unwrap_or("auto");
        let key = self.key_dirty.then(|| self.ui.get_p_key().to_string()); // an untouched key field must never overwrite the stored key
        let switched = id.is_none() || id.as_deref() == Some(&self.active());
        bg(
            move |sv| sv.store.save_profile(id.as_deref(), &name, &endpoint, format, key.as_deref()),
            move |a, r| match a.save_done(r) {
                Ok(st) => {
                    a.ui.set_pdlg(false);
                    a.profile_saved(st, switched);
                    a.toast("Saved");
                }
                Err(e) => a.ui.set_p_err(ss(e.to_string())), // inline: toasts sit under the dialog
            },
        );
    }
    fn p_delete(&mut self) {
        if !self.ui.get_p_del_armed() {
            self.ui.set_p_del_armed(true);
            self.p_timer.start(TimerMode::SingleShot, Duration::from_secs(3), || with(|a| a.ui.set_p_del_armed(false)));
            return;
        }
        let id = self.editing_id.clone().unwrap_or_default();
        bg(
            move |sv| sv.store.delete_profile(&id),
            |a, r| match r {
                Ok(st) => {
                    a.ui.set_pdlg(false);
                    let switched = st["activeId"] != a.state["activeId"];
                    a.profile_saved(st, switched);
                    a.toast("Profile deleted");
                }
                Err(e) => a.ui.set_p_err(ss(e.to_string())),
            },
        );
    }
    fn select_profile(&mut self, i: usize) {
        let Some(id) = arr(&self.state["profiles"]).get(i).map(|p| s(p, "id").to_string()) else { return };
        bg(
            move |sv| sv.store.activate(&id),
            |a, r| match r {
                Ok(st) => a.on_profile_changed(st),
                Err(e) => {
                    a.show_error(&e.to_string());
                    a.apply_state(a.state.clone());
                }
            },
        );
    }

    // ---- settings dialog ----
    fn open_prefs(&mut self, pane: i32) {
        // shortcut: custom colors start from the current theme; they aren't remembered while a preset is active
        let (a1, a2) = shared::theme_colors(&self.state["theme"]);
        let ((h1, s1, v1), (h2, s2, v2)) = (hex_hsv(&a1), hex_hsv(&a2));
        self.ui.set_c1h(h1);
        self.ui.set_c1s(s1);
        self.ui.set_c1v(v1);
        self.ui.set_c2h(h2);
        self.ui.set_c2s(s2);
        self.ui.set_c2v(v2);
        self.render_themes();
        self.render_profiles();
        self.sync_replies();
        self.load_search_pane();
        self.ui.set_pane(pane);
        self.ui.set_prefs(true);
    }
    fn prefs_closed(&mut self) {
        if self.prefs_dirty && !self.busy && self.has_messages() {
            self.render_chat(); // shortcut: a reply that is still streaming keeps its old look until the chat is reopened
        }
        self.prefs_dirty = false;
        self.focus_input(); // Settings held the focus; give it back to the message box
    }
    fn custom(&self) -> Value {
        let u = &self.ui;
        json!({ "id": "custom", "a1": hsv_hex(u.get_c1h(), u.get_c1s(), u.get_c1v()), "a2": hsv_hex(u.get_c2h(), u.get_c2s(), u.get_c2v()) })
    }
    fn save_theme(&mut self, theme: Value) {
        self.apply_theme(&theme); // show it at once; the saved (validated) copy replaces it below
        bg(
            move |sv| sv.store.patch(&json!({ "theme": theme })),
            |a, r| {
                match r {
                    Ok(st) => a.apply_state(st),
                    Err(e) => {
                        a.show_error(&e.to_string());
                        a.apply_state(a.state.clone());
                    }
                }
                a.render_themes();
            },
        );
    }
    fn render_themes(&self) {
        let c = self.custom();
        let cur = s(&self.state["theme"], "id").to_string();
        let mut tiles: Vec<ThemeTile> =
            THEMES.iter().map(|t| ThemeTile { id: ss(t.id), name: ss(t.name), a1: hex_color(t.a1), a2: hex_color(t.a2), checked: t.id == cur }).collect();
        tiles.push(ThemeTile { id: ss("custom"), name: ss("Custom"), a1: hex_color(s(&c, "a1")), a2: hex_color(s(&c, "a2")), checked: cur == "custom" });
        self.ui.set_themes(model(tiles));
    }
    fn render_profiles(&self) {
        let rows = arr(&self.state["profiles"])
            .iter()
            .map(|p| {
                let host = url::Url::parse(s(p, "endpoint")).ok().and_then(|u| u.host_str().map(|h| u.port().map_or(h.into(), |pt| format!("{h}:{pt}")))).unwrap_or_else(|| s(p, "endpoint").into());
                ProfileRow { id: ss(s(p, "id")), name: ss(s(p, "name")), sub: ss(format!("{host}{}", if p["hasKey"] == true { "" } else { " · no API key" })), active: p["id"] == self.state["activeId"] }
            })
            .collect();
        self.ui.set_profiles(model(rows));
    }
    fn sync_replies(&self) {
        let r = self.render();
        self.ui.set_r_markdown(r.markdown);
        self.ui.set_r_html(r.html);
        self.ui.set_r_css(r.css);
        self.ui.set_r_js(r.js);
    }
    fn render_toggled(&mut self, k: String, on: bool) {
        bg(
            move |sv| sv.store.patch(&json!({ "render": { k: on } })),
            |a, r| {
                match r {
                    Ok(st) => {
                        a.apply_state(st);
                        a.prefs_dirty = true;
                    }
                    Err(e) => {
                        a.show_error(&e.to_string());
                        a.apply_state(a.state.clone());
                    }
                }
                a.sync_replies();
            },
        );
    }
    /// The key is fetched only when the pane opens, and an untouched field never overwrites the stored one.
    fn load_search_pane(&mut self) {
        self.search_load += 1;
        let mine = self.search_load;
        self.search_key_dirty = false;
        self.ui.set_search_key_shown(false);
        self.ui.set_search_err(ss(""));
        self.ui.set_search_on(self.state["search"]["enabled"] == true);
        self.ui.set_search_key(ss(""));
        let no_tools = !s(&self.settings, "model").is_empty() && !self.tools_ok();
        self.ui.set_search_note(ss(if no_tools { "The current model doesn't support tools, so it won't search." } else { "" }));
        if self.state["search"]["hasKey"] != true {
            return;
        }
        bg(
            |sv| sv.store.search_key(),
            move |a, r| {
                if mine != a.search_load || a.search_key_dirty {
                    return; // a newer load started, or the user already typed: don't overwrite their edit
                }
                match r {
                    Ok(k) => a.ui.set_search_key(ss(k)),
                    Err(e) => a.ui.set_search_err(ss(e.to_string())),
                }
            },
        );
    }
    fn search_toggled(&mut self, on: bool) {
        self.ui.set_search_err(ss(""));
        bg(
            move |sv| sv.store.save_search(Some(on), None),
            move |a, r| match r {
                Ok(st) => {
                    a.apply_state(st);
                    if on && a.state["search"]["hasKey"] != true {
                        a.ui.set_search_err(ss("Add your Linkup API key below, or searching will not start."));
                    }
                }
                Err(e) => {
                    a.ui.set_search_err(ss(e.to_string()));
                    a.ui.set_search_on(a.state["search"]["enabled"] == true);
                }
            },
        );
    }
    fn search_save(&mut self) {
        if !self.search_key_dirty {
            return;
        }
        self.ui.set_search_err(ss(""));
        let sent = self.ui.get_search_key().to_string();
        let s2 = sent.clone();
        bg(
            move |sv| sv.store.save_search(None, Some(&s2)),
            move |a, r| match r {
                Ok(st) => {
                    a.apply_state(st);
                    if a.ui.get_search_key() == sent.as_str() {
                        a.search_key_dirty = false; // typed again while saving: stays unsaved
                    }
                    a.toast(if sent.trim().is_empty() { "Key removed" } else { "Key saved" });
                }
                Err(e) => a.ui.set_search_err(ss(e.to_string())),
            },
        );
    }
}

fn model_vec<T: Clone + 'static>(it: impl Iterator<Item = T>) -> ModelRc<T> {
    model(it.collect())
}

/// Starts the services: data folder, the move from the old folder, the stores and the runtime.
/// Escape and Android's back button: close the top layer; with nothing open, hide the app (Android; nothing on the desktop).
pub fn back() -> bool {
    let mut closed = false;
    with(|a| closed = a.close_top());
    if !closed {
        platform::minimize();
    }
    closed
}

pub fn init_services(dir: std::path::PathBuf, legacy: Option<std::path::PathBuf>) {
    if let Some(from) = legacy {
        // the app was called "chatbot" before the JAVC rename; bring its settings and chats along
        match migrate_legacy(&from, &dir) {
            Ok(moved) if !moved.is_empty() => eprintln!("Moved from the old chatbot folder: {}", moved.join(", ")),
            Err(e) => eprintln!("Could not move data from the old chatbot folder: {e}"),
            _ => {}
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    let _ = SVC.set(Arc::new(Svc {
        store: Store::new(Disk::new(&dir), platform::crypto()),
        chats: Chats::new(Disk::new(dir.join("chats"))),
        http: api::client(),
        rt,
        dir,
    }));
}

fn ui_file() -> std::path::PathBuf {
    svc().dir.join("ui.json")
}
fn saved_hist() -> bool {
    std::fs::read_to_string(ui_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_none_or(|v| v["hist"] != false)
}

/// Android: the clipboard refused a copy that was already reported as "Copied" (it happens later, on the Java UI thread).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn copy_failed() {
    let _ = slint::invoke_from_event_loop(|| {
        with(|a| {
            a.ui.set_toast_shown(false);
            a.show_error("Couldn't copy: the text is too large for the clipboard");
        })
    });
}

/// Builds the window and wires every callback. The caller runs the event loop.
pub fn build() -> Result<AppWindow> {
    let ui = AppWindow::new()?;
    ui.set_touch(platform::TOUCH);
    let msgs = Rc::new(VecModel::<Msg>::default());
    ui.set_msgs(ModelRc::from(msgs.clone()));
    let app = App {
        ui: ui.clone_strong(),
        msgs,
        state: json!({ "profiles": [], "personas": [], "render": {}, "theme": { "id": "aurora" }, "search": {} }),
        settings: json!({}),
        chat: new_chat("default"),
        chat_list: vec![],
        busy: false,
        pending: vec![],
        model_info: HashMap::new(),
        model_options: vec![(String::new(), "No model selected".into())],
        model_shown: vec![],
        cancel: None,
        incoming: Arc::default(),
        reply_row: None,
        armed: None,
        arm_timer: Timer::default(),
        editing_persona: None,
        ps_timer: Timer::default(),
        dup_source: None,
        editing_id: None,
        key_dirty: false,
        p_timer: Timer::default(),
        prefs_dirty: false,
        search_key_dirty: false,
        search_load: 0,
        toast_timer: Timer::default(),
        err_timer: Timer::default(),
        drops: vec![],
        converting: 0,
        checkpoint: None,
        ck_base: None,
        ck_every: Duration::from_secs(5),
        ck_busy: false,
        unsaved: vec![],
        patch_id: 0,
        models_gen: 0,
        saving: false,
    };
    APP.with(|a| *a.borrow_mut() = Some(app));

    let c = ui.global::<Chat>();
    c.on_copy(|t| later(move |a| a.copy(&t)));
    c.on_open_url(|u| platform::open_url(&u));
    c.on_toggle_reasoning(|i| with(|a| a.toggle_reasoning(i as usize)));
    c.on_preview(|html| {
        with(|a| {
            if html.len() > shared::RICH_MAX {
                return a.show_error("Could not display this content: This content is too large to display");
            }
            let r = a.render();
            let dark = a.ui.global::<Theme>().get_dark();
            let color = if dark { "#ecedf2" } else { "#1a1b22" };
            let (doc, csp) = shared::rich_doc(&html, color, if dark { "dark" } else { "light" }, r.css, r.js);
            if let Err(e) = platform::preview(&doc, &csp) {
                a.show_error(&format!("Could not display this content: {e}"));
            }
        })
    });

    ui.on_profile_selected(|i| with(|a| a.select_profile(i as usize)));
    ui.on_add_profile(|| with(|a| a.open_profile_dialog(true, None)));
    ui.on_fetch_models(|| with(|a| a.fetch_models()));
    ui.on_new_chat(|| with(|a| a.start_new()));
    ui.on_gear(|| with(|a| a.open_prefs(if a.active().is_empty() { 1 } else { 0 })));
    ui.on_hist_toggled(|open| {
        let _ = std::fs::write(ui_file(), json!({ "hist": open }).to_string());
    });
    ui.on_persona_selected(|i| {
        with(|a| {
            if let Some(id) = arr(&a.state["personas"]).get(i as usize).map(|p| s(p, "id").to_string()) {
                a.select_persona(id);
            }
        })
    });
    ui.on_new_persona(|| with(|a| a.open_persona_dialog(true)));
    ui.on_edit_persona(|| with(|a| a.open_persona_dialog(false)));
    ui.on_open_chat(|id| with(|a| a.open_chat(id.into())));
    ui.on_delete_chat(|id| with(|a| a.confirm_delete(id.into())));
    ui.on_dup_chat(|id| with(|a| a.open_dup(&id)));
    ui.on_empty_clicked(|| {
        with(|a| match a.ui.get_empty_action() {
            1 => a.open_profile_dialog(true, None),
            2 => a.open_profile_dialog(a.active().is_empty(), None),
            _ => {}
        })
    });
    ui.on_send(|| with(|a| a.send()));
    ui.on_stop(|| {
        with(|a| {
            if let Some(c) = &a.cancel {
                c.cancel();
            }
        })
    });
    ui.on_attach(|| {
        platform::pick_files(|files| {
            let _ = slint::invoke_from_event_loop(move || with(|a| a.attach(move || files)));
        })
    });
    ui.on_remove_pending(|i| {
        with(|a| {
            if (i as usize) < a.pending.len() {
                a.pending.remove(i as usize);
                a.render_chips();
            }
        })
    });
    ui.on_open_model_pop(|| with(|a| a.open_model_pop()));
    ui.on_model_query_edited(|_| with(|a| a.filter_models()));
    ui.on_pick_model(|id| with(|a| a.pick_model(&id)));
    ui.on_model_key(|k| with(|a| a.model_key(&k)));
    ui.on_pick_level(|v| with(|a| a.pick_level(&v)));
    ui.on_p_template(|i| with(|a| a.p_template(i as usize)));
    ui.on_p_key_edited(|| with(|a| a.key_dirty = true));
    ui.on_p_save(|| with(|a| a.p_save()));
    ui.on_p_delete(|| with(|a| a.p_delete()));
    ui.on_ps_save(|| with(|a| a.ps_save()));
    ui.on_ps_delete(|| with(|a| a.ps_delete()));
    ui.on_dup_confirm(|i| with(|a| a.dup_confirm(i as usize)));
    ui.on_pick_theme(|id| {
        with(|a| {
            let t = if id == "custom" { a.custom() } else { json!({ "id": id.as_str() }) };
            a.save_theme(t);
        })
    });
    ui.on_custom_moved(|| {
        with(|a| {
            let c = a.custom(); // live preview while dragging; saved when the picker is released
            a.apply_theme(&c);
            a.render_themes();
        })
    });
    ui.on_custom_committed(|| {
        with(|a| {
            let c = a.custom();
            a.save_theme(c);
        })
    });
    ui.on_edit_profile(|id| with(|a| a.open_profile_dialog(false, Some(id.into()))));
    ui.on_search_toggled(|on| with(|a| a.search_toggled(on)));
    ui.on_search_key_edited(|| with(|a| a.search_key_dirty = true));
    ui.on_search_save(|| with(|a| a.search_save()));
    ui.on_render_toggled(|k, on| with(|a| a.render_toggled(k.into(), on)));
    ui.on_prefs_closed(|| with(|a| a.prefs_closed()));
    ui.on_close_top(back);

    // Files dragged onto the window (winit reports one event per file, so they're gathered for a moment first).
    #[cfg(not(target_os = "android"))]
    {
        use slint::winit_030::{EventResult, WinitWindowAccessor, winit::event::WindowEvent};
        ui.window().on_winit_window_event(|_, ev| {
            match ev {
                WindowEvent::HoveredFile(_) => with(|a| a.ui.set_dropping(true)),
                WindowEvent::HoveredFileCancelled => with(|a| a.ui.set_dropping(false)),
                WindowEvent::DroppedFile(p) => {
                    let p = p.clone();
                    with(|a| {
                        a.ui.set_dropping(false);
                        a.drops.push(p);
                    });
                    Timer::single_shot(Duration::from_millis(60), || {
                        with(|a| {
                            let d = std::mem::take(&mut a.drops);
                            if !d.is_empty() {
                                a.attach_paths(d);
                            }
                        })
                    });
                }
                _ => return EventResult::Propagate,
            }
            EventResult::PreventDefault
        });
    }

    // shortcut: the window's size isn't known yet, so a window that starts narrow opens with the drawer showing
    ui.set_hist_open(!platform::TOUCH && saved_hist());
    // start-up: read the settings; a read error leaves the file alone, so say so rather than start empty
    bg(
        |sv| Ok((sv.store.get(), sv.store.take_notice())),
        |a, r| {
            let (first, notice) = r.unwrap();
            let first = match first {
                Ok(f) => f,
                Err(e) => return a.show_error(&format!("Could not read your settings: {e}. Close the app and open it again.")),
            };
            a.apply_state(first);
            a.ui.set_templates(model(
                arr(&a.state["templates"]).iter().map(|t| Opt { id: ss(s(t, "id")), name: ss(s(t, "name")) }).chain([Opt { id: ss("custom"), name: ss("Custom") }]).collect(),
            ));
            a.chat = new_chat(s(&a.state, "personaId"));
            a.refresh_persona_ui();
            let m = s(&a.settings, "model").to_string();
            if !m.is_empty() {
                a.model_options = vec![(m.clone(), m)];
            }
            a.render_model_btn();
            a.show_empty();
            a.render_levels();
            a.refresh_list(|_| {});
            if a.active().is_empty() {
                a.open_profile_dialog(true, None);
                if !notice.is_empty() {
                    a.ui.set_p_err(ss(notice)); // toasts sit under the dialog
                }
            } else {
                a.focus_input();
                if !notice.is_empty() {
                    a.show_error(&notice);
                }
            }
        },
    );
    Ok(ui)
}

/// One step of the self-test: `act` runs once, then `check` is polled every 100 ms until it gives a result.
type Check = Box<dyn Fn(&App) -> Option<Result<(), String>>>;
struct Step {
    name: &'static str,
    act: Box<dyn FnOnce(&mut App)>,
    check: Check,
    tries: u32,
}
fn step(name: &'static str, act: impl FnOnce(&mut App) + 'static, check: impl Fn(&App) -> Option<Result<(), String>> + 'static) -> Step {
    Step { name, act: Box::new(act), check: Box::new(check), tries: 150 }
}
fn run_steps(mut steps: std::collections::VecDeque<Step>, done: Box<dyn FnOnce(Result<(), String>)>) {
    let Some(st) = steps.pop_front() else { return done(Ok(())) };
    with(st.act);
    fn poll(name: &'static str, check: Check, left: u32, steps: std::collections::VecDeque<Step>, done: Box<dyn FnOnce(Result<(), String>)>) {
        Timer::single_shot(Duration::from_millis(100), move || {
            let mut r = None;
            with(|a| r = check(a));
            match r {
                Some(Ok(())) => run_steps(steps, done),
                Some(Err(e)) => done(Err(format!("{name}: {e}"))),
                None if left == 0 => done(Err(format!("{name}: timed out"))),
                None => poll(name, check, left - 1, steps, done),
            }
        });
    }
    poll(st.name, st.check, st.tries, steps, done);
}
fn expect(ok: bool, why: impl FnOnce() -> String) -> Option<Result<(), String>> {
    Some(if ok { Ok(()) } else { Err(why()) })
}

/// Smoke test against rust/selftest/mock-api.mjs (JAVC_SELFTEST=1 on debug builds, or the Android debug intent extra):
/// drives the real controller through the key store, models, attachments, a streamed reply, Stop, and the saved chat,
/// then reports. Expects one profile pointing at the mock API; it saves a test key into that profile.
pub fn self_test(done: impl FnOnce(Result<(), String>) + 'static, files: Vec<std::path::PathBuf>) {
    const KEY: &str = "sk-selftest-123";
    let n_files = files.len();
    let steps = vec![
        step("settings", |_| {}, |a| (!a.active().is_empty()).then_some(Ok(()))),
        step(
            "key store",
            |a| {
                // a real round trip through this platform's key encryption (keyring / Android Keystore)
                let (sv, id) = (svc(), a.active());
                let p = arr(&a.state["profiles"]).into_iter().find(|p| s(p, "id") == id).unwrap_or_default();
                let r = sv.store.save_profile(Some(&id), s(&p, "name"), s(&p, "endpoint"), s(&p, "format"), Some(KEY)).and_then(|st| Ok((st, sv.store.key(&id)?)));
                match r {
                    Ok((st, k)) => {
                        a.apply_state(st);
                        a.settings["selftestKey"] = k.into();
                    }
                    Err(e) => a.settings["selftestKey"] = format!("error: {e}").into(),
                }
            },
            |a| {
                let raw = std::fs::read_to_string(svc().dir.join("settings.json")).unwrap_or_default();
                let enc = platform_crypto_available();
                expect(s(&a.settings, "selftestKey") == KEY && (!enc || (raw.contains("keyEnc") && !raw.contains(KEY))), || {
                    format!("key read back as {:?}; encrypted on disk: {}", s(&a.settings, "selftestKey"), raw.contains("keyEnc"))
                })
            },
        ),
        step("models", |a| a.fetch_models(), |a| (!a.model_info.is_empty()).then_some(Ok(()))),
        step(
            "attachments",
            move |a| {
                a.pick_model("mock-model");
                a.attach_paths(files);
            },
            move |a| (a.pending.len() == n_files).then_some(Ok(())),
        ),
        step(
            "reply",
            |a| {
                a.ui.set_draft(ss("Say hi with `code`"));
                a.send();
            },
            move |a| {
                if a.busy || a.msgs.row_count() != 2 {
                    return None;
                }
                let m = a.msgs.row_data(1).unwrap();
                let sent = a.chat["messages"][0].to_string();
                Some(if !m.done || !m.text.contains("Hello from the mock API!") {
                    Err(format!("reply not rendered: {:?}", m.text))
                } else if m.reasoning != "Thinking about the answer…" {
                    Err(format!("reasoning: {:?}", m.reasoning))
                } else if !m.blocks.iter().any(|b| b.kind == 4) {
                    Err("the rich HTML block has no preview".into())
                } else if n_files > 0 && !(sent.contains("image_url") && sent.contains("data:image/png;base64,")) {
                    Err("the image wasn't sent".into())
                } else if !a.pending.is_empty() {
                    Err("attachments stayed in the composer".into())
                } else {
                    Ok(())
                })
            },
        ),
        step(
            "request",
            |a| {
                // what the mock actually received (serve.mjs lists it), not just what the app kept
                let base = s(&a.settings, "endpoint").trim_end_matches('/').trim_end_matches("/v1").to_string();
                *SENT.lock().unwrap() = None;
                svc().rt.spawn(async move {
                    let t = async { svc().http.get(format!("{base}/_requests")).send().await?.text().await }.await;
                    *SENT.lock().unwrap() = Some(t.map_err(|e| e.to_string()));
                });
            },
            move |_| {
                let t = SENT.lock().unwrap().clone()?;
                let reqs: Value = match t.and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
                    Ok(v) => v,
                    Err(e) => return Some(Err(format!("couldn't read the mock's requests: {e}"))),
                };
                let Some(r) = reqs.as_array().and_then(|a| a.iter().rev().find(|r| r["path"] == "/v1/chat/completions")) else {
                    return Some(Err("the mock got no chat request".into()));
                };
                let body = s(r, "body");
                Some(if s(r, "auth") != format!("Bearer {KEY}") {
                    Err(format!("auth header {:?}", s(r, "auth")))
                } else if !body.contains("Say hi with `code`") || !body.contains("\"mock-model\"") {
                    Err("the prompt or model wasn't in the request".into())
                } else if n_files > 0 && !body.contains("data:image/png;base64,") {
                    Err("the image wasn't in the request".into())
                } else {
                    Ok(())
                })
            },
        ),
        step(
            "stop",
            |a| {
                a.ui.set_draft(ss("Stop me"));
                a.send();
            },
            |a| {
                // stop as soon as some of the answer has arrived
                let m = a.reply_row.and_then(|i| a.msgs.row_data(i))?;
                if m.text.is_empty() {
                    return None;
                }
                a.cancel.as_ref().map(CancellationToken::cancel);
                Some(Ok(()))
            },
        ),
        step(
            "stopped reply",
            |_| {},
            |a| {
                if a.busy {
                    return None;
                }
                let n = a.chat["messages"].as_array().map_or(0, Vec::len);
                let last = s(&a.chat["messages"][3], "content").to_string();
                expect(n == 4 && last.starts_with("Hello") && !last.contains("Rich reply OK"), || format!("{n} messages, last {last:?}"))
            },
        ),
        step("saved chat", |_| {}, |a| {
            let id = s(&a.chat, "id");
            a.chat_list.iter().any(|c| s(c, "id") == id).then_some(Ok(()))
        }),
        step(
            "saved to disk",
            |_| {},
            |a| {
                let saved = svc().chats.load(s(&a.chat, "id"));
                let n = saved.as_ref().map_or(0, |c| c["messages"].as_array().map_or(0, Vec::len));
                (n == 4).then_some(Ok(()))
            },
        ),
    ];
    run_steps(steps.into(), Box::new(done));
}
static SENT: Mutex<Option<Result<String, String>>> = Mutex::new(None); // the self-test's "request" step
/// After installing over the old app (Android) or starting on its data: the saved key must still decrypt to `key` and the
/// saved chats must be listed. Reads only; changes nothing.
pub fn carry_over_test(key: String, done: impl FnOnce(Result<(), String>) + 'static) {
    let steps = vec![
        step("settings", |_| {}, |a| (!a.active().is_empty()).then_some(Ok(()))),
        step(
            "saved key",
            |a| {
                let r = svc().store.key(&a.active());
                a.settings["selftestKey"] = r.unwrap_or_else(|e| format!("error: {e}")).into();
            },
            move |a| expect(s(&a.settings, "selftestKey") == key, || format!("the key read back as {:?}", s(&a.settings, "selftestKey"))),
        ),
        step("saved chats", |_| {}, |a| (!a.chat_list.is_empty()).then_some(Ok(()))),
    ];
    run_steps(steps.into(), Box::new(done));
}
fn platform_crypto_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| platform::crypto().available())
}

/// For looking at the panels without input (JAVC_SELFTEST=hold): opens each one in turn, 1.5 s apart.
pub fn tour() {
    let steps: Vec<fn(&mut App)> = vec![
        |a| {
            if let Some(id) = a.chat_list.first().map(|c| s(c, "id").to_string()) {
                a.open_chat(id)
            }
        },
        |a| a.open_model_pop(),
        |a| {
            a.close_top();
            a.ui.set_side_open(true)
        },
        |a| {
            a.close_top();
            a.open_prefs(0)
        },
        |a| a.ui.set_pane(1),
        |a| a.ui.set_pane(2),
        |a| a.ui.set_pane(3),
        |a| a.open_profile_dialog(false, None),
        |a| {
            a.close_top();
            a.close_top();
            a.open_persona_dialog(false)
        },
        |a| {
            a.close_top();
            let id = s(&a.chat, "id").to_string();
            a.open_dup(&id)
        },
        |a| {
            a.close_top();
            a.show_error("An example error message")
        },
        |a| a.ui.invoke_light_mode(),
        |a| a.open_prefs(0),
        |a| {
            a.close_top();
            a.ui.set_hist_open(true);
            let id = a.chat_list.first().map(|c| s(c, "id").to_string()).unwrap_or_default();
            a.open_dup(&id)
        },
    ];
    for (i, f) in steps.into_iter().enumerate() {
        Timer::single_shot(Duration::from_millis(1500 * (i as u64 + 1)), move || with(f));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsv_round_trip() {
        for hex in ["#8b5cf6", "#3b82f6", "#e0510a", "#000000", "#ffffff", "#64748b"] {
            let (h, s, v) = hex_hsv(hex);
            assert_eq!(hsv_hex(h, s, v), hex);
        }
    }

    #[test]
    fn unsaved_choices_stay_on_screen() {
        // an older state comes back (model A) while the pick of B and a new effort are still queued
        let mut set = json!({ "model": "A", "effort": "low", "noTools": false });
        let unsaved = [(1, json!({ "effort": "high" })), (2, json!({ "model": "B", "noTools": true, "profileId": "p1" })), (3, json!({ "model": "C", "profileId": "p2" }))];
        overlay_unsaved(&mut set, &unsaved, &json!("p1"));
        assert_eq!(set, json!({ "model": "B", "effort": "high", "noTools": true })); // p2's pick doesn't apply to p1
        let mut set = json!({ "model": "A" });
        overlay_unsaved(&mut set, &[], &json!("p1"));
        assert_eq!(set, json!({ "model": "A" }));
    }

    #[test]
    fn checkpoints_slow_down_for_big_chats() {
        let chat = json!([{ "content": "abc" }, { "content": [{ "type": "image_url", "image_url": { "url": "x".repeat(10) } }] }]);
        assert_eq!(text_bytes(&chat), 3 + "image_url".len() + 10);
        assert_eq!(checkpoint_every(0), Duration::from_secs(5));
        assert_eq!(checkpoint_every(3_000_000), Duration::from_secs(20));
        assert_eq!(checkpoint_every(500_000_000), Duration::from_secs(60));
    }

    #[test]
    fn user_text_parses() {
        assert_eq!(user_md("a `b*` c."), "a `b*` c\\.");
        // the newline stays a line break: Slint's from_markdown starts a new paragraph at every soft break
        assert_eq!(user_md("two\nlines"), "two\nlines");
        for t in ["plain", "a `b` c", "*not bold* [x](y) <u>", "two\nlines `x`", "unclosed `tick", "``"] {
            assert!(StyledText::from_markdown(&user_md(t)).is_ok(), "{t}");
        }
    }
}
