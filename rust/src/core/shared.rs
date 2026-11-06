//! Pure helpers (port of lib.js): prompts, attachments, model search, rich-reply splitting and sandbox pages.
use base64::Engine;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

/// `v` as a string, or "" (like `p.x || ''`).
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One system message from a persona: who the bot is, who the user is, then the prompt with {{user}} / {{char}} filled in.
pub fn system_prompt(p: Option<&Value>) -> String {
    let Some(p) = p else { return String::new() };
    let (u, b) = (s(p, "user"), s(p, "bot"));
    let user = if u.is_empty() { "User" } else { u };
    let bot = if b.is_empty() { "Assistant" } else { b };
    let mut intro = vec![];
    if !b.is_empty() {
        intro.push(format!("You are {b}."));
    }
    if !u.is_empty() {
        intro.push(format!("The user's name is {u}."));
    }
    static USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\{\{\s*user\s*\}\}").unwrap());
    static CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\{\{\s*char\s*\}\}").unwrap());
    let body = USER.replace_all(s(p, "prompt"), regex::NoExpand(user));
    let body = CHAR.replace_all(&body, regex::NoExpand(bot));
    [intro.join(" "), body.trim().to_string()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n\n")
}

// ---- Rich replies: find the raw HTML blocks in a reply so they can be shown in a sandboxed frame; everything else is Markdown. ----
const START_TAGS: &[&str] = &[
    "!doctype", "html", "head", "body", "div", "section", "article", "main", "header", "footer", "nav", "aside", "style", "script", "svg",
    "canvas", "table", "form", "figure", "details", "center", "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "ul", "ol", "button", "input",
    "label", "link", "template", "video", "audio",
];
const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
const RAW: &[&str] = &["script", "style", "textarea", "title"]; // their contents are not markup
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<!--(?s:.*?)-->|<(/?)([a-zA-Z][A-Za-z0-9_:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>"#).unwrap());

/// Whether a block-starting tag (TAGSTART in lib.js) begins at byte `i`.
fn tag_start_at(text: &str, i: usize) -> bool {
    let rest = &text.as_bytes()[i.min(text.len())..];
    if rest.first() != Some(&b'<') {
        return false;
    }
    let rest = &rest[1..];
    START_TAGS.iter().any(|name| {
        rest.len() >= name.len()
            && rest[..name.len()].eq_ignore_ascii_case(name.as_bytes())
            && rest.get(name.len()).is_none_or(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
    })
}
/// REGION_START: up to three spaces, then a block tag, at the start of the line at `i`.
fn region_start(text: &str, i: usize) -> bool {
    let sp = text.as_bytes()[i..].iter().take(4).take_while(|c| **c == b' ').count();
    sp <= 3 && tag_start_at(text, i + sp)
}

/// Byte ranges of fenced code blocks.
fn fenced_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut open: Option<(u8, usize, usize)> = None; // (char, len, start)
    let mut pos = 0;
    for line in text.split('\n') {
        let sp = line.bytes().take(4).take_while(|c| *c == b' ').count();
        let fence = (sp <= 3)
            .then(|| {
                let t = &line[sp..];
                let ch = *t.as_bytes().first()?;
                if ch != b'`' && ch != b'~' {
                    return None;
                }
                let n = t.bytes().take_while(|c| *c == ch).count();
                (n >= 3).then_some((ch, n, sp + n))
            })
            .flatten();
        match (open, fence) {
            (Some((ch, len, start)), Some((c, n, end))) if c == ch && n >= len && line[end..].trim().is_empty() => {
                out.push((start, pos + line.len()));
                open = None;
            }
            (None, Some((c, n, _))) => open = Some((c, n, pos)),
            _ => {}
        }
        pos += line.len() + 1;
    }
    if let Some((_, _, start)) = open {
        out.push((start, text.len()));
    }
    out
}

/// Index just after the HTML block that starts at `start`. Directly following blocks (style, markup, script) are one page. An unclosed block runs to the end.
fn region_end(text: &str, start: usize) -> usize {
    let mut depth = 0usize;
    let mut pos = start;
    while let Some(m) = TAG.captures_at(text, pos) {
        let whole = m.get(0).unwrap();
        pos = whole.end();
        if whole.as_str().starts_with("<!--") {
            continue;
        }
        let close = !m[1].is_empty();
        let name = m[2].to_ascii_lowercase();
        let self_closing = m[3].trim_end().ends_with('/');
        if close {
            depth = depth.saturating_sub(1);
        } else if RAW.contains(&name.as_str()) && !self_closing {
            let end = Regex::new(&format!(r"(?i)</{name}\b[^>]*>")).unwrap();
            match end.find_at(text, pos) {
                Some(c) => pos = c.end(),
                None => return text.len(),
            }
        } else if !VOID.contains(&name.as_str()) && !self_closing {
            depth += 1;
        }
        if depth > 0 {
            continue;
        }
        let here = pos;
        let k = here + (text[here..].len() - text[here..].trim_start().len());
        if !tag_start_at(text, k) {
            return here;
        }
        pos = k;
    }
    text.len()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Md(String),
    Html(String),
}

/// Splits a reply into Markdown and raw HTML parts. HTML inside code fences stays Markdown.
pub fn split_rich(text: &str) -> Vec<Part> {
    let fences = fenced_ranges(text);
    let in_fence = |i: usize| fences.iter().any(|&(a, b)| i >= a && i < b);
    let mut parts = vec![];
    let (mut i, mut from) = (0, 0);
    while i < text.len() {
        let line_end = text[i..].find('\n').map_or(text.len(), |n| i + n);
        if region_start(&text[..line_end], i) && !in_fence(i) {
            let end = region_end(text, i);
            if i > from {
                parts.push(Part::Md(text[from..i].to_string()));
            }
            parts.push(Part::Html(text[i..end].trim().to_string()));
            from = end;
            i = end;
            continue;
        }
        i = line_end + 1;
    }
    if from < text.len() {
        parts.push(Part::Md(text[from..].to_string()));
    }
    parts.retain(|p| match p {
        Part::Html(h) => !h.is_empty(),
        Part::Md(t) => !t.trim().is_empty(),
    });
    parts
}

/// A CSS color from the page, or a neutral grey when it isn't a plain color value (so it can't break out of the style tag).
pub fn safe_color(c: &str) -> &str {
    static OK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_#(),.\s%/-]{1,60}$").unwrap());
    if OK.is_match(c) { c } else { "#888" }
}
pub const RESIZE: &str = r#"(()=>{const p=()=>parent.postMessage({richHeight:Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,document.body.scrollHeight))},"*");const o=new ResizeObserver(p);o.observe(document.documentElement);o.observe(document.body);addEventListener("load",p);p()})()"#;
fn sha(s: &str) -> String {
    format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(s.as_bytes())))
}
/// The page a rich block runs in: the model's HTML plus a script that reports the content height.
/// The preview window (desktop) and RichActivity (Android) serve `doc` with `csp` as its Content-Security-Policy.
/// css/js off => the CSP only allows our own <style> and resize <script> (by hash).
/// js off also blocks child frames/objects/embeds: a remote child document isn't covered by our script-src and would run its own scripts.
/// shortcut: with CSS off but JS on, scripts can still set element.style from JS (CSSOM isn't covered by CSP); fine for a display preference.
pub fn rich_doc(html: &str, color: &str, scheme: &str, css: bool, js: bool) -> (String, String) {
    let s = if scheme == "light" { "light" } else { "dark" };
    let style = format!(
        r#":root{{color-scheme:{s}}}html,body{{margin:0;background:transparent}}body{{color:{};font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}}"#,
        safe_color(color)
    );
    let doc = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="{s}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>{style}</style></head><body>{html}<script>{RESIZE}</script></body></html>"#
    );
    let mut csp = vec!["sandbox allow-scripts".to_string()];
    if !css {
        csp.push(format!("style-src {}", sha(&style)));
    }
    if !js {
        csp.push(format!("script-src {}; frame-src 'none'; object-src 'none'", sha(RESIZE)));
    }
    (doc, csp.join("; "))
}
pub const RICH_MAX: usize = 2_000_000;

/// The size of a w×h image scaled to fit in max×max, keeping its shape; never enlarged. The bool says whether it shrank.
pub fn fit_size(w: u32, h: u32, max: u32) -> (u32, u32, bool) {
    let s = (max as f64 / w.max(h) as f64).min(1.0);
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1), s < 1.0)
}

// Reply display toggles (all on by default). The system hint tells the model only what the user has switched on.
pub const RENDER_KEYS: [&str; 4] = ["markdown", "html", "css", "js"];
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Render {
    pub markdown: bool,
    pub html: bool,
    pub css: bool,
    pub js: bool,
}
impl Default for Render {
    fn default() -> Self {
        Render { markdown: true, html: true, css: true, js: true }
    }
}
impl Render {
    pub fn from_value(v: &Value) -> Self {
        let b = |k| v.get(k).and_then(Value::as_bool).unwrap_or(true);
        Render { markdown: b("markdown"), html: b("html"), css: b("css"), js: b("js") }
    }
}
pub fn render_hint(r: Render) -> String {
    if !r.markdown && !r.html {
        return "Display: your replies are shown as plain text. Do not use Markdown or HTML formatting.".into();
    }
    let mut out = vec![format!(
        "Display: your replies are {}",
        if r.markdown { "rendered as Markdown." } else { "shown as plain text, so do not use Markdown formatting." }
    )];
    if r.html {
        let extra: Vec<&str> = [r.css.then_some("CSS"), r.js.then_some("JavaScript")].into_iter().flatten().collect();
        out.push(format!(
            "You may also write raw HTML{} directly in a reply, starting each HTML block at the beginning of a line and not inside a code fence. It renders live in a sandboxed frame with internet access{}. Use it when visuals help, such as charts, diagrams, interactive demos or styled layouts, and keep ordinary answers in plain {}.{}",
            if extra.is_empty() { " only (CSS and JavaScript are switched off)".to_string() } else { format!(" with {}", extra.join(" and ")) },
            if r.js { ", so CDN libraries work" } else { "" },
            if r.markdown { "Markdown" } else { "text" },
            if r.markdown { " Show code the user should read rather than run in a fenced code block." } else { "" },
        ));
    }
    out.join(" ")
}

/// Accent gradients. 'aurora' is the default; a custom theme is {id: 'custom', a1, a2} with two #rrggbb colors.
pub struct Theme {
    pub id: &'static str,
    pub name: &'static str,
    pub a1: &'static str,
    pub a2: &'static str,
}
pub const THEMES: [Theme; 6] = [
    Theme { id: "aurora", name: "Aurora", a1: "#8b5cf6", a2: "#3b82f6" },
    Theme { id: "ocean", name: "Ocean", a1: "#0891b2", a2: "#2563eb" },
    Theme { id: "emerald", name: "Emerald", a1: "#059669", a2: "#0891b2" },
    Theme { id: "sunset", name: "Sunset", a1: "#e0510a", a2: "#db2777" },
    Theme { id: "rose", name: "Rose", a1: "#db2777", a2: "#7c3aed" },
    Theme { id: "graphite", name: "Graphite", a1: "#64748b", a2: "#334155" },
];
pub fn is_hex(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}
/// The normalized theme for a patch, or None when it isn't valid (callers ignore invalid input).
pub fn clean_theme(t: Option<&Value>) -> Option<Value> {
    let t = t?;
    let id = t.get("id")?.as_str()?;
    if THEMES.iter().any(|x| x.id == id) {
        return Some(json!({ "id": id }));
    }
    let (a1, a2) = (s(t, "a1"), s(t, "a2"));
    (id == "custom" && is_hex(a1) && is_hex(a2)).then(|| json!({ "id": "custom", "a1": a1.to_lowercase(), "a2": a2.to_lowercase() }))
}
/// The two accent colors of a theme (Aurora when it isn't valid).
pub fn theme_colors(t: &Value) -> (String, String) {
    let id = s(t, "id");
    if let Some(x) = THEMES.iter().find(|x| x.id == id) {
        return (x.a1.into(), x.a2.into());
    }
    match clean_theme(Some(t)) {
        Some(c) => (s(&c, "a1").into(), s(&c, "a2").into()),
        None => (THEMES[0].a1.into(), THEMES[0].a2.into()),
    }
}

/// Chat isolation: only this chat's messages go out, stripped of display-only fields (text, files, reasoning).
pub fn request_messages(chat: &Value, persona: Option<&Value>, render: Option<Render>) -> Vec<Value> {
    let mut msgs: Vec<Value> = chat["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    let mut o = Map::new();
                    for k in ["role", "content"] {
                        if let Some(v) = m.get(k) {
                            o.insert(k.into(), v.clone());
                        }
                    }
                    Value::Object(o)
                })
                .collect()
        })
        .unwrap_or_default();
    let sys: Vec<String> = [system_prompt(persona), render.map(render_hint).unwrap_or_default()].into_iter().filter(|x| !x.is_empty()).collect();
    if !sys.is_empty() {
        msgs.insert(0, json!({ "role": "system", "content": sys.join("\n\n") }));
    }
    msgs
}

/// An attachment: a text file (inlined) or an image (data URL).
#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub name: String,
    pub size: u64,
    pub kind: AttKind,
}
#[derive(Debug, Clone, PartialEq)]
pub enum AttKind {
    Text(String),
    Image(String),
}
/// Text files are inlined as fenced blocks; images become image_url parts.
pub fn build_content(text: &str, atts: &[Attachment]) -> Value {
    let mut body = vec![text.to_string()];
    for a in atts {
        if let AttKind::Text(t) = &a.kind {
            body.push(format!("[File: {}]\n```\n{t}\n```", a.name));
        }
    }
    let body = body.into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n\n");
    let imgs: Vec<&str> = atts.iter().filter_map(|a| if let AttKind::Image(u) = &a.kind { Some(u.as_str()) } else { None }).collect();
    if imgs.is_empty() {
        return Value::String(body);
    }
    let mut parts = vec![json!({ "type": "text", "text": if body.is_empty() { "See the attached image(s).".to_string() } else { body } })];
    parts.extend(imgs.into_iter().map(|u| json!({ "type": "image_url", "image_url": { "url": u } })));
    Value::Array(parts)
}

/// Every word must appear in the id, in any order, ignoring case.
pub fn match_models<'a>(ids: &'a [String], query: &str) -> Vec<&'a String> {
    let q = query.to_lowercase();
    let terms: Vec<&str> = q.split_whitespace().collect();
    ids.iter().filter(|id| terms.iter().all(|t| id.to_lowercase().contains(t))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_messages_isolates_chats_and_strips_display_fields() {
        let a = json!({ "messages": [{ "role": "user", "content": "alpha", "text": "alpha", "files": [] }, { "role": "assistant", "content": "A!", "reasoning": "secret" }] });
        let b = json!({ "messages": [{ "role": "user", "content": "beta" }] });
        assert_eq!(request_messages(&a, None, None), vec![json!({ "role": "user", "content": "alpha" }), json!({ "role": "assistant", "content": "A!" })]);
        assert_eq!(request_messages(&b, None, None), vec![json!({ "role": "user", "content": "beta" })]);
    }

    #[test]
    fn build_content_inlines_text_and_images() {
        assert_eq!(build_content("hi", &[]), json!("hi"));
        let t = Attachment { name: "a.txt".into(), size: 1, kind: AttKind::Text("x".into()) };
        assert_eq!(build_content("", &[t]), json!("[File: a.txt]\n```\nx\n```"));
        let i = Attachment { name: "i".into(), size: 1, kind: AttKind::Image("data:image/png;base64,AA".into()) };
        assert_eq!(
            build_content("", &[i]),
            json!([{ "type": "text", "text": "See the attached image(s)." }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } }])
        );
    }

    #[test]
    fn match_models_needs_every_word() {
        let ids: Vec<String> = ["openai/gpt-4o", "anthropic/claude-3", "meta/llama-3"].map(String::from).into();
        assert_eq!(match_models(&ids, "GPT 4o"), vec!["openai/gpt-4o"]);
        assert_eq!(match_models(&ids, "3 claude"), vec!["anthropic/claude-3"]);
        assert_eq!(match_models(&ids, "").len(), 3);
    }

    #[test]
    fn system_prompt_fills_names_and_placeholders() {
        assert_eq!(system_prompt(None), "");
        assert_eq!(system_prompt(Some(&json!({ "user": "", "bot": "", "prompt": "" }))), "");
        assert_eq!(
            system_prompt(Some(&json!({ "user": "Dalton", "bot": "Captain", "prompt": "Talk like {{char}} to {{ User }}." }))),
            "You are Captain. The user's name is Dalton.\n\nTalk like Captain to Dalton."
        );
        assert_eq!(system_prompt(Some(&json!({ "user": "", "bot": "", "prompt": "Hi {{user}}, I am {{CHAR}}." }))), "Hi User, I am Assistant.");
        assert_eq!(system_prompt(Some(&json!({ "user": "D", "bot": "", "prompt": "" }))), "The user's name is D.");
        assert_eq!(system_prompt(Some(&json!({ "user": "$&", "bot": "B", "prompt": "{{user}}" }))), "You are B. The user's name is $&.\n\n$&");
    }

    #[test]
    fn request_messages_puts_persona_first() {
        let a = json!({ "messages": [{ "role": "user", "content": "alpha" }] });
        let p = json!({ "user": "U", "bot": "B", "prompt": "x" });
        let m = request_messages(&a, Some(&p), None);
        assert_eq!(m[0], json!({ "role": "system", "content": "You are B. The user's name is U.\n\nx" }));
        assert_eq!(m[1..], [json!({ "role": "user", "content": "alpha" })]);
        let empty = json!({ "user": "", "bot": "", "prompt": "" });
        assert_eq!(request_messages(&a, Some(&empty), None).len(), 1);
    }

    fn kinds(t: &str) -> Vec<&'static str> {
        split_rich(t).iter().map(|p| if matches!(p, Part::Md(_)) { "md" } else { "html" }).collect()
    }
    #[test]
    fn split_rich_cases() {
        let t = "just **markdown** with <b>inline</b> and <kbd>K</kbd>";
        assert_eq!(split_rich(t), vec![Part::Md(t.into())]);
        let a = split_rich("Intro\n\n<div class=\"a\">\n  <p>one</p>\n\n  <p>two</p>\n</div>\n\nOutro");
        assert_eq!(a.len(), 3);
        let Part::Html(h) = &a[1] else { panic!() };
        assert!(h.starts_with("<div") && h.ends_with("</div>") && h.contains("two"));
        let b = split_rich("<style>.x{color:red}</style>\n<div class=x>hi</div>\n\n<script>var s = \"</div>\"; if (1 < 2) {}</script>\ndone");
        assert_eq!(b.len(), 2);
        let (Part::Html(h), Part::Md(m)) = (&b[0], &b[1]) else { panic!() };
        assert!(h.contains("<script>") && m.trim() == "done");
        assert_eq!(kinds("```html\n<div>shown as code</div>\n```\n"), ["md"]);
        assert_eq!(kinds("~~~\n<script>x</script>\n~~~\n\n<div>live</div>"), ["md", "html"]);
        assert_eq!(kinds("    <div>indented code</div>"), ["md"]);
        assert_eq!(kinds("text\n<div>never closed\nmore"), ["md", "html"]);
        assert_eq!(kinds("<svg width=10><circle r=1 /></svg>\n\ntail"), ["html", "md"]);
        assert_eq!(kinds("<!-- note -->\n<div>x</div>"), ["md", "html"]);
        assert_eq!(kinds("<pre>x</pre>"), ["html"]);
        assert_eq!(kinds("<preview>x</preview>"), ["md"]);
        assert!(split_rich("").is_empty());
    }

    #[test]
    fn render_hint_only_mentions_what_is_on() {
        let h = |f: fn(&mut Render)| {
            let mut r = Render::default();
            f(&mut r);
            render_hint(r)
        };
        let all = h(|_| {});
        assert!(all.contains("Markdown") && all.contains("HTML with CSS and JavaScript") && all.contains("CDN"));
        let nojs = h(|r| r.js = false);
        assert!(nojs.contains("HTML with CSS directly") && !nojs.contains("JavaScript") && !nojs.contains("CDN"));
        assert!(h(|r| {
            r.css = false;
            r.js = false
        })
        .contains("HTML only (CSS and JavaScript are switched off)"));
        let nohtml = h(|r| r.html = false);
        assert!(!nohtml.contains("HTML") && nohtml.contains("Markdown"));
        let nomd = h(|r| r.markdown = false);
        assert!(nomd.contains("plain text, so do not use Markdown"));
        assert!(all.contains("fenced code block") && !nomd.contains("fenced") && !nomd.contains("code block"));
        assert!(h(|r| {
            r.markdown = false;
            r.html = false
        })
        .contains("plain text. Do not use Markdown or HTML"));
    }

    #[test]
    fn request_messages_adds_hint_after_persona() {
        let chat = json!({ "messages": [{ "role": "user", "content": "hi", "text": "x" }] });
        assert_eq!(request_messages(&chat, None, None), vec![json!({ "role": "user", "content": "hi" })]);
        let all = Render::default();
        assert_eq!(request_messages(&chat, None, Some(all))[0], json!({ "role": "system", "content": render_hint(all) }));
        let p = json!({ "user": "", "bot": "B", "prompt": "p" });
        let sys = request_messages(&chat, Some(&p), Some(all))[0]["content"].as_str().unwrap().to_string();
        assert!(sys.starts_with("You are B.") && sys.ends_with(&render_hint(all)));
    }

    #[test]
    fn preset_themes_keep_white_text_readable() {
        let lum = |h: &str| {
            let c: Vec<f64> = [1, 3, 5]
                .iter()
                .map(|&i| u8::from_str_radix(&h[i..i + 2], 16).unwrap() as f64 / 255.0)
                .map(|v| if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) })
                .collect();
            0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        };
        let cw = |h: &str| 1.05 / (lum(h) + 0.05);
        let floor = cw(THEMES[0].a1).min(cw(THEMES[0].a2));
        for t in &THEMES {
            for c in [t.a1, t.a2] {
                assert!(cw(c) >= floor, "{} {c}", t.name);
            }
        }
    }

    #[test]
    fn rich_doc_color_and_scheme_cannot_break_out() {
        let (doc, csp) = rich_doc("<b>hi</b>", "red;}</style><script>alert(1)</script>", "evil", true, true);
        assert!(doc.contains("color:#888") && doc.contains("color-scheme:dark") && !doc.contains("alert(1)"));
        assert_eq!(csp, "sandbox allow-scripts");
        assert!(Regex::new(r"(?s)color:rgb\(1, 2, 3\).*<body>x<script>").unwrap().is_match(&rich_doc("x", "rgb(1, 2, 3)", "light", true, true).0));
        assert!(rich_doc("x", "#fff", "light", true, true).0.contains("content=\"light\""));
    }

    #[test]
    fn rich_doc_csp_hashes() {
        let (doc, csp) = rich_doc("<p>x</p>", "#fff", "dark", false, false);
        let style = Regex::new(r"<style>(.*?)</style>").unwrap().captures(&doc).unwrap()[1].to_string();
        let script = Regex::new(r"(?s)<script>(.*?)</script>").unwrap().captures(&doc).unwrap()[1].to_string();
        assert_eq!(csp, format!("sandbox allow-scripts; style-src {}; script-src {}; frame-src 'none'; object-src 'none'", sha(&style), sha(&script)));
        assert_eq!(rich_doc("x", "#fff", "dark", false, true).1, format!("sandbox allow-scripts; style-src {}", sha(&style)));
        assert!(!rich_doc("x", "#fff", "dark", true, false).1.contains("style-src"));
    }

    #[test]
    fn fit_size_cases() {
        assert_eq!(fit_size(4000, 3000, 2048), (2048, 1536, true));
        assert_eq!(fit_size(3000, 4000, 2048), (1536, 2048, true));
        assert_eq!(fit_size(800, 600, 2048), (800, 600, false));
        assert_eq!(fit_size(2048, 2048, 2048), (2048, 2048, false));
        assert_eq!(fit_size(100000, 10, 2048), (2048, 1, true));
    }

    #[test]
    fn clean_theme_rules() {
        assert_eq!(clean_theme(Some(&json!({ "id": "sunset" }))), Some(json!({ "id": "sunset" })));
        assert_eq!(clean_theme(Some(&json!({ "id": "nope" }))), None);
        assert_eq!(clean_theme(Some(&json!({ "id": "custom", "a1": "red", "a2": "#123456" }))), None);
        assert_eq!(
            clean_theme(Some(&json!({ "id": "custom", "a1": "#ABCDEF", "a2": "#123456", "evil": "<x>" }))),
            Some(json!({ "id": "custom", "a1": "#abcdef", "a2": "#123456" }))
        );
    }
}
