// Pure helpers shared by the page (as globalThis.Lib) and the tests (via require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Lib = factory();
})(globalThis, () => {
  // One system message from a persona: who the bot is, who the user is, then the prompt with {{user}} / {{char}} filled in.
  function systemPrompt(p) {
    if (!p) return '';
    const user = p.user || 'User', bot = p.bot || 'Assistant';
    const intro = [p.bot && `You are ${p.bot}.`, p.user && `The user's name is ${p.user}.`].filter(Boolean).join(' ');
    const body = (p.prompt || '').replace(/\{\{\s*user\s*\}\}/gi, () => user).replace(/\{\{\s*char\s*\}\}/gi, () => bot).trim();
    return [intro, body].filter(Boolean).join('\n\n');
  }

  // ---- Rich replies: find the raw HTML blocks in a reply so they can be shown in a sandboxed frame; everything else is Markdown. ----
  const TAGSTART = '<(?:!doctype|html|head|body|div|section|article|main|header|footer|nav|aside|style|script|svg|canvas|table|form|figure|details|center|h[1-6]|p|pre|ul|ol|button|input|label|link|template|video|audio)(?=[\\s>/]|$)';
  const REGION_START = new RegExp('^ {0,3}' + TAGSTART, 'i');
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title']); // their contents are not markup
  const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

  function fencedRanges(text) {
    const out = []; let open = null, pos = 0;
    for (const line of text.split('\n')) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) { if (m && m[1][0] === open.ch && m[1].length >= open.len && !line.slice(m[0].length).trim()) { out.push([open.start, pos + line.length]); open = null; } }
      else if (m) open = { ch: m[1][0], len: m[1].length, start: pos };
      pos += line.length + 1;
    }
    if (open) out.push([open.start, text.length]);
    return out;
  }

  // Index just after the HTML block that starts at `start`. Directly following blocks (style, markup, script) are one page. An unclosed block runs to the end.
  function regionEnd(text, start) {
    const next = new RegExp(TAGSTART, 'iy'); let depth = 0;
    TAG.lastIndex = start;
    for (let m; (m = TAG.exec(text)); ) {
      if (m[0].startsWith('<!--')) continue;
      const [, close, rawName, attrs] = m, name = rawName.toLowerCase();
      if (close) depth = Math.max(0, depth - 1);
      else if (RAW.has(name) && !attrs.trimEnd().endsWith('/')) {
        const end = new RegExp('</' + name + '\\b[^>]*>', 'ig'); end.lastIndex = TAG.lastIndex;
        const c = end.exec(text); if (!c) return text.length;
        TAG.lastIndex = c.index + c[0].length;
      } else if (!VOID.has(name) && !attrs.trimEnd().endsWith('/')) depth++;
      if (depth) continue;
      const here = TAG.lastIndex, k = here + (/^\s*/.exec(text.slice(here))[0].length);
      next.lastIndex = k;
      if (!next.test(text)) return here;
      TAG.lastIndex = k;
    }
    return text.length;
  }

  // -> [{type: 'md', text} | {type: 'html', html}]. HTML inside code fences stays Markdown.
  function splitRich(text) {
    const fences = fencedRanges(text), parts = [];
    const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
    let i = 0, from = 0;
    while (i < text.length) {
      const nl = text.indexOf('\n', i), lineEnd = nl < 0 ? text.length : nl;
      if (REGION_START.test(text.slice(i, lineEnd)) && !inFence(i)) {
        const end = regionEnd(text, i);
        if (i > from) parts.push({ type: 'md', text: text.slice(from, i) });
        parts.push({ type: 'html', html: text.slice(i, end).trim() });
        from = i = end; continue;
      }
      i = lineEnd + 1;
    }
    if (from < text.length) parts.push({ type: 'md', text: text.slice(from) });
    return parts.filter((p) => (p.type === 'html' ? p.html : p.text.trim()));
  }

  const RICH_HINT = 'Display: your replies are rendered as Markdown. You may also write raw HTML, CSS and JavaScript directly in a reply, starting each HTML block at the beginning of a line and not inside a code fence. It renders live in a sandboxed frame with internet access, so CDN libraries work. Use it when visuals help, such as charts, diagrams, interactive demos or styled layouts, and keep ordinary answers in plain Markdown. Show code the user should read rather than run in a fenced code block.';

  // Chat isolation: only this chat's messages go out, stripped of display-only fields (text, files, reasoning).
  function requestMessages(chat, persona, { rich = false } = {}) {
    const msgs = chat.messages.map(({ role, content }) => ({ role, content })), sys = [systemPrompt(persona), rich && RICH_HINT].filter(Boolean).join('\n\n');
    return sys ? [{ role: 'system', content: sys }, ...msgs] : msgs;
  }

  // Text files are inlined as fenced blocks; images become image_url parts.
  function buildContent(text, atts) {
    const body = [text, ...atts.filter((a) => a.kind === 'text').map((a) => `[File: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``)].filter(Boolean).join('\n\n');
    const imgs = atts.filter((a) => a.kind === 'image');
    return imgs.length
      ? [{ type: 'text', text: body || 'See the attached image(s).' }, ...imgs.map((a) => ({ type: 'image_url', image_url: { url: a.url } }))]
      : body;
  }

  // Every word must appear in the id, in any order, ignoring case.
  function matchModels(ids, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return ids.filter((id) => terms.every((t) => id.toLowerCase().includes(t)));
  }

  return { systemPrompt, requestMessages, buildContent, matchModels, splitRich, RICH_HINT };
});
