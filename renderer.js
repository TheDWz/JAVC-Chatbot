const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (paths) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); } return s; };
const ICON = {
  // App mark, printed by build/mkicon.py (same strokes as build/icon.svg, at 24px). Keep in sync with .mark in index.html.
  logo: ['M15.08 12.87C13.77 15.67 10.44 16.88 7.63 15.58C4.83 14.27 3.62 10.94 4.92 8.13C6.23 5.33 9.56 4.12 12.37 5.42',
    'M8.92 11.13C10.23 8.33 13.56 7.12 16.37 8.42C19.17 9.73 20.38 13.06 19.08 15.87C17.77 18.67 14.44 19.88 11.63 18.58'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'],
  x: ['M18 6L6 18M6 6l12 12'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  alert: ['M12 8v5', 'M12 16.5v.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
};
// Accent colors are two CSS variables on <html>; every gradient, ring and tint in index.html derives from them.
function applyTheme(t) {
  const c = Lib.themeColors(t), r = document.documentElement.style;
  r.setProperty('--a1', c.a1); r.setProperty('--a2', c.a2);
  try { localStorage.setItem('theme', JSON.stringify(t)); } catch {} // only a start-up cache; settings.json is the source of truth
}
try { const t = JSON.parse(localStorage.getItem('theme')); if (Lib.cleanTheme(t)) applyTheme(t); } catch {}

// Touch screens: Enter makes a new line (the send button sends), and the keyboard only opens when the user taps the box,
// so it never pops up over a reply.
const touch = matchMedia('(pointer: coarse)');
const focusInput = () => { if (!touch.matches) $('input').focus(); };

const newChat = () => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), title: '', created: Date.now(), updated: Date.now(), personaId: state.personaId, messages: [] });
let state = { profiles: [], activeId: '', templates: [], effort: '', personas: [], personaId: 'default', render: { markdown: true, html: true, css: true, js: true }, theme: { id: 'aurora' } }, settings = {}, chat = newChat(), chatList = [], busy = false, toastTimer, errTimer;

// Red pop-up for failures; long server messages stay a little longer so they can be read.
function showError(text) {
  const t = $('errtoast'); t.replaceChildren(svg(ICON.alert), el('span', null, text)); t.classList.add('show');
  clearTimeout(errTimer); errTimer = setTimeout(() => t.classList.remove('show'), Math.min(8000, 3500 + text.length * 25));
}
// `settings` is a flat view of the active profile plus the global reasoning level, so the code below can read settings.model etc.
function applyState(st) {
  state = st;
  settings = { ...(st.profiles.find((p) => p.id === st.activeId) || {}), effort: st.effort };
  $('profile').replaceChildren(...(st.profiles.length ? st.profiles.map((p) => new Option(p.name, p.id)) : [new Option('No profiles yet', '')]));
  $('profile').value = st.activeId; $('profile').disabled = busy || !st.profiles.length;
  applyTheme(st.theme);
  $('persona').replaceChildren(...st.personas.map((p) => new Option(p.name, p.id))); $('persona').value = st.personaId;
}
// A chat whose persona is missing or was deleted counts as Default.
const personaIdOf = (c) => (state.personas.some((p) => p.id === c.personaId) ? c.personaId : 'default');
const personaOf = (c) => state.personas.find((p) => p.id === personaIdOf(c));
function refreshPersonaUi() { $('input').placeholder = `Message ${personaOf(chat)?.bot || 'JAVC Chatbot'}…`; }
const isLocal = (u) => /^https?:\/\/(localhost|127\.|\[::1\]|10\.|192\.168\.)/i.test(u || '');

function toast(text) {
  $('toast').textContent = text; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1800);
}
async function copy(text) { // Android copies through the app, since a WebView's clipboard access isn't guaranteed
  try { await (window.api.copyText ? window.api.copyText(text) : navigator.clipboard.writeText(text)); toast('Copied'); } catch { toast('Copy failed'); }
}
function scrollDown() { $('scroll').scrollTop = $('scroll').scrollHeight; }
function push(node) { $('log').querySelector('.empty')?.remove(); $('log').append(node); scrollDown(); return node; }

function copyBtn(getText, label = 'Copy') {
  const b = el('button', 'mini'); b.type = 'button'; b.append(svg(ICON.copy), label); b.onclick = () => copy(getText()); return b;
}

// Text with `inline code`, built from DOM nodes only (replies are untrusted, never innerHTML).
function inline(parent, text) {
  text.split(/`([^`\n]+)`/).forEach((part, i) => parent.append(i % 2 ? el('code', 'inline', part) : document.createTextNode(part)));
}
// ---- Replies: Markdown from marked's token tree, built from DOM nodes only (never innerHTML). Raw HTML blocks run in a sandboxed frame. ----
// Entities only: a detached <textarea> parses its contents as plain text with character references, never as tags.
const entityBox = document.createElement('textarea');
const decode = (t) => { if (!t.includes('&')) return t; entityBox.innerHTML = t; return entityBox.value; };
const INLINE_HTML = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'kbd', 'sub', 'sup', 'mark', 'small', 'code']);
const SAFE_HREF = /^(https?:|mailto:)/i;

// Harmless inline tags such as <kbd> and <br> survive inside prose; any other tag is dropped and its text kept.
function htmlish(parent, src, open = []) {
  if (!state.render.html) { (open.at(-1) ?? parent).append(src); return; } // HTML off: show the raw markup as text
  for (const piece of src.replace(/<!--[\s\S]*?-->/g, '').split(/(<\/?[a-zA-Z][^>]*>)/)) {
    const m = /^<(\/?)([a-zA-Z][\w-]*)[^>]*>$/.exec(piece), at = open.at(-1) ?? parent;
    if (!m) { if (piece) at.append(decode(piece)); continue; }
    const name = m[2].toLowerCase();
    if (name === 'br') at.append(el('br'));
    else if (!INLINE_HTML.has(name)) continue;
    else if (m[1]) { const i = open.findLastIndex((e) => e.localName === name); if (i >= 0) open.length = i; }
    else { const e = el(name); at.append(e); open.push(e); }
  }
}

function mdInline(parent, tokens) {
  const open = [], at = () => open.at(-1) ?? parent;
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': case 'em': case 'del': { const e = el({ strong: 'strong', em: 'em', del: 's' }[t.type]); at().append(e); mdInline(e, t.tokens); break; }
      case 'codespan': at().append(el('code', 'inline', t.text)); break;
      case 'br': at().append(el('br')); break;
      case 'link': {
        if (!SAFE_HREF.test(t.href)) { mdInline(at(), t.tokens); break; }
        const a = el('a'); a.href = t.href; a.title = t.href; at().append(a); mdInline(a, t.tokens); break; // the tooltip shows where it really goes
      }
      case 'image': { // remote images are never loaded: they could carry chat text in the URL
        if (!SAFE_HREF.test(t.href)) { at().append(decode(t.text)); break; }
        const a = el('a', null, 'Image: ' + (decode(t.text) || t.href)); a.href = t.href; a.title = t.href; at().append(a); break;
      }
      case 'html': htmlish(parent, t.text, open); break;
      default: if (t.tokens?.length) mdInline(at(), t.tokens); else at().append(decode(t.text ?? ''));
    }
  }
}

function mdBlocks(parent, tokens) {
  for (const t of tokens) {
    switch (t.type) {
      case 'space': case 'def': break;
      case 'heading': { const h = el('h' + t.depth); parent.append(h); mdInline(h, t.tokens); break; }
      case 'paragraph': { const p = el('p'); parent.append(p); mdInline(p, t.tokens); break; }
      case 'text': if (t.tokens) mdInline(parent, t.tokens); else parent.append(decode(t.text)); break;
      case 'hr': parent.append(el('hr')); break;
      case 'blockquote': { const q = el('blockquote'); parent.append(q); mdBlocks(q, t.tokens); break; }
      case 'code': parent.append(codeBox(t.lang, t.text)); break;
      case 'list': {
        const l = el(t.ordered ? 'ol' : 'ul'); if (t.ordered && t.start > 1) l.start = t.start;
        for (const item of t.items) { const li = el('li'); l.append(li); mdBlocks(li, item.tokens); }
        parent.append(l); break;
      }
      case 'checkbox': { const c = el('input'); c.type = 'checkbox'; c.disabled = true; c.checked = t.checked; parent.append(c); break; }
      case 'table': {
        const cells = (tag, row) => { const tr = el('tr'); for (const c of row) { const e = el(tag); if (c.align) e.style.textAlign = c.align; mdInline(e, c.tokens); tr.append(e); } return tr; };
        const table = el('table'), head = el('thead'), body = el('tbody'), wrap = el('div', 'tablewrap');
        head.append(cells('th', t.header)); body.append(...t.rows.map((r) => cells('td', r))); table.append(head, body); wrap.append(table); parent.append(wrap); break;
      }
      case 'html': { const d = el('div'); parent.append(d); htmlish(d, t.text); break; }
      default: if (t.tokens) mdBlocks(parent, t.tokens); else if (t.text) parent.append(decode(t.text));
    }
  }
}

// A fenced block is code to read; html/svg blocks also get a Preview button that runs them in the sandbox.
function codeBox(lang, code) {
  const box = el('div', 'code'), head = el('div', 'code-head', lang || 'code'), actions = el('span', 'code-actions');
  const pre = el('pre'); pre.append(el('code', null, code));
  box.append(head, pre); head.append(actions);
  if (state.render.html && /^(html?|svg)$/i.test(lang || '')) {
    const b = el('button', 'mini', 'Preview'); b.type = 'button'; let shown = null;
    b.onclick = () => { if (shown) { shown.remove(); shown = null; b.textContent = 'Preview'; } else { shown = richFrame(code); box.append(shown); b.textContent = 'Hide preview'; } };
    actions.append(b);
  }
  actions.append(copyBtn(() => code));
  return box;
}

const loadFrame = async (f, html) => {
  try { f.src = await window.api.createSandbox(html, getComputedStyle(document.body).color, getComputedStyle(document.documentElement).colorScheme, { css: state.render.css, js: state.render.js }); }
  catch (e) { f.replaceWith(el('div', 'mnote', 'Could not display this content: ' + cleanErr(e))); }
};
function richFrame(html) {
  const box = el('div', 'rich'), f = el('iframe'), exp = el('button', 'icon-btn rich-exp');
  f.setAttribute('sandbox', 'allow-scripts'); f.title = 'Rich content'; // no allow-same-origin: the frame can't reach the app
  exp.type = 'button'; exp.title = 'Expand'; exp.setAttribute('aria-label', 'Expand'); exp.append(svg(ICON.expand)); exp.onclick = () => expandRich(html);
  box.append(f, exp); loadFrame(f, html); return box;
}
function expandRich(html) {
  const ov = el('div', 'richview'), bar = el('div', 'richview-bar'), close = el('button', 'btn', 'Close'), f = el('iframe'), prev = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape') shut(); };
  const shut = () => { ov.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  close.type = 'button'; close.onclick = shut; f.setAttribute('sandbox', 'allow-scripts'); f.title = 'Rich content';
  bar.append(el('span', null, 'Preview'), close); ov.append(bar, f); document.body.append(ov);
  document.addEventListener('keydown', onKey); close.focus(); loadFrame(f, html);
}
// Frames report their content height so a rich block grows to fit inside the reply.
addEventListener('message', (e) => {
  const h = e.data?.richHeight; if (typeof h !== 'number') return;
  const f = [...document.querySelectorAll('.rich iframe')].find((x) => x.contentWindow === e.source);
  if (f) f.style.height = Math.min(4000, Math.max(24, h)) + 'px';
});

function render(bubble, text) {
  const r = state.render;
  bubble.replaceChildren(); bubble.classList.remove('md');
  if (!r.markdown && !r.html) { bubble.textContent = text; return; } // the bubble keeps the model's line breaks
  bubble.classList.add('md');
  try {
    for (const part of Lib.splitRich(text)) {
      if (part.type === 'html') bubble.append(r.html ? richFrame(part.html) : codeBox('html', part.html)); // html off: show it as code to read
      else if (r.markdown) mdBlocks(bubble, marked.lexer(part.text, { gfm: true, breaks: true }));
      else bubble.append(el('div', 'plain', part.text));
    }
  } catch { bubble.classList.remove('md'); bubble.replaceChildren(text); } // a renderer bug must never lose the reply
}

// ---- Attachments: text/PDF text is inlined into the message, images go as image_url parts ----
const MAX_FILES = 5, MAX_IMG = 8 * 1024 * 1024, MAX_PDF = 25 * 1024 * 1024, MAX_TEXT = 200000;
let pending = [];
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const cleanErr = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const readDataUrl = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(f); });

async function attach(files) {
  for (const f of files) {
    if (pending.length >= MAX_FILES) { toast(`Max ${MAX_FILES} files per message`); break; }
    try {
      let a = { name: f.name, size: f.size };
      if (/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) {
        if (f.size > MAX_IMG) { toast(`${f.name}: image is over 8 MB`); continue; }
        a = { ...a, kind: 'image', url: await readDataUrl(f) };
      } else {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        if (isPdf && f.size > MAX_PDF) { toast(`${f.name}: PDF is over 25 MB`); continue; }
        // 4 bytes per character is the UTF-8 maximum, so this slice always holds more than MAX_TEXT characters
        let text = isPdf ? await window.api.extractPdf(await f.arrayBuffer()) : await f.slice(0, MAX_TEXT * 4).text();
        if (!isPdf && text.includes('\u0000')) { toast(`${f.name}: not a text file`); continue; }
        text = text.trim();
        if (!text) { toast(isPdf ? `${f.name}: no text found (scanned PDF?)` : `${f.name} is empty`); continue; }
        if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT) + '\n[…truncated]'; toast(`${f.name} truncated to ${MAX_TEXT / 1000}k characters`); }
        a = { ...a, kind: 'text', text };
      }
      pending.push(a);
    } catch (e) { toast(`${f.name}: ${cleanErr(e)}`); }
  }
  renderChips();
}

function chip(a, onRemove) {
  const c = el('div', 'att' + (!onRemove && a.kind === 'image' ? ' thumb' : ''));
  if (a.kind === 'image') { const i = el('img'); i.src = a.url; i.alt = a.name; c.append(i); }
  else { const ic = el('span', 'ico'); ic.append(svg(ICON.file)); c.append(ic); }
  if (onRemove || a.kind !== 'image') c.append(el('span', 'nm', a.name), el('span', 'sz', fmtSize(a.size)));
  if (onRemove) { const x = el('button', 'icon-btn'); x.type = 'button'; x.title = x.ariaLabel = 'Remove'; x.append(svg(ICON.x)); x.onclick = onRemove; c.append(x); }
  return c;
}
function renderChips() {
  $('attachments').replaceChildren(...pending.map((a, i) => chip(a, () => { pending.splice(i, 1); renderChips(); })));
}

function addUser(text, atts = []) {
  const row = el('div', 'row user'), body = el('div', 'ubody');
  for (const a of atts) body.append(chip(a));
  if (text) { const b = el('div', 'bubble'); inline(b, text); body.append(b); }
  row.append(body); return push(row);
}
const NO_REASONING = "This model didn't return any reasoning.";
const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 40;

// The avatar toggles a reasoning block above the reply. delta() streams text in; done() swaps in the final, formatted reply.
function addAssistant() {
  const row = el('div', 'row assistant'), av = el('button', 'avatar'), body = el('div', 'body'), b = el('div', 'bubble');
  av.type = 'button'; av.title = 'Show reasoning'; av.setAttribute('aria-label', 'Show reasoning'); av.setAttribute('aria-expanded', 'false'); av.append(svg(ICON.logo));
  const think = el('div', 'think'), tb = el('div', 'think-body placeholder', 'Waiting for reasoning…');
  think.append(el('div', 'think-head', 'Reasoning'), tb);
  const dots = el('span', 'dots'); dots.append(el('i'), el('i'), el('i')); b.append(dots);
  body.append(think, b); row.append(av, body); push(row);
  av.onclick = () => {
    const open = row.classList.toggle('open'), t = open ? 'Hide reasoning' : 'Show reasoning';
    av.setAttribute('aria-expanded', String(open)); av.title = t; av.setAttribute('aria-label', t); tb.scrollTop = tb.scrollHeight;
  };
  let reasoning = '', content = '', rNode = null, cNode = null, raf = 0;
  const flush = () => {
    raf = 0;
    if (reasoning) {
      const stick = nearBottom(tb);
      if (!rNode) { rNode = document.createTextNode(''); tb.classList.remove('placeholder'); tb.replaceChildren(rNode); row.classList.add('thinking'); }
      rNode.data = reasoning;
      if (stick) tb.scrollTop = tb.scrollHeight;
    }
    if (content) {
      const stick = nearBottom($('scroll'));
      if (!cNode) { cNode = document.createTextNode(''); b.replaceChildren(cNode); }
      cNode.data = content;
      if (stick) scrollDown();
    }
  };
  return {
    row,
    delta(d) { reasoning += d.reasoning || ''; content += d.content || ''; raf ||= requestAnimationFrame(flush); },
    done(text, finalReasoning = reasoning) {
      cancelAnimationFrame(raf); raf = 0; row.classList.remove('thinking');
      render(b, text || '(The model returned no text.)');
      tb.classList.toggle('placeholder', !finalReasoning); tb.textContent = finalReasoning || NO_REASONING;
      const actions = el('div', 'actions'); actions.append(copyBtn(() => text)); body.append(actions); scrollDown();
    },
  };
}

function showEmpty() {
  const box = el('div', 'empty'), big = el('div', 'big');
  big.append(svg(ICON.logo));
  box.append(big, el('h1', null, 'How can I help?'));
  const p = el('p');
  if (!state.activeId) { const a = el('button', 'linkish', 'Create a profile'); a.onclick = () => openProfileDialog(true); p.append(a, ' (endpoint + API key) to get started.'); }
  else if (settings.model) { const ps = personaOf(chat); p.textContent = `Chatting with ${ps.bot ? (ps.user ? `${ps.bot} as ${ps.user}` : ps.bot) : settings.model}`; }
  else { const a = el('button', 'linkish', 'Open settings'); a.onclick = openSettings; p.append(a, ' and fetch models to get started.'); }
  const chips = el('div', 'chips');
  for (const s of ['Explain a concept simply', 'Write a bash one-liner', 'Brainstorm project ideas']) {
    const c = el('button', 'chip', s); c.onclick = () => { $('input').value = s + ': '; $('input').focus(); }; chips.append(c);
  }
  box.append(p, chips); $('log').replaceChildren(box);
}

// ---- Reasoning level: always list every level any major provider uses; the model rejects what it can't do ----
const LEVELS = [
  ['', 'Disabled', 'Send no reasoning field at all (legacy models like GPT-3.5)'], ['none', 'None', 'Reasoning off'], ['minimal', 'Minimal', 'Barely any thinking'],
  ['low', 'Low', 'Quick, light reasoning'], ['medium', 'Medium', 'Balanced'], ['high', 'High', 'Deeper reasoning'],
  ['xhigh', 'Extra high', 'Very deep, slower'], ['max', 'Max', 'Maximum effort, slowest'],
];
let modelInfo = {};

function renderLevels() {
  const info = modelInfo[settings.model] || {};
  $('sidemodel').textContent = settings.model || 'No model selected';
  $('levels').replaceChildren(...LEVELS.map(([v, name, desc]) => {
    const b = el('button', 'level'); b.type = 'button'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === (settings.effort || '')));
    const nm = el('span', 'nm', name); if (v && v === info.default) nm.append(el('span', 'tag', 'model default'));
    b.append(nm, el('span', 'ds', desc));
    b.onclick = () => { settings.effort = v; window.api.patchSettings({ effort: v }); renderLevels(); toast(`Reasoning: ${name}`); };
    return b;
  }));
  $('sidenote').textContent = 'Levels the model does not support are rejected and show an error.'
    + (settings.thinkingSwitch ? ' On this provider, None turns thinking off.' : '');
}
function toggleSide(open) {
  $('side').classList.toggle('open', open); $('scrim').classList.toggle('on', open); $('side').inert = !open;
  if (open) $('levels').querySelector('[aria-checked="true"]')?.focus(); else $('reasoning').focus();
}
$('reasoning').onclick = () => toggleSide(true);
$('sideclose').onclick = $('scrim').onclick = () => toggleSide(false);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('side').classList.contains('open')) toggleSide(false); });

// ---- Searchable model picker. The hidden <select id="model"> stays the source of truth; this is just a nicer way to choose from it. ----
let modelHi = 0, modelShown = [];
const MODEL_CAP = 200; // rendering hundreds of rows on every keystroke is slow; the count line tells the user to keep typing
function renderModelBtn() { $('modellabel').textContent = $('model').selectedOptions[0]?.text || 'No model selected'; }
function closeModelPop() { $('modelpop').hidden = true; $('modelbtn').setAttribute('aria-expanded', 'false'); $('modelq').setAttribute('aria-expanded', 'false'); $('modelq').removeAttribute('aria-activedescendant'); }
function openModelPop() {
  if (!state.activeId) return openProfileDialog(true);
  if (narrow()) $('modelpop').style.setProperty('--pop-top', $('modelpill').getBoundingClientRect().bottom + 8 + 'px'); // phones: full-width, under the pill
  $('modelpop').hidden = false; $('modelbtn').setAttribute('aria-expanded', 'true'); $('modelq').setAttribute('aria-expanded', 'true'); $('modelq').value = ''; filterModels(); $('modelq').focus();
}
function setHi(i) {
  const rows = $('modellist').querySelectorAll('.mopt'); if (!rows.length) return;
  modelHi = (i + rows.length) % rows.length;
  rows.forEach((r, k) => { r.classList.toggle('hi', k === modelHi); r.setAttribute('aria-selected', String(k === modelHi)); });
  $('modelq').setAttribute('aria-activedescendant', rows[modelHi].id); rows[modelHi].scrollIntoView({ block: 'nearest' });
}
function pickModel(id) { $('model').value = id; $('model').onchange(); renderModelBtn(); closeModelPop(); $('modelbtn').focus(); }
function filterModels() {
  const q = $('modelq').value.trim(), terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...$('model').options].map((o) => o.value).filter(Boolean);
  const hits = Lib.matchModels(all, q);
  modelShown = hits.slice(0, MODEL_CAP);
  const rows = modelShown.map((id, i) => {
    const b = el('button', 'mopt' + (id === settings.model ? ' cur' : ''), id); b.type = 'button'; b.id = 'mopt-' + i; b.setAttribute('role', 'option'); b.tabIndex = -1;
    if (id === settings.model) b.append(svg(['M5 12l5 5L20 7']));
    b.onclick = () => pickModel(id); return b;
  });
  $('modellist').replaceChildren(...(rows.length ? rows : [el('div', 'mnote', !all.length ? 'No models loaded yet. Click the refresh button to fetch them.' : `No models match “${q}”.`)]));
  $('modelcount').textContent = all.length ? `${hits.length} of ${all.length} models${hits.length > MODEL_CAP ? ` · showing the first ${MODEL_CAP}, keep typing to narrow` : ''}` : '';
  setHi(terms.length ? 0 : Math.max(0, modelShown.indexOf(settings.model)));
}
$('modelbtn').onclick = () => ($('modelpop').hidden ? openModelPop() : closeModelPop());
$('modelbtn').onkeydown = (e) => { if (e.key === 'ArrowDown' && $('modelpop').hidden) { e.preventDefault(); openModelPop(); } };
$('modelq').oninput = filterModels;
$('modelq').onkeydown = (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setHi(modelHi + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(modelHi - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (modelShown[modelHi]) pickModel(modelShown[modelHi]); }
  else if (e.key === 'Escape') { e.preventDefault(); closeModelPop(); $('modelbtn').focus(); }
};
document.addEventListener('mousedown', (e) => { if (!$('modelpop').hidden && !$('modelpill').contains(e.target)) closeModelPop(); });

function setModels(infos) {
  modelInfo = Object.fromEntries(infos.map((m) => [m.id, m]));
  const ids = infos.map((m) => m.id), saved = settings.model, sel = $('model');
  if (ids.length) { settings.meta = infos.some((m) => m.meta); window.api.patchSettings({ meta: settings.meta }); } // an empty list says nothing about the gateway
  sel.replaceChildren(...ids.map((id) => new Option(id, id)));
  // the saved choice is only ever changed by the user: keep it visible even if the provider stopped listing it
  if (saved && !ids.includes(saved)) sel.prepend(new Option(`${saved} (not in list)`, saved));
  else if (!saved) sel.prepend(new Option(ids.length ? 'Select a model…' : 'No models returned', ''));
  sel.value = saved;
  renderLevels(); renderModelBtn(); if (!$('modelpop').hidden) filterModels();
}

async function fetchModels() {
  if (!state.activeId) return openProfileDialog(true);
  const btn = $('fetch'), pid = state.activeId; btn.disabled = true; btn.classList.add('spin');
  try { const infos = await window.api.listModels(); if (pid !== state.activeId) return; setModels(infos); toast(`${infos.length} model${infos.length === 1 ? '' : 's'} loaded`); if (!chat.messages.length) showEmpty(); }
  catch (e) { showError('Fetch models failed: ' + cleanErr(e)); }
  finally { btn.disabled = false; btn.classList.remove('spin'); }
}

async function send() {
  const text = $('input').value.trim();
  if ((!text && !pending.length) || busy) return;
  if (!state.activeId) return openProfileDialog(true);
  if (!settings.model) return showError('Pick a model first: open the model picker (fetch models if the list is empty).');
  const atts = pending; pending = []; renderChips();
  $('input').value = '';
  const userRow = addUser(text, atts);
  chat.messages.push({ role: 'user', content: Lib.buildContent(text, atts), text, files: atts.map(({ name, size, kind }) => ({ name, size, kind })) });
  const reply = addAssistant();
  setBusy(true);
  try {
    const out = await window.api.chat(Lib.requestMessages(chat, personaOf(chat), { render: state.render }), (d) => reply.delta(d));
    chat.messages.push({ role: 'assistant', content: out.content, reasoning: out.reasoning }); // reasoning is display-only, never sent back
    reply.done(out.content, out.reasoning);
    chat.updated = Date.now();
    if (!chat.title) chat.title = (text || atts[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 40);
    persist();
    if (out.error) showError('Reply was cut off: ' + out.error); else if (out.stopped) toast('Stopped');
  } catch (e) {
    // drop the failed turn and put the draft back in front of whatever was typed meanwhile
    chat.messages.pop(); userRow.remove(); reply.row.remove();
    $('input').value = [text, $('input').value].filter(Boolean).join('\n');
    pending = [...atts, ...pending].slice(0, MAX_FILES); renderChips();
    if (cleanErr(e) === 'Stopped') toast('Stopped'); else showError(cleanErr(e));
  } finally { setBusy(false); focusInput(); }
}

// ---- Chat history ----
// While a reply is pending, switching/creating/deleting chats is locked so a late reply can't land in the wrong chat.
function setBusy(b) {
  busy = b; $('profile').disabled = b || !state.profiles.length; $('addprofile').disabled = b; for (const id of ['persona', 'newpersona', 'editpersona']) $(id).disabled = b; $('histnew').disabled = b; $('newchat').disabled = b; $('chatlist').classList.toggle('locked', b);
  const s = $('send'), label = b ? 'Stop' : 'Send'; // the send button doubles as Stop while a reply is running
  s.title = label; s.setAttribute('aria-label', label); s.querySelector('path').setAttribute('d', b ? 'M7 7h10v10H7z' : 'M12 19V5M5 12l7-7 7 7');
}
async function persist() {
  try { await window.api.saveChat(chat); await refreshList(); } catch (e) { showError('Could not save chat: ' + cleanErr(e)); }
}
async function refreshList() { chatList = await window.api.listChats(); renderList(); }

function renderChat() {
  if (!chat.messages.length) return showEmpty();
  $('log').replaceChildren();
  for (const m of chat.messages) {
    if (m.role === 'assistant') { addAssistant().done(m.content, m.reasoning); continue; }
    const urls = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : [];
    let k = 0;
    addUser(m.text || '', (m.files || []).map((f) => (f.kind === 'image' ? { ...f, url: urls[k++] } : f)));
  }
}
function startNew() {
  if (busy) return;
  chat = newChat(); showEmpty(); refreshPersonaUi(); renderList(); focusInput();
  if (narrow()) applyHist(false);
}
async function openChat(id) {
  if (busy || id === chat.id) return;
  try { chat = await window.api.loadChat(id); } catch (e) { return showError('Could not open chat: ' + cleanErr(e)); }
  renderChat(); refreshPersonaUi(); renderList(); focusInput();
  if (narrow()) applyHist(false);
}

let armedId = null, armTimer;
async function confirmDelete(id, btn) {
  if (busy) return;
  if (armedId !== id) { // first click arms, second click within 3s deletes
    armedId = id; btn.classList.add('armed'); btn.replaceChildren('Confirm?');
    clearTimeout(armTimer); armTimer = setTimeout(() => { armedId = null; renderList(); }, 3000);
    return;
  }
  armedId = null; clearTimeout(armTimer);
  try { await window.api.deleteChat(id); } catch (e) { return showError('Could not delete chat: ' + cleanErr(e)); }
  if (id === chat.id) { chat = newChat(); showEmpty(); refreshPersonaUi(); }
  refreshList();
}

function renderList() {
  const d = new Date(), today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), day = 864e5;
  const groupOf = (t) => (t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'Previous 7 days' : 'Older');
  const nodes = []; let last = '';
  for (const c of chatList.filter((c) => personaIdOf(c) === state.personaId)) {
    const g = groupOf(c.updated);
    if (g !== last) { nodes.push(el('div', 'grp', g)); last = g; }
    const row = el('div', 'chat-item' + (c.id === chat.id ? ' active' : ''));
    const open = el('button', 'chat-title', c.title || 'New chat'); open.type = 'button'; open.title = c.title || ''; open.onclick = () => openChat(c.id);
    const del = el('button', 'icon-btn del'); del.type = 'button'; del.title = 'Delete chat'; del.setAttribute('aria-label', 'Delete chat'); del.append(svg(ICON.trash));
    del.onclick = () => confirmDelete(c.id, del);
    const dup = el('button', 'icon-btn del'); dup.type = 'button'; dup.title = 'Duplicate to another persona'; dup.setAttribute('aria-label', 'Duplicate to another persona'); dup.append(svg(ICON.copy));
    dup.onclick = () => openDup(c);
    row.append(open, dup, del); nodes.push(row);
  }
  if (!nodes.length) nodes.push(el('div', 'grp', `No chats with ${state.personas.find((p) => p.id === state.personaId)?.name ?? 'this persona'} yet`));
  $('chatlist').replaceChildren(...nodes);
}

const narrow = () => matchMedia('(max-width: 720px)').matches;
const applyHist = (open) => document.querySelector('.app').classList.toggle('nohist', !open);
function savedHist() { try { return localStorage.getItem('hist') !== '0'; } catch { return true; } }
$('histbtn').onclick = () => {
  const open = document.querySelector('.app').classList.contains('nohist'); applyHist(open);
  try { localStorage.setItem('hist', open ? '1' : '0'); } catch {}
};
$('histscrim').onclick = () => applyHist(false); // narrow screens: tapping beside the history closes it

// The Android back button: close whatever is on top. Returns false when nothing was open.
function closeTopLayer() {
  const rich = document.querySelector('.richview'); if (rich) { rich.querySelector('.richview-bar .btn').click(); return true; }
  // Settings is the only dialog that opens another (the profile editor) on top of itself, so close any other one first.
  const open = [...document.querySelectorAll('dialog[open]')], dlg = open.find((d) => d.id !== 'prefs') || open[0];
  if (dlg) { dlg.close(); return true; }
  if ($('side').classList.contains('open')) { toggleSide(false); return true; }
  if (!$('modelpop').hidden) { closeModelPop(); return true; }
  if (narrow() && !document.querySelector('.app').classList.contains('nohist')) { applyHist(false); return true; }
  return false;
}


// ---- Personas ----
// The persona is fixed per chat; switching the dropdown filters the list and opens a fresh chat if the open one belongs elsewhere.
function personaChanged(st) {
  applyState(st);
  if (personaIdOf(chat) !== state.personaId) { chat = newChat(); showEmpty(); } else if (!chat.messages.length) showEmpty();
  refreshPersonaUi(); renderList();
}
async function selectPersona(id) {
  if (busy) return;
  try { personaChanged(await window.api.patchSettings({ personaId: id })); } catch (e) { showError(cleanErr(e)); applyState(state); }
}
let editingPersona = null, psDelTimer;
function openPersonaDialog(isNew) {
  const p = isNew ? { id: null, name: '', user: '', bot: '', prompt: '' } : state.personas.find((x) => x.id === state.personaId);
  editingPersona = p.id;
  $('pstitle').textContent = isNew ? 'New persona' : 'Edit persona';
  $('psname').value = p.name; $('psuser').value = p.user; $('psbot').value = p.bot; $('psprompt').value = p.prompt;
  $('psdelete').hidden = isNew || p.id === 'default'; clearTimeout(psDelTimer); $('psdelete').textContent = 'Delete persona'; $('pserr').hidden = true;
  $('personadlg').showModal(); $('psname').focus();
}
$('persona').onchange = () => selectPersona($('persona').value);
$('newpersona').onclick = () => openPersonaDialog(true);
$('editpersona').onclick = () => openPersonaDialog(false);
$('pscancel').onclick = () => $('personadlg').close();
$('psform').onsubmit = async (e) => {
  e.preventDefault(); $('pserr').hidden = true;
  try {
    const st = await window.api.savePersona({ id: editingPersona || undefined, name: $('psname').value, user: $('psuser').value, bot: $('psbot').value, prompt: $('psprompt').value });
    $('personadlg').close(); personaChanged(st); toast('Saved');
  } catch (err) { $('pserr').textContent = cleanErr(err); $('pserr').hidden = false; }
};
$('psdelete').onclick = async () => {
  if ($('psdelete').textContent !== 'Confirm delete') { // first click arms, second click within 3s deletes
    $('psdelete').textContent = 'Confirm delete'; clearTimeout(psDelTimer); psDelTimer = setTimeout(() => { $('psdelete').textContent = 'Delete persona'; }, 3000); return;
  }
  try { const st = await window.api.deletePersona(editingPersona); $('personadlg').close(); personaChanged(st); toast('Persona deleted'); }
  catch (err) { $('pserr').textContent = cleanErr(err); $('pserr').hidden = false; }
};

// Duplicate a chat into another persona: a copy with a new id; the original stays where it is.
let dupSource = null;
function openDup(c) {
  dupSource = c; $('duperr').hidden = true;
  $('dupsub').textContent = `Copy “${c.title || 'New chat'}” into:`;
  $('dupsel').replaceChildren(...state.personas.map((p) => new Option(p.name, p.id)));
  $('dupsel').value = state.personas.find((p) => p.id !== personaIdOf(c))?.id ?? personaIdOf(c);
  $('dupdlg').showModal();
}
$('dupcancel').onclick = () => $('dupdlg').close();
$('dupform').onsubmit = async (e) => {
  e.preventDefault(); $('duperr').hidden = true;
  try {
    const src = await window.api.loadChat(dupSource.id), now = Date.now();
    const copy = { ...src, id: newChat().id, title: `${src.title || 'New chat'} (copy)`, created: now, updated: now, personaId: $('dupsel').value };
    await window.api.saveChat(copy);
    $('dupdlg').close(); await selectPersona(copy.personaId); await refreshList(); await openChat(copy.id); toast('Chat duplicated');
  } catch (err) { $('duperr').textContent = cleanErr(err); $('duperr').hidden = false; }
};

let editingId = null, delTimer, keyDirty = false; // editingId null = creating a new profile
async function openProfileDialog(isNew, id = state.activeId) {
  editingId = isNew ? null : id;
  $('ptitle').textContent = isNew ? 'New profile' : 'Profile settings';
  $('templates').hidden = !isNew; $('pdelete').hidden = isNew;
  clearTimeout(delTimer); $('pdelete').textContent = 'Delete profile'; $('perr').hidden = true;
  const p = isNew ? { name: '', endpoint: '', format: 'auto' } : state.profiles.find((x) => x.id === editingId);
  $('pname').value = p.name; $('endpoint').value = p.endpoint; $('format').value = p.format || 'auto'; $('key').type = 'password';
  keyDirty = false;
  try { $('key').value = isNew ? '' : await window.api.getProfileKey(editingId); }
  catch (e) { $('key').value = ''; $('perr').textContent = cleanErr(e); $('perr').hidden = false; } // saving without typing a key keeps the stored one
  $('settings').showModal(); (isNew ? $('pname') : $('key')).focus();
}
const openSettings = () => openProfileDialog(!state.activeId);

// Switching/saving/deleting a profile: reload everything that depends on the endpoint, then fetch its models.
function onProfileChanged(st) {
  applyState(st); modelInfo = {};
  $('model').replaceChildren(new Option(settings.model || 'No model selected', settings.model || ''));
  renderModelBtn(); closeModelPop();
  renderLevels(); if (!chat.messages.length) showEmpty();
  if (!state.activeId) return;
  if (settings.hasKey || isLocal(settings.endpoint)) fetchModels(); else toast(`${settings.name}: add your API key in settings`);
}

// A new profile, or an edit to the active one, reloads models etc. Touching another profile only refreshes the lists.
function profileSaved(st, switched) {
  if (switched) onProfileChanged(st); else applyState(st);
  if ($('prefs').open) renderProfiles();
}

function renderTemplates() {
  const fill = (name, endpoint) => { $('pname').value = name; $('endpoint').value = endpoint; (endpoint ? $('key') : $('endpoint')).focus(); };
  const chips = state.templates.map((t) => { const c = el('button', 'chip', t.name); c.type = 'button'; c.onclick = () => fill(t.name, t.endpoint); return c; });
  const custom = el('button', 'chip', 'Custom'); custom.type = 'button'; custom.onclick = () => fill('', '');
  $('templates').replaceChildren(...chips, custom);
}

$('pform').onsubmit = async (e) => {
  e.preventDefault(); $('perr').hidden = true;
  try {
    const p = { id: editingId || undefined, name: $('pname').value, endpoint: $('endpoint').value, format: $('format').value };
    if (keyDirty) p.key = $('key').value; // an untouched key field must never overwrite the stored key
    const st = await window.api.saveProfile(p);
    $('settings').close(); profileSaved(st, !p.id || p.id === state.activeId); toast('Saved');
  } catch (err) { $('perr').textContent = cleanErr(err); $('perr').hidden = false; } // inline: toasts sit under the modal dialog
};
$('pcancel').onclick = () => $('settings').close();
$('pdelete').onclick = async () => {
  if ($('pdelete').textContent !== 'Confirm delete') { // first click arms, second click within 3s deletes
    $('pdelete').textContent = 'Confirm delete'; clearTimeout(delTimer); delTimer = setTimeout(() => { $('pdelete').textContent = 'Delete profile'; }, 3000); return;
  }
  try { const st = await window.api.deleteProfile(editingId); $('settings').close(); profileSaved(st, st.activeId !== state.activeId); toast('Profile deleted'); }
  catch (err) { $('perr').textContent = cleanErr(err); $('perr').hidden = false; }
};
$('profile').onchange = async () => {
  try { onProfileChanged(await window.api.activateProfile($('profile').value)); }
  catch (err) { showError(cleanErr(err)); applyState(state); }
};
$('key').oninput = () => { keyDirty = true; };
$('reveal').onclick = () => { const k = $('key'); k.type = k.type === 'password' ? 'text' : 'password'; };
$('gear').onclick = () => openPrefs(state.activeId ? 'appearance' : 'profiles');
$('fetch').onclick = fetchModels;
$('model').onchange = () => { settings.model = $('model').value; window.api.patchSettings({ model: settings.model }); renderLevels(); if (!chat.messages.length) showEmpty(); };
$('newchat').onclick = $('histnew').onclick = startNew;
$('send').onclick = () => (busy ? window.api.stopChat() : send());
$('attach').onclick = () => $('picker').click();
$('picker').onchange = async () => { await attach([...$('picker').files]); $('picker').value = ''; };
let dragDepth = 0; // dragenter/leave fire for every child element, so count them
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').classList.add('on'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on'); attach([...e.dataTransfer.files]); });
$('input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !touch.matches) { e.preventDefault(); send(); } };

// ---- Settings dialog: Appearance / Profiles / Replies ----
const PANES = ['appearance', 'profiles', 'replies'];
let prefsDirty = false; // a Replies switch changed: redraw the open chat when the dialog closes
function showPane(name, focus) {
  for (const n of PANES) {
    const tab = $('tab-' + n), on = n === name;
    tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; $('pane-' + n).hidden = !on;
    if (on && focus) tab.focus();
  }
}
function openPrefs(pane) {
  const now = Lib.themeColors(state.theme); $('c1').value = now.a1; $('c2').value = now.a2; // shortcut: custom colors start from the current theme; they aren't remembered while a preset is active
  renderThemes(); renderProfiles(); syncReplies(); showPane(pane); $('prefs').showModal(); $('tab-' + pane).focus();
}
for (const n of PANES) $('tab-' + n).onclick = () => showPane(n);
$('prefs').querySelector('[role=tablist]').onkeydown = (e) => {
  const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
  e.preventDefault(); showPane(PANES[(PANES.indexOf(document.activeElement.dataset.pane) + d + PANES.length) % PANES.length], true);
};
$('prefsclose').onclick = () => $('prefs').close();
$('prefs').onclose = () => {
  if (prefsDirty && !busy && chat.messages.length) { const top = $('scroll').scrollTop; renderChat(); $('scroll').scrollTop = top; }
  prefsDirty = false; // shortcut: a reply that is still streaming keeps its old look until the chat is reopened
};

async function saveTheme(theme) {
  applyTheme(theme); // show it at once; the saved (validated) copy replaces it below
  try { applyState(await window.api.patchSettings({ theme })); } catch (e) { showError(cleanErr(e)); applyState(state); }
  renderThemes();
}
function renderThemes() {
  const tiles = [...Lib.THEMES, { id: 'custom', name: 'Custom', a1: $('c1').value, a2: $('c2').value }];
  $('themegrid').replaceChildren(...tiles.map((t) => {
    const b = el('button', 'theme'), sw = el('i'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t.id === state.theme.id));
    sw.style.background = `linear-gradient(135deg, ${t.a1}, ${t.a2})`; b.append(sw, t.name);
    b.onclick = () => saveTheme(t.id === 'custom' ? { id: 'custom', a1: $('c1').value, a2: $('c2').value } : { id: t.id }); return b;
  }));
}
for (const c of [$('c1'), $('c2')]) { // live preview while dragging; saved when the picker commits
  c.oninput = () => applyTheme({ id: 'custom', a1: $('c1').value, a2: $('c2').value });
  c.onchange = () => saveTheme({ id: 'custom', a1: $('c1').value, a2: $('c2').value });
}

function renderProfiles() {
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  $('proflist').replaceChildren(...(state.profiles.length ? state.profiles.map((p) => {
    const active = p.id === state.activeId, row = el('div', 'prow' + (active ? ' active' : '')), info = el('div'), nm = el('strong', null, p.name);
    if (active) nm.append(el('span', 'tag', 'Active'));
    info.append(nm, el('small', null, host(p.endpoint) + (p.hasKey ? '' : ' · no API key')));
    const ed = el('button', 'btn', 'Edit'); ed.type = 'button'; ed.setAttribute('aria-label', `Edit ${p.name}`); ed.onclick = () => openProfileDialog(false, p.id);
    row.append(info, ed); return row;
  }) : [el('p', 'sub', 'No profiles yet.')]));
}
$('addprofile').onclick = () => openProfileDialog(true);

function syncReplies() {
  for (const c of document.querySelectorAll('[data-render]')) c.checked = !!state.render[c.dataset.render];
  for (const k of ['css', 'js']) document.querySelector(`[data-render=${k}]`).disabled = !state.render.html; // they only apply inside HTML
}
for (const c of document.querySelectorAll('[data-render]')) c.onchange = async () => {
  try { applyState(await window.api.patchSettings({ render: { [c.dataset.render]: c.checked } })); prefsDirty = true; }
  catch (e) { showError(cleanErr(e)); applyState(state); }
  syncReplies();
};

(async () => {
  const first = await window.api.getSettings(); applyState(first); renderTemplates(); chat = newChat(); refreshPersonaUi();
  if (settings.model) $('model').replaceChildren(new Option(settings.model, settings.model));
  renderModelBtn();
  showEmpty(); renderLevels();
  applyHist(narrow() ? false : savedHist());
  refreshList().catch((e) => showError('Could not load chats: ' + cleanErr(e)));
  if (!state.activeId) { openProfileDialog(true); if (first.notice) { $('perr').textContent = first.notice; $('perr').hidden = false; } } // toasts sit under the modal dialog
  else { focusInput(); if (first.notice) showError(first.notice); }
})();
