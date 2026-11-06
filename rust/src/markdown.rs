//! Replies as display blocks (the renderer.js Markdown view): pulldown-cmark's events become prose, headings, list items,
//! code blocks, tables, rules and rich-HTML blocks. Prose is written out again as the small Markdown subset that Slint's
//! StyledText understands (emphasis, strike, links, inline code), so the reply text never reaches it unescaped.
use crate::core::shared::{Part, Render, split_rich};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// Styled prose: `md` for StyledText, `plain` if that ever fails. level 1-6 = heading, 0 = paragraph.
    Text { md: String, plain: String, level: u8, indent: u8, bullet: String, quote: u8 },
    Code { lang: String, code: String },
    /// Rows of cell Markdown; the first row is the header.
    Table { rows: Vec<Vec<(String, String)>> },
    Rule,
    /// Raw HTML to run in the sandbox (Preview / Expand).
    Html(String),
    /// Text shown exactly as written (Markdown off).
    Plain(String),
}

pub fn safe_href(u: &str) -> bool {
    let l = u.trim_start().to_ascii_lowercase();
    l.starts_with("http:") || l.starts_with("https:") || l.starts_with("mailto:")
}

/// The blocks of a reply under the current Replies switches. Never fails: the worst case is plain text.
pub fn blocks(text: &str, r: Render) -> Vec<Block> {
    if !r.markdown && !r.html {
        return vec![Block::Plain(text.to_string())]; // keeps the model's line breaks
    }
    let mut out = vec![];
    for part in split_rich(text) {
        match part {
            Part::Html(h) if r.html => out.push(Block::Html(h)),
            Part::Html(h) => out.push(Block::Code { lang: "html".into(), code: h }), // html off: show it as code to read
            Part::Md(t) if r.markdown => md_blocks(&t, r.html, &mut out),
            Part::Md(t) => out.push(Block::Plain(t)),
        }
    }
    out
}

/// StyledText Markdown escaping: every ASCII punctuation mark is escaped, and Slint's placeholder character is dropped.
fn esc(t: &str, out: &mut String) {
    for c in t.chars() {
        match c {
            '\u{e541}' => {}
            '\n' => out.push(' '),
            c if c.is_ascii_punctuation() => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
}

const INLINE_HTML: [(&str, &str); 8] =
    [("b", "**"), ("strong", "**"), ("i", "*"), ("em", "*"), ("s", "~~"), ("del", "~~"), ("u", "<u>"), ("mark", "")];
const KEPT_HTML: [&str; 6] = ["kbd", "sub", "sup", "small", "code", "mark"];

/// Prose being collected: Markdown for StyledText plus the plain text.
#[derive(Default)]
struct Buf {
    md: String,
    plain: String,
    open_html: Vec<String>, // inline HTML tags opened in this block, so they can be closed
}
impl Buf {
    fn text(&mut self, t: &str) {
        esc(t, &mut self.md);
        self.plain.push_str(t);
    }
    fn raw(&mut self, m: &str) {
        self.md.push_str(m);
    }
    fn is_empty(&self) -> bool {
        self.plain.trim().is_empty()
    }
    /// Harmless inline tags such as <b> and <br> survive inside prose; any other tag is dropped and its text kept.
    fn html(&mut self, src: &str, html_on: bool) {
        if !html_on {
            return self.text(src); // HTML off: show the raw markup as text
        }
        let mut rest = src;
        while !rest.is_empty() {
            if let Some(stripped) = rest.strip_prefix("<!--") {
                rest = stripped.find("-->").map_or("", |i| &stripped[i + 3..]);
                continue;
            }
            let Some(lt) = rest.find('<') else {
                self.text(&decode(rest));
                break;
            };
            self.text(&decode(&rest[..lt]));
            rest = &rest[lt..];
            let Some(gt) = rest.find('>') else {
                self.text(&decode(rest));
                break;
            };
            let tag = &rest[1..gt];
            rest = &rest[gt + 1..];
            let close = tag.starts_with('/');
            let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>().to_lowercase();
            if name.is_empty() {
                self.text(&format!("<{tag}>"));
                continue;
            }
            if name == "br" {
                self.raw("\n");
                self.plain.push('\n');
                continue;
            }
            let Some(&(_, mark)) = INLINE_HTML.iter().find(|(n, _)| *n == name) else {
                let _ = KEPT_HTML; // shown as their text, without styling
                continue;
            };
            if close {
                if let Some(i) = self.open_html.iter().rposition(|n| *n == name) {
                    for n in self.open_html.split_off(i).into_iter().rev() {
                        self.raw(&closing(&n));
                    }
                }
            } else if !mark.is_empty() {
                self.raw(mark);
                self.open_html.push(name);
            }
        }
    }
    fn take(&mut self) -> (String, String) {
        for n in std::mem::take(&mut self.open_html).into_iter().rev() {
            let c = closing(&n);
            self.raw(&c);
        }
        (std::mem::take(&mut self.md).trim().to_string(), std::mem::take(&mut self.plain).trim().to_string())
    }
}
fn closing(name: &str) -> String {
    match INLINE_HTML.iter().find(|(n, _)| *n == name).map(|x| x.1) {
        Some("<u>") => "</u>".into(),
        Some(m) => m.into(),
        None => String::new(),
    }
}
/// Character references in raw HTML text (the common ones; anything else stays as written).
fn decode(t: &str) -> String {
    if !t.contains('&') {
        return t.to_string();
    }
    t.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", "\u{a0}").replace("&amp;", "&")
}

#[derive(Default)]
struct Ctx {
    quote: u8,
    lists: Vec<Option<u64>>, // per open list: next number, or None for bullets
    pending_bullet: Option<String>,
    level: u8,
}

fn md_blocks(text: &str, html_on: bool, out: &mut Vec<Block>) {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH;
    let mut cx = Ctx::default();
    let mut buf = Buf::default();
    let mut code: Option<(String, String)> = None;
    let mut table: Option<Vec<Vec<(String, String)>>> = None;
    let mut links: Vec<Option<String>> = vec![]; // per open link: its destination, when it was written as a link
    let mut image: Option<(String, String)> = None; // (href, alt text so far)

    let flush = |buf: &mut Buf, cx: &mut Ctx, out: &mut Vec<Block>| {
        if buf.is_empty() && cx.pending_bullet.is_none() {
            buf.take();
            return;
        }
        let (md, plain) = buf.take();
        let indent = cx.lists.len().saturating_sub(1) as u8 + u8::from(!cx.lists.is_empty() && cx.pending_bullet.is_none());
        out.push(Block::Text { md, plain, level: cx.level, indent, bullet: cx.pending_bullet.take().unwrap_or_default(), quote: cx.quote });
    };

    for ev in Parser::new_ext(text, opts) {
        if let Some((_, c)) = code.as_mut() {
            match ev {
                Event::Text(t) => c.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, mut c) = code.take().unwrap();
                    if c.ends_with('\n') {
                        c.pop();
                    }
                    out.push(Block::Code { lang, code: c });
                }
                _ => {}
            }
            continue;
        }
        if let Some((href, alt)) = image.as_mut() {
            match ev {
                Event::End(TagEnd::Image) => {
                    let (href, alt) = image.take().unwrap();
                    // remote images are never loaded: they could carry chat text in the URL
                    if safe_href(&href) {
                        buf.raw("[");
                        buf.text(&format!("Image: {}", if alt.is_empty() { &href } else { &alt }));
                        buf.raw(&format!("](<{}>)", href.replace(['<', '>', ' '], "")));
                    } else {
                        buf.text(&alt);
                    }
                }
                Event::Text(t) | Event::Code(t) => alt.push_str(&t),
                _ => {
                    let _ = href;
                }
            }
            continue;
        }
        match ev {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => flush(&mut buf, &mut cx, out),
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut buf, &mut cx, out);
                cx.level = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut buf, &mut cx, out);
                cx.level = 0;
            }
            Event::Start(Tag::BlockQuote(_)) => {
                if !buf.is_empty() {
                    flush(&mut buf, &mut cx, out); // an item that starts with a quote keeps its bullet on the quote's first line
                }
                cx.quote += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut buf, &mut cx, out);
                cx.quote = cx.quote.saturating_sub(1);
            }
            Event::Start(Tag::List(start)) => {
                flush(&mut buf, &mut cx, out);
                cx.lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                flush(&mut buf, &mut cx, out);
                cx.lists.pop();
            }
            Event::Start(Tag::Item) => {
                flush(&mut buf, &mut cx, out);
                let b = match cx.lists.last_mut() {
                    Some(Some(n)) => {
                        *n += 1;
                        format!("{}.", *n - 1)
                    }
                    _ => "•".to_string(),
                };
                cx.pending_bullet = Some(b);
            }
            Event::End(TagEnd::Item) => flush(&mut buf, &mut cx, out),
            Event::TaskListMarker(done) => {
                if let Some(b) = cx.pending_bullet.as_mut() {
                    *b = if done { "☑".into() } else { "☐".into() };
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut buf, &mut cx, out);
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((lang, String::new()));
            }
            Event::Start(Tag::Table(_)) => {
                flush(&mut buf, &mut cx, out);
                table = Some(vec![]);
            }
            Event::Start(Tag::TableHead | Tag::TableRow) => {
                if let Some(t) = table.as_mut() {
                    t.push(vec![]);
                }
            }
            Event::End(TagEnd::TableCell) => {
                let cell = buf.take();
                if let Some(row) = table.as_mut().and_then(|t| t.last_mut()) {
                    row.push(cell);
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some(rows) = table.take() {
                    out.push(Block::Table { rows });
                }
            }
            Event::Rule => {
                flush(&mut buf, &mut cx, out);
                out.push(Block::Rule);
            }
            Event::Start(Tag::Strong) => buf.raw("**"),
            Event::End(TagEnd::Strong) => buf.raw("**"),
            Event::Start(Tag::Emphasis) => buf.raw("*"),
            Event::End(TagEnd::Emphasis) => buf.raw("*"),
            Event::Start(Tag::Strikethrough) => buf.raw("~~"),
            Event::End(TagEnd::Strikethrough) => buf.raw("~~"),
            Event::Start(Tag::Link { dest_url, .. }) => {
                let ok = safe_href(&dest_url);
                if ok {
                    buf.raw("[");
                }
                links.push(ok.then(|| dest_url.to_string())); // only http(s) and mailto links stay links
            }
            Event::End(TagEnd::Link) => {
                if let Some(Some(dest)) = links.pop() {
                    buf.raw(&format!("](<{}>)", dest.replace(['<', '>', ' '], "")));
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => image = Some((dest_url.to_string(), String::new())),
            Event::Text(t) => buf.text(&t),
            Event::Code(t) => {
                let t = t.replace('\u{e541}', "");
                let ticks = "`".repeat(t.split(|c| c != '`').map(str::len).max().unwrap_or(0) + 1);
                let pad = if t.starts_with('`') || t.ends_with('`') { " " } else { "" };
                buf.raw(&format!("{ticks}{pad}{t}{pad}{ticks}"));
                buf.plain.push_str(&t);
            }
            Event::SoftBreak | Event::HardBreak => {
                buf.raw("\n"); // breaks: true, every line break in the reply is kept
                buf.plain.push('\n');
            }
            Event::InlineHtml(h) | Event::Html(h) => buf.html(&h, html_on),
            Event::End(TagEnd::HtmlBlock) => flush(&mut buf, &mut cx, out),
            Event::FootnoteReference(t) | Event::InlineMath(t) | Event::DisplayMath(t) => buf.text(&t),
            _ => {}
        }
    }
    if let Some((lang, c)) = code.take() {
        out.push(Block::Code { lang, code: c });
    }
    flush(&mut buf, &mut cx, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(t: &str) -> Vec<Block> {
        blocks(t, Render::default())
    }
    fn text(b: &Block) -> (&str, &str, u8) {
        match b {
            Block::Text { md, plain, level, .. } => (md, plain, *level),
            _ => panic!("not text: {b:?}"),
        }
    }
    /// Every prose block must be valid StyledText Markdown.
    fn all_parse(bs: &[Block]) {
        for b in bs {
            match b {
                Block::Text { md, .. } => assert!(slint::StyledText::from_markdown(md).is_ok(), "{md}"),
                Block::Table { rows } => rows.iter().flatten().for_each(|(m, _)| assert!(slint::StyledText::from_markdown(m).is_ok(), "{m}")),
                _ => {}
            }
        }
    }

    #[test]
    fn prose_headings_lists_code_tables() {
        let bs = md("# Title\n\nSome **bold** and *it* ~~gone~~ `x` [link](https://a.b) [js](javascript:x)\nnext line\n\n- one\n- [x] done\n\n1. a\n2. b\n\n```rust\nfn main() {}\n```\n\n| a | b |\n|---|---|\n| 1 | **2** |\n\n---\n\n> quoted");
        all_parse(&bs);
        assert_eq!(text(&bs[0]), ("Title", "Title", 1));
        let (m, p, _) = text(&bs[1]);
        assert!(m.contains("**bold**") && m.contains("[link](<https://a.b>)") && !m.contains("javascript"), "{m}");
        assert!(p.contains("\nnext line"));
        assert!(matches!(&bs[2], Block::Text { bullet, .. } if bullet == "•"));
        assert!(matches!(&bs[3], Block::Text { bullet, .. } if bullet == "☑"));
        assert!(matches!(&bs[4], Block::Text { bullet, .. } if bullet == "1."));
        assert!(matches!(&bs[5], Block::Text { bullet, .. } if bullet == "2."));
        assert_eq!(bs[6], Block::Code { lang: "rust".into(), code: "fn main() {}".into() });
        assert!(matches!(&bs[7], Block::Table { rows } if rows.len() == 2 && rows[1][1].0 == "**2**"));
        assert_eq!(bs[8], Block::Rule);
        assert!(matches!(&bs[9], Block::Text { quote: 1, .. }));
    }

    #[test]
    fn list_item_starting_with_a_quote_keeps_its_bullet() {
        let bs = md("- one\n- > quoted\n- three");
        assert_eq!(bs.len(), 3, "{bs:?}");
        assert!(matches!(&bs[1], Block::Text { bullet, quote: 1, plain, .. } if bullet == "•" && plain == "quoted"));
    }

    #[test]
    fn untrusted_text_stays_text() {
        let bs = md("a {} \u{e541} <u>u</u> <script>x</script> <b>bold</b> <kbd>K</kbd> \\* [x](y) ![pic](https://evil/p?q=chat)");
        all_parse(&bs);
        let (m, p, _) = text(&bs[0]);
        assert!(!m.contains('\u{e541}'));
        assert!(m.contains("<u>u</u>") && m.contains("**bold**") && p.contains("K"));
        assert!(p.contains("Image: pic") && m.contains("(<https://evil/p?q=chat>)"));
        assert!(!p.contains("<script>"));
    }

    #[test]
    fn switches() {
        let r = Render { markdown: false, ..Default::default() };
        assert_eq!(blocks("**x**\n<div>y</div>", r), vec![Block::Plain("**x**\n".into()), Block::Html("<div>y</div>".into())]);
        let r = Render { html: false, css: false, js: false, markdown: true };
        assert_eq!(blocks("<div>y</div>", r), vec![Block::Code { lang: "html".into(), code: "<div>y</div>".into() }]);
        let off = Render { html: false, markdown: false, ..Default::default() };
        assert_eq!(blocks("a\n**b**", off), vec![Block::Plain("a\n**b**".into())]);
        // html off inside prose shows the markup as text
        let bs = blocks("x <b>y</b>", r);
        assert!(text(&bs[0]).1.contains("<b>y</b>"));
        all_parse(&bs);
    }

    #[test]
    fn nested_and_awkward() {
        let bs = md("- a\n  - b\n    ```\n    code\n    ```\n- c\n\n**\"q\"**x and `` a`b `` and ***both***");
        all_parse(&bs);
        assert!(bs.iter().any(|b| matches!(b, Block::Code { code, .. } if code == "code")));
        assert!(bs.iter().any(|b| matches!(b, Block::Text { indent: 1, .. })));
    }
}
