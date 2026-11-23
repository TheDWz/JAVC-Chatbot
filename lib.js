// Pure helpers shared by the page (as globalThis.Lib) and the tests (via require).
(function (/** @type {any} */ root, factory) {
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

  /** A CSS color from the page, or a neutral grey when it isn't a plain color value (so it can't break out of the style tag). */
  const safeColor = (c) => (typeof c === 'string' && /^[\w#(),.\s%/-]{1,60}$/.test(c) ? c : '#888');
  const RESIZE = '(()=>{const p=()=>parent.postMessage({richHeight:Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,document.body.scrollHeight))},"*");const o=new ResizeObserver(p);o.observe(document.documentElement);o.observe(document.body);addEventListener("load",p);p()})()';
  /** A CSP hash source for `s`. WebCrypto: Node, Electron and the Android WebView all have it. */
  const sha = async (s) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))))}'`;
  /**
   * The page a rich block runs in: the model's HTML plus a script that reports the content height to the reply.
   * The desktop (main.js) and Android (JavcPlugin.java) serve `doc` with `csp` as its Content-Security-Policy.
   * css/js off => the CSP only allows our own <style> and resize <script> (by hash, which a script can't read back like a nonce).
   * js off also blocks child frames/objects/embeds: a remote child document isn't covered by our script-src and would run its own scripts.
   * shortcut: with CSS off but JS on, scripts can still set element.style from JS (CSSOM isn't covered by CSP); fine for a display preference.
   * @param {string} html The model's HTML.
   * @param {string} color The reply's text color.
   * @param {string} scheme 'light' or 'dark'; must match the app's, or the frame gets an opaque white background.
   * @param {{css?: boolean, js?: boolean}} [flags] The Replies switches; both default to on.
   * @param {Record<string, string>} [links] name -> URL: each attachment:<name> in the HTML becomes that URL (see richFiles).
   * @returns {Promise<{doc: string, csp: string}>}
   */
  async function richDoc(html, color, scheme, flags, links = {}) {
    const s = scheme === 'light' ? 'light' : 'dark', css = flags?.css !== false, js = flags?.js !== false;
    html = html.replace(/attachment:([\w.-]+)/g, (m, n) => { const k = n.replace(/\.+$/, ''); return Object.hasOwn(links, k) ? links[k] + n.slice(k.length) : m; }); // a sentence's last dot isn't part of the name
    const style = `:root{color-scheme:${s}}html,body{margin:0;background:transparent}body{color:${safeColor(color)};font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}`;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${s}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body>${html}<script>${RESIZE}</script></body></html>`;
    const csp = ['sandbox allow-scripts', !css && `style-src ${await sha(style)}`, !js && `script-src ${await sha(RESIZE)}; frame-src 'none'; object-src 'none'`].filter(Boolean).join('; ');
    return { doc, csp };
  }
  const RICH_MAX = 2_000_000;

  /** The size of a w×h image scaled to fit in max×max, keeping its shape; never enlarged. `scaled` says whether it shrank. */
  function fitSize(w, h, max) {
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scaled: s < 1 };
  }

  // Reply display toggles (all on by default). The system hint tells the model only what the user has switched on.
  const RENDER_KEYS = ['markdown', 'html', 'css', 'js'];
  const renderHint = ({ markdown = true, html = true, css = true, js = true } = {}) => {
    if (!markdown && !html) return 'Display: your replies are shown as plain text. Do not use Markdown or HTML formatting.';
    const out = ['Display: your replies are ' + (markdown ? 'rendered as Markdown.' : 'shown as plain text, so do not use Markdown formatting.')];
    if (html) {
      const extra = [css && 'CSS', js && 'JavaScript'].filter(Boolean);
      out.push('You may also write raw HTML' + (extra.length ? ' with ' + extra.join(' and ') : ' only (CSS and JavaScript are switched off)')
        + ' directly in a reply, starting each HTML block at the beginning of a line and not inside a code fence. It renders live in a sandboxed frame with internet access'
        + (js ? ', so CDN libraries work' : '') + '. Use it when visuals help, such as charts, diagrams, interactive demos or styled layouts, and keep ordinary answers in plain '
        + (markdown ? 'Markdown' : 'text') + '.' + (markdown ? ' Show code the user should read rather than run in a fenced code block.' : ''));
    }
    return out.join(' ');
  };

  // Accent colors. 'indigo' is the default; a custom theme is {id: 'custom', a1, a2} with two #rrggbb colors.
  // `gradient` turns on the a1→a2 blend; off, the page uses a1 alone.
  const THEMES = [
    { id: 'indigo', name: 'Indigo', a1: '#4f46e5', a2: '#0284c7' },
    { id: 'aurora', name: 'Aurora', a1: '#8b5cf6', a2: '#3b82f6' },
    { id: 'ocean', name: 'Ocean', a1: '#0891b2', a2: '#2563eb' },
    { id: 'emerald', name: 'Emerald', a1: '#059669', a2: '#0891b2' },
    { id: 'sunset', name: 'Sunset', a1: '#e0510a', a2: '#db2777' },
    { id: 'rose', name: 'Rose', a1: '#db2777', a2: '#7c3aed' },
    { id: 'graphite', name: 'Graphite', a1: '#64748b', a2: '#334155' },
  ];
  const HEX = /^#[0-9a-f]{6}$/i;
  // Returns the normalized theme for a patch, or null when it isn't valid (callers ignore invalid input).
  function cleanTheme(t) {
    const gradient = t?.gradient === true;
    if (t && THEMES.some((x) => x.id === t.id)) return { id: t.id, gradient };
    if (t && t.id === 'custom' && HEX.test(t.a1) && HEX.test(t.a2)) return { id: 'custom', a1: t.a1.toLowerCase(), a2: t.a2.toLowerCase(), gradient };
    return null;
  }
  const themeColors = (t) => THEMES.find((x) => x.id === t?.id) || (t?.id === 'custom' && cleanTheme(t)) || THEMES[0];

  // ---- Summaries: once a chat nears the model's context limit, its oldest messages go out as one summary. chat.summary = {text, upto, at}:
  // it stands for messages[0..upto), and `at` is how many messages the chat had when it was written. The messages themselves stay on screen. ----
  // shortcut: summarize at 80% of the limit and keep the last 4 messages word for word; tune if summaries come too early or too late
  const SUMMARY_AT = 0.8, KEEP = 4, IMG_TOKENS = 1000, DEFAULT_CTX = 300000; // context limit for models whose list gives none
  /** The chat's summary, or null when there is none or an edit or regenerate left the chat shorter than it. */
  const summaryOf = (chat) => (chat.summary && chat.summary.upto <= chat.messages.length ? chat.summary : null);
  const textOf = (c) => (Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : c || '');
  const imagesIn = (c) => (Array.isArray(c) ? c.filter((p) => p.type === 'image_url').length : 0);
  /** A rough token count for a message: about 4 characters a token, and a flat amount per image. */
  const tokensOf = (m) => Math.ceil(textOf(m.content).length / 4) + imagesIn(m.content) * IMG_TOKENS;

  // Chat isolation: only this chat's messages go out, stripped of display-only fields (text, files, reasoning).
  // A summary joins the one system message (some providers reject a second one) and replaces the messages it covers.
  /**
   * @param {{messages?: {role: string, content: (string|object)}[]}} chat
   * @param {object} [persona]
   * @param {{render?: object, files?: boolean}} [opts] `files`: a reply's created files (create_file) go back with it, so the model can edit them.
   */
  function requestMessages(chat, persona, { render, files } = {}) {
    const s = summaryOf(chat), msgs = chat.messages.slice(s ? s.upto : 0).map((m) => sent(m, files));
    const sys = [systemPrompt(persona), render && renderHint(render), s && 'Summary of the earlier conversation:\n' + s.text, files && s && earlierFiles(chat.messages.slice(0, s.upto))].filter(Boolean).join('\n\n');
    return sys ? [{ role: 'system', content: sys }, ...msgs] : msgs;
  }

  /** The files the model created for reply `m` that carry what it put in them. */
  const madeIn = (m) => (m.role === 'assistant' && Array.isArray(m.attachments) ? m.attachments.filter((a) => a?.made && typeof a.source === 'string') : []);
  /** The files created in summarized messages `ms`, the last of each name, so the model can still edit them; '' when there are none. */
  function earlierFiles(ms) {
    const last = new Map();
    for (const m of ms) for (const a of madeIn(m)) last.set(a.name, a.source);
    return last.size ? ['Files you created earlier in this chat (the summary covers their replies), as you last wrote them:', ...[...last].map(([n, src]) => `[File "${n}":]\n${src}`)].join('\n\n') : '';
  }
  /** Message `m` as it is sent: role and content, plus what the model put in the files it created when `files` is on. */
  function sent(m, files) {
    const made = files && typeof m.content === 'string' ? madeIn(m) : [];
    if (!made.length) return { role: m.role, content: m.content };
    return { role: m.role, content: [m.content, ...made.map((a) => `[You created the file "${a.name}" for this reply. What you put in it:]\n${a.source}`)].filter(Boolean).join('\n\n') };
  }

  /**
   * About how many tokens the chat's next request holds (persona and opts as for requestMessages). With a recent reply, it's the server's
   * count of that reply's prompt plus an estimate for the reply and what came after; reasoning and search results aren't sent again, so
   * they don't count. Replies written before the summary measured the old, longer context, so they're skipped; without one it's all estimated.
   */
  function contextTokens(chat, persona, opts) {
    const s = summaryOf(chat), ms = chat.messages, start = s ? Math.max(s.upto, s.at) : 0;
    const i = ms.findLastIndex((m, k) => k >= start && m.role === 'assistant' && m.stats?.prompt);
    if (i < 0) return requestMessages(chat, persona, opts).reduce((n, m) => n + tokensOf(m), 0);
    return ms.slice(i).reduce((n, m) => n + tokensOf(sent(m, opts?.files)), ms[i].stats.prompt);
  }
  /** Where a new summary should end: a user message that leaves the last KEEP messages as they are and adds something new. -1 when there is none. */
  function summaryCut(chat) {
    const from = summaryOf(chat)?.upto || 0, ms = chat.messages;
    for (let i = ms.length - KEEP; i > from; i--) if (ms[i].role === 'user') return i;
    return -1;
  }
  /** The cut to summarize at when the chat's next request is over SUMMARY_AT of `limit` tokens, else -1. */
  const summaryDue = (chat, limit, persona, opts) => (contextTokens(chat, persona, opts) > SUMMARY_AT * limit ? summaryCut(chat) : -1);
  /** The request that folds messages up to `cut` into the chat's summary. shortcut: sent in one piece, so a gap bigger than the summarizer's own context fails (and the chat is sent unsummarized); chunk it if that happens. */
  function summaryRequest(chat, persona, cut) {
    const s = summaryOf(chat), user = persona?.user || 'User', bot = persona?.bot || 'Assistant';
    const lines = chat.messages.slice(s ? s.upto : 0, cut)
      .map((m) => `${m.role === 'user' ? user : bot}: ${[textOf(m.content), ...Array(imagesIn(m.content)).fill('[image]')].filter(Boolean).join(' ')}`);
    return [
      { role: 'system', content: 'You summarize conversations so they can go on after the older messages are dropped. Write a concise summary in plain text and in the third person. '
        + 'Keep every fact, name, decision, preference and open task the rest of the conversation may need. Reply with the summary only.' },
      { role: 'user', content: [s && `Summary so far:\n${s.text}`, `Conversation to add:\n\n${lines.join('\n\n')}`].filter(Boolean).join('\n\n') },
    ];
  }

  // ---- Previews of a reply's files (the file dialog) ----
  /** Which preview file `f` ({name, mime}) gets: 'pdf', 'xlsx', 'pptx', 'csv', 'md' or 'text'; null for none. */
  function previewKind(f) {
    const mime = String(f?.mime || '').toLowerCase(), ext = /\.([a-z0-9]+)$/i.exec(String(f?.name || ''))?.[1]?.toLowerCase();
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (mime.includes('spreadsheetml.sheet') || ext === 'xlsx') return 'xlsx';
    if (mime.includes('presentationml.presentation') || ext === 'pptx') return 'pptx';
    if (mime === 'text/csv' || ext === 'csv') return 'csv';
    if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'md';
    if (mime.startsWith('text/') || mime === 'application/json' || ext === 'txt' || ext === 'json') return 'text';
    return null;
  }
  /** CSV text as rows of strings (quotes, "" inside them and CRLF handled), at most `max` rows; `more` when it had more. */
  function csvRows(text, max = 500) {
    const rows = []; let row = [], cell = '', q = false, i = 0;
    const endRow = () => { row.push(cell); rows.push(row); row = []; cell = ''; };
    for (; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); if (rows.length > max) break; }
      else cell += c;
    }
    if (cell || row.length) endRow();
    return { rows: rows.slice(0, max), more: rows.length > max };
  }
  /** The first `max` pages of PDF `bytes` as PNG data: URLs, drawn with pdf-parse's `PDFParse` (Node or browser build), and the page count. */
  async function pdfPages(PDFParse, bytes, max = 10) {
    const parser = new PDFParse({ data: bytes });
    try {
      const r = await parser.getScreenshot({ first: max, desiredWidth: 1000, imageDataUrl: true, imageBuffer: false });
      return { pages: r.pages.map((p) => p.dataUrl), total: r.total };
    } finally { await parser.destroy(); }
  }

  // Text files are inlined as fenced blocks; images become image_url parts.
  const IMG_ONLY = 'See the attached image(s).';
  function buildContent(text, atts) {
    const body = [text, ...atts.filter((a) => a.kind === 'text').map((a) => `[File: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``)].filter(Boolean).join('\n\n');
    const imgs = atts.filter((a) => a.kind === 'image');
    return imgs.length
      ? [{ type: 'text', text: body || IMG_ONLY }, ...imgs.map((a) => ({ type: 'image_url', image_url: { url: a.url } }))]
      : body;
  }

  /**
   * A sent user message with its typed text replaced. The inlined files and images stay: only their names are stored
   * apart, so the content can't be rebuilt with buildContent. Relies on buildContent putting the typed text first.
   */
  function editUser(m, text) {
    const arr = Array.isArray(m.content), body = arr ? m.content[0].text : m.content, old = m.text || '';
    const files = old ? body.slice(old.length).replace(/^\n\n/, '') : arr && body === IMG_ONLY ? '' : body;
    const next = [text, files].filter(Boolean).join('\n\n');
    return { ...m, text, content: arr ? [{ type: 'text', text: next || IMG_ONLY }, ...m.content.slice(1)] : next };
  }

  // Message versions: each edit or regenerate adds one. The message's own fields always hold the version shown, so
  // requests and rendering never look at `versions`. A user version is only its typed text: the attachments (possibly
  // megabytes of image data) are stored once, on the message, and editUser puts them back around the text.
  const VKEYS = ['content', 'reasoning', 'stats', 'attachments']; // attachments: {name, mime, size, ref} of files the model attached
  const pickVersion = (m) => (m.role === 'user' ? { text: m.text || '' } : Object.fromEntries(VKEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])));
  /** A copy of message `m` showing version `v` (clamped to the versions it has). */
  function showVersion(m, v) {
    v = Math.max(0, Math.min(v, m.versions.length - 1));
    const ver = m.versions[v];
    if (m.role === 'user') return { ...editUser(m, ver.text), v };
    const out = { ...m, v };
    for (const k of VKEYS) if (k in ver) out[k] = ver[k]; else delete out[k];
    return out;
  }
  /** A copy of message `m` with `fields` (a reply's content and reasoning, or a user message's text) added as its newest version, and showing it. */
  function addVersion(m, fields) {
    const versions = [...(m.versions || [pickVersion(m)]), pickVersion({ role: m.role, ...fields })];
    return showVersion({ ...m, versions }, versions.length - 1);
  }

  /** A file size for people: 14 B, 6 KB, 1.2 MB. */
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  /**
   * The files of a reply that `html` names as attachment:<name>, for its rich page: {token, files: {name: {ref, mime}}}, or null.
   * The host serves them under the token only, so a frame can load its own reply's files and nothing else; the same files get
   * the same token (kept in `tokens` for the run), so the page stays the same and is reused.
   * @param {string} html
   * @param {{name: string, ref: string, mime?: string}[] | undefined} files The reply's attachments.
   * @param {Map<string, string>} tokens
   */
  function richFiles(html, files, tokens) {
    const used = (Array.isArray(files) ? files : []).filter((f) => typeof f?.name === 'string' && /^\w[\w.-]{0,99}$/.test(f.name) && typeof f.ref === 'string' && html.includes('attachment:' + f.name));
    if (!used.length) return null;
    const key = JSON.stringify(used.map((f) => [f.name, f.ref, f.mime]));
    if (!tokens.has(key)) tokens.set(key, crypto.randomUUID());
    const mime = (m) => (typeof m === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : 'application/octet-stream');
    return { token: /** @type {string} */ (tokens.get(key)), files: Object.fromEntries(used.map((f) => [f.name, { ref: f.ref, mime: mime(f.mime) }])) };
  }

  // ---- Stats for nerds: saved on each reply (and each of its versions), never sent to the model ----
  /**
   * One reply's stats from its timings (ms, from performance.now()) and the server's token counts.
   * @param {{model: string, t0: number, t1: number, t2: number, paused?: number, cost?: number, usage?: {completion_tokens?: number, completion_tokens_details?: {reasoning_tokens?: number}, total_tokens?: number, prompt_tokens?: number}, ctx?: number, sent?: number, text: string, sawReasoning?: boolean}} r
   *   t0 request sent, t1 the model's first text (0 = none), t2 reply finished, paused time spent waiting on web searches after t1;
   *   text is the reply plus its reasoning; sawReasoning says whether any reasoning text was streamed.
   *   sent is the prompt tokens of the request's first round (search rounds add more), which the next request's size is counted from.
   *   cost is what the provider reported the reply cost, in USD, when it says.
   * @returns {{model, ttft, tps, out, total, ctx, prompt, est, cost}} Without usage, `out` is guessed from the length (about 4 characters a token) and `est` is set.
   */
  function replyStats({ model, t0, t1, t2, paused = 0, usage, ctx, sent, text, sawReasoning = true, cost }) {
    const est = usage?.completion_tokens == null, out = est ? Math.round((text || '').length / 4) : usage.completion_tokens;
    // Hidden reasoning (o-series, GPT-5) is counted but never streamed: it happens before t1, so it isn't part of the speed.
    const shown = out - (!est && !sawReasoning ? usage.completion_tokens_details?.reasoning_tokens || 0 : 0);
    const gen = (t2 - (t1 || t2) - paused) / 1000; // a reply that arrives in one piece has no measurable speed
    return {
      model, ttft: t1 ? Math.round(t1 - t0) : null, tps: gen > 0.05 && shown > 0 ? Math.round((shown / gen) * 10) / 10 : null,
      out, total: usage?.total_tokens ?? null, ctx: ctx ?? usage?.total_tokens ?? null, prompt: sent ?? usage?.prompt_tokens ?? null, ...(est && { est: true }), ...(typeof cost === 'number' && { cost }),
    };
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  /**
   * A chat's stats. Averages and `points` (oldest first, each with `n`, its reply number in the chat) count only `model` when given;
   * `last` and the token totals always cover the whole chat. `used` is the chat's running total (chat.used), which never goes down,
   * since replies that were regenerated, edited away or dropped used tokens too. `cost` (chat.cost, USD) is the same kind of total, or null when no provider reported one.
   */
  function chatStats(chat, model) {
    const all = chat.messages.filter((m) => m.role === 'assistant').flatMap((m, i) => (m.stats ? [{ ...m.stats, n: i + 1 }] : []));
    const points = model ? all.filter((s) => s.model === model) : all, num = (k) => points.map((s) => s[k]).filter((v) => typeof v === 'number');
    return {
      last: all.at(-1) || null, points, models: [...new Set(all.map((s) => s.model))], avgTtft: avg(num('ttft')), avgTps: avg(num('tps')),
      used: chat.used || 0, cost: chat.cost ?? null, context: all.at(-1)?.ctx ?? null, est: all.some((s) => s.est), noTotal: all.some((s) => s.total == null),
    };
  }

  // Every word must appear in the id, in any order, ignoring case.
  function matchModels(ids, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return ids.filter((id) => terms.every((t) => id.toLowerCase().includes(t)));
  }

  return { previewKind, csvRows, pdfPages, systemPrompt, requestMessages, summaryOf, contextTokens, summaryCut, summaryDue, summaryRequest, buildContent, editUser, addVersion, showVersion, matchModels, replyStats, chatStats, splitRich, renderHint, RENDER_KEYS, THEMES, cleanTheme, themeColors, richDoc, richFiles, safeColor, RICH_MAX, fmtSize, fitSize, DEFAULT_CTX };
});
