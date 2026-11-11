// shortcut: elements by id come back as any, so their own properties (value, checked, showModal…) need no casts; give it per-id types if that hides real bugs
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const svg = (paths) => { const s = svgEl('svg', { viewBox: '0 0 24 24' }); s.append(...paths.map((d) => svgEl('path', { d }))); return s; };
const ICON = {
  // App mark, printed by build/mkicon.py (same strokes as build/icon.svg, at 24px). Keep in sync with .mark in index.html.
  logo: ['M15.08 12.87C13.77 15.67 10.44 16.88 7.63 15.58C4.83 14.27 3.62 10.94 4.92 8.13C6.23 5.33 9.56 4.12 12.37 5.42',
    'M8.92 11.13C10.23 8.33 13.56 7.12 16.37 8.42C19.17 9.73 20.38 13.06 19.08 15.87C17.77 18.67 14.44 19.88 11.63 18.58'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'],
  x: ['M18 6L6 18M6 6l12 12'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  regen: ['M21 12a9 9 0 1 1-2.6-6.4L21 8', 'M21 3v5h-5'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
  alert: ['M12 8v5', 'M12 16.5v.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
};
// Accent colors are two CSS variables on <html>; every gradient, ring and tint in index.html derives from them.
// With the gradient off, --a2 is a1 too, so every var(--grad) paints one flat color.
function applyTheme(t) {
  const c = Lib.themeColors(t), r = document.documentElement.style;
  r.setProperty('--a1', c.a1); r.setProperty('--a2', t?.gradient ? c.a2 : c.a1);
  try { localStorage.setItem('theme', JSON.stringify(t)); } catch {} // only a start-up cache; settings.json is the source of truth
}
try { const t = JSON.parse(localStorage.getItem('theme')); if (Lib.cleanTheme(t)) applyTheme(t); } catch {}

// Touch screens: Enter makes a new line (the send button sends), and the keyboard only opens when the user taps the box,
// so it never pops up over a reply.
const touch = matchMedia('(pointer: coarse)');
/** Puts the cursor in the message box, except on touch screens, where that would open the keyboard over the chat. */
const focusInput = () => { if (!touch.matches) $('input').focus(); };
/** Grows a message box to its text where CSS field-sizing is missing (Safari before 26.2); its max-height still caps it. A no-op elsewhere.
 * Only the message box and the edit box: the settings boxes have no max-height and keep the height the user drags them to. */
const fitBox = CSS.supports('field-sizing', 'content') ? () => {} : (/** @type {HTMLTextAreaElement} */ t) => {
  const cs = getComputedStyle(t); t.style.height = 'auto';
  t.style.height = (cs.boxSizing === 'border-box' ? t.scrollHeight + t.offsetHeight - t.clientHeight : t.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) + 'px';
};
document.addEventListener('input', (e) => { if (e.target instanceof HTMLTextAreaElement && e.target.matches('#input, .edit textarea')) fitBox(e.target); });

const newChat = () => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), title: '', created: Date.now(), updated: Date.now(), personaId: state.personaId, messages: [] });
let state = { profiles: [], activeId: '', templates: [], effort: '', personas: [], personaId: 'default', render: { markdown: true, html: true, css: true, js: true }, theme: { id: 'indigo', gradient: false }, summarizer: { profileId: '', model: '' }, contextLimit: { on: false, tokens: Lib.DEFAULT_CTX } }, settings = {}, chat = newChat(), chatList = [], busy = false, toastTimer, errTimer;

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
  refreshSel($('profile'), $('persona'));
}
// A chat whose persona is missing or was deleted counts as Default.
const personaIdOf = (c) => (state.personas.some((p) => p.id === c.personaId) ? c.personaId : 'default');
const personaOf = (c) => state.personas.find((p) => p.id === personaIdOf(c));
function refreshPersonaUi() { const bot = personaOf(chat)?.bot; $('input').placeholder = bot ? `Message ${bot}` : 'Message'; }
const isLocal = (u) => /^https?:\/\/(localhost|127\.|\[::1\]|10\.|192\.168\.)/i.test(u || '');

function toast(text) {
  $('toast').textContent = text; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1800);
}
/** Copies text and says so. Both apps copy through native code (Electron's main process, the Android plugin), since the page's own clipboard access is blocked or unreliable. */
async function copy(text) {
  try { await window.api.copyText(text); toast('Copied'); } catch { toast('Copy failed'); }
}
// The header floats over the chat and the composer is sticky at its bottom; their heights keep content from starting, or landing on focus, under them.
{
  const head = document.querySelector('header'), foot = document.querySelector('footer'), bars = new ResizeObserver(() => {
    $('scroll').style.setProperty('--head-h', head.offsetHeight + 'px'); $('scroll').style.setProperty('--foot-h', foot.offsetHeight + 'px');
  });
  bars.observe(head, { box: 'border-box' }); bars.observe(foot, { box: 'border-box' }); // the header's padding holds the status-bar inset
}
function scrollDown() { $('scroll').scrollTop = $('scroll').scrollHeight; }
// Animations started from script; the CSS reduced-motion rule doesn't reach these, so they check it themselves.
const fade = (node, from, ms) => { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) node.animate([{ opacity: from }, { opacity: 1 }], { duration: ms, easing: 'ease-out' }); };
function push(node) { $('log').querySelector('.empty')?.remove(); $('log').append(node); scrollDown(); return node; }

function miniBtn(icon, label, onclick) {
  const b = el('button', 'mini'); b.type = 'button'; b.append(svg(icon), label); b.onclick = onclick; return b;
}
const copyBtn = (getText, label = 'Copy') => miniBtn(ICON.copy, label, () => copy(getText()));

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
  const shut = () => { ov.remove(); document.removeEventListener('keydown', onKey); /** @type {HTMLElement|null} */ (prev)?.focus?.(); };
  close.type = 'button'; close.onclick = shut; f.setAttribute('sandbox', 'allow-scripts'); f.title = 'Rich content';
  bar.append(el('span', null, 'Preview'), close); ov.append(bar, f); document.body.append(ov);
  document.addEventListener('keydown', onKey); close.focus(); loadFrame(f, html);
}
// Frames report their content height so a rich block grows to fit inside the reply.
addEventListener('message', (e) => {
  const h = e.data?.richHeight; if (typeof h !== 'number') return;
  const f = [.../** @type {NodeListOf<HTMLIFrameElement>} */ (document.querySelectorAll('.rich iframe'))].find((x) => x.contentWindow === e.source);
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
const MAX_FILES = 5, MAX_IMG = 25 * 1024 * 1024, MAX_PDF = 25 * 1024 * 1024, MAX_TEXT = 200000;
const IMG_SIDE = 2048, KEEP_IMG = 2 * 1024 * 1024; // images are stored at most 2048 px on the long side; a small one that fits is kept as is
let pending = [];
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const cleanErr = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const readDataUrl = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(f); });

/**
 * An attached image as a data URL, sized for chat. The longest side becomes at most 2048 px, which is what the big
 * vision APIs scale down to anyway, so a phone photo goes from megabytes to a few hundred KB. That keeps chats light
 * enough to open and send on a phone (every message re-sends the chat's earlier images). An image that already fits
 * and is at most 2 MB is kept byte for byte, so screenshots stay sharp and small GIFs keep their animation.
 */
async function imageUrl(f) {
  const bmp = await createImageBitmap(f); // applies the photo's EXIF rotation
  try {
    const { w, h, scaled } = Lib.fitSize(bmp.width, bmp.height, IMG_SIDE);
    if (!scaled && f.size <= KEEP_IMG) return await readDataUrl(f);
    const c = el('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    let alpha = false; // JPEG can't keep transparency, so only images that have none become JPEG
    if (f.type !== 'image/jpeg') { const px = g.getImageData(0, 0, w, h).data; for (let i = 3; i < px.length && !alpha; i += 4) alpha = px[i] < 255; }
    return alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
  } finally { bmp.close(); }
}
/** How many bytes a base64 data URL holds. */
const dataUrlBytes = (u) => Math.round((u.length - u.indexOf(',') - 1) * 3 / 4);

async function attach(files) {
  for (const f of files) {
    if (pending.length >= MAX_FILES) { toast(`Max ${MAX_FILES} files per message`); break; }
    try {
      let a = { name: f.name, size: f.size };
      if (/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) {
        if (f.size > MAX_IMG) { toast(`${f.name}: image is over 25 MB`); continue; }
        const url = await imageUrl(f);
        a = { ...a, kind: 'image', url, size: dataUrlBytes(url) }; // the chip shows what is actually stored and sent
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

function addUser(text, atts, m) {
  const row = el('div', 'row user'), body = el('div', 'ubody');
  for (const a of atts) body.append(chip(a));
  let b = null;
  if (text) { b = el('div', 'bubble'); inline(b, text); body.append(b); }
  body.append(msgActions(m, body, b)); row.append(body); return push(row);
}
// The buttons act on the message object, since a message's index changes when the chat is cut short.
function msgActions(m, body, bubble, ...lead) {
  const a = el('div', 'actions');
  if (m.versions?.length > 1) a.append(versionNav(m));
  a.append(...lead, miniBtn(ICON.regen, 'Regenerate', () => regenerate(m)), miniBtn(ICON.edit, 'Edit', () => editMsg(m, body, bubble, a)));
  return a;
}
// ‹ 2/3 › switches only this message; the messages after it stay as they are.
function versionNav(m) {
  const n = m.versions.length, v = m.v ?? n - 1, nav = el('span', 'versions');
  const arrow = (icon, label, d) => { const b = miniBtn(icon, '', () => setMsg(m, Lib.showVersion(m, v + d))); b.title = b.ariaLabel = label; b.disabled = v + d < 0 || v + d >= n; return b; };
  nav.append(arrow(ICON.left, 'Previous version', -1), el('span', 'vcount', `${v + 1}/${n}`), arrow(ICON.right, 'Next version', 1));
  return nav;
}
const rerender = (top = $('scroll').scrollTop) => { renderChat(); $('scroll').scrollTop = top; };
/** Puts `next` in place of message `m`, saves and redraws. The title follows the first message unless it was changed. */
function setMsg(m, next) {
  if (busy) return toast('Wait for the reply to finish');
  const i = chat.messages.indexOf(m);
  if (i < 0) return;
  if (i === 0 && m.role === 'user' && chat.title === titleOf(m.text, m.files)) chat.title = titleOf(next.text, next.files);
  if (i < (chat.summary?.upto ?? 0)) delete chat.summary; // it no longer says what this message says; a new one is made when needed
  chat.messages[i] = next; persist(); rerender();
}

// Edit adds a version of the message; later messages stay, and a later Regenerate uses the edited text.
function editMsg(m, body, bubble, actions) {
  if (busy) return toast('Wait for the reply to finish');
  const user = m.role === 'user', box = el('div', 'edit'), ta = el('textarea'), bar = el('div', 'edit-bar');
  const cancel = el('button', 'btn', 'Cancel'), save = el('button', 'btn primary', 'Save');
  cancel.type = save.type = 'button'; ta.value = user ? m.text || '' : m.content; ta.setAttribute('aria-label', 'Edit message');
  bar.append(cancel, save); box.append(ta, bar);
  const hide = [bubble, actions].filter(Boolean);
  const close = () => { box.remove(); for (const n of hide) n.style.display = ''; actions.lastElementChild.focus(); }; // Edit is always the last button
  cancel.onclick = close;
  ta.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  save.onclick = () => {
    if (busy) return toast('Wait for the reply to finish'); // the box can stay open while a new message is sent
    const text = ta.value.trim();
    if (!text && !(user && m.files?.length)) return toast("A message can't be empty");
    if (text === (user ? m.text || '' : m.content).trim()) return close();
    chat.updated = Date.now(); setMsg(m, Lib.addVersion(m, user ? Lib.editUser(m, text) : { content: text, reasoning: m.reasoning }));
  };
  for (const n of hide) n.style.display = 'none';
  actions.before(box); fitBox(ta); ta.focus();
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
    /** A note in place of the typing dots, such as "Summarizing…"; null puts the dots back. */
    status(t) { b.replaceChildren(t ? el('span', 'status', t) : dots); },
    delta(d) { reasoning += d.reasoning || ''; content += d.content || ''; raf ||= requestAnimationFrame(flush); },
    done(text, finalReasoning = reasoning, m) {
      cancelAnimationFrame(raf); raf = 0; row.classList.remove('thinking');
      render(b, text || '(The model returned no text.)');
      if (cNode) fade(b, .55, 120); // streamed plain text becomes the formatted reply; soften the swap
      tb.classList.toggle('placeholder', !finalReasoning); tb.textContent = finalReasoning || NO_REASONING;
      body.append(msgActions(m, body, b, copyBtn(() => text))); scrollDown();
    },
  };
}

function showEmpty() {
  const box = el('div', 'empty'), big = el('div', 'big');
  big.append(svg(ICON.logo));
  box.append(big, el('h1', null, 'New chat'));
  const p = el('p');
  if (!state.activeId) { const a = el('button', 'linkish', 'Create a profile'); a.onclick = () => openProfileDialog(true); p.append(a, ' (endpoint + API key) to get started.'); }
  else if (settings.model) { const ps = personaOf(chat); p.textContent = `Chatting with ${ps.bot ? (ps.user ? `${ps.bot} as ${ps.user}` : ps.bot) : settings.model}`; }
  else { const a = el('button', 'linkish', 'Open settings'); a.onclick = openSettings; p.append(a, ' and fetch models to get started.'); }
  const chips = el('div', 'chips');
  for (const s of ['Explain a concept simply', 'Write a bash one-liner', 'Brainstorm project ideas']) {
    const c = el('button', 'chip', s); c.onclick = () => { $('input').value = s + ': '; fitBox($('input')); $('input').focus(); }; chips.append(c);
  }
  box.append(p, chips); $('log').replaceChildren(box);
}

// ---- Reasoning level: always list every level any major provider uses; the model rejects what it can't do ----
const LEVELS = [
  ['', 'Disabled', 'No reasoning field, for old models'], ['none', 'None', 'Reasoning off'], ['minimal', 'Minimal', 'Barely any thinking'],
  ['low', 'Low', 'Quick, light reasoning'], ['medium', 'Medium', 'Balanced'], ['high', 'High', 'Deeper reasoning'],
  ['xhigh', 'Extra high', 'Very deep, slower'], ['max', 'Max', 'Maximum effort, slowest'],
];
let modelInfo = {};
// Models that say they lack `tools` get no search. After a restart modelInfo is empty, so fall back to the flag saved with the profile.
const toolsOk = () => (modelInfo[settings.model] ? modelInfo[settings.model].tools !== false : !settings.noTools);
// The chat model's context limit: from its model list (or, after a restart, the copy saved with the profile); when the list gives none,
// the user's number for unlisted models, or 300K.
const ctxLimit = () => (modelInfo[settings.model] ? modelInfo[settings.model].ctx : settings.ctx) || (state.contextLimit.on ? state.contextLimit.tokens : Lib.DEFAULT_CTX);

function renderLevels() {
  const info = modelInfo[settings.model] || {};
  $('reasonmodel').textContent = settings.model || 'No model selected';
  $('levels').replaceChildren(...LEVELS.map(([v, name, desc]) => {
    const b = el('button', 'level'); b.type = 'button'; b.title = desc; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === (settings.effort || '')));
    const nm = el('span', 'nm', name); if (v && v === info.default) nm.append(el('span', 'tag', 'model default'));
    b.append(nm, el('span', 'ds', desc));
    b.onclick = () => { settings.effort = v; window.api.patchSettings({ effort: v }); renderLevels(); $('reasonpop').hidePopover(); $('reasoning').focus(); toast(`Reasoning: ${name}`); };
    return b;
  }));
  $('reasonnote').textContent = 'Levels the model does not support are rejected and show an error.'
    + (settings.thinkingSwitch ? ' On this provider, None turns thinking off.' : '');
}
// The levels open in a popover above the brain button (#reasoning is its popovertarget), placed like the dropdown lists
$('reasonpop').addEventListener('beforetoggle', (e) => {
  const open = /** @type {ToggleEvent} */ (e).newState === 'open'; $('reasoning').setAttribute('aria-expanded', String(open));
  if (open) placePop($('reasonpop'), $('reasoning'), 520);
});
$('reasonpop').addEventListener('toggle', () => { if ($('reasonpop').matches(':popover-open')) /** @type {HTMLElement|null} */ ($('levels').querySelector('[aria-checked="true"]'))?.focus(); });

// ---- ⋯ menu and Stats for nerds (read from the stats saved on each reply) ----
const closeMore = () => { $('morepop').hidden = $('morepop').inert = true; $('more').setAttribute('aria-expanded', 'false'); };
$('more').onclick = () => { const open = $('morepop').hidden; $('morepop').hidden = $('morepop').inert = !open; $('more').setAttribute('aria-expanded', String(open)); if (open) $('statsbtn').focus(); };
$('morewrap').onkeydown = (e) => { if (e.key === 'Escape' && !$('morepop').hidden) { e.stopPropagation(); closeMore(); $('more').focus(); } };
document.addEventListener('mousedown', (e) => { if (!$('morepop').hidden && !$('morewrap').contains(e.target)) closeMore(); });
$('statsbtn').onclick = () => { closeMore(); openStats(); };

const fmtMs = (v) => (v == null ? ['—'] : v < 1000 ? [String(Math.round(v)), 'ms'] : [(v / 1000).toFixed(2), 's']);
const fmtTps = (v, est) => (v == null ? ['—'] : [(est ? '~' : '') + v.toFixed(1), 'tok/s']);
const fmtTok = (v) => (v == null ? ['—'] : [v.toLocaleString(), 'tokens']);
/**
 * One stat as a tile: the big value and the small unit under/next to it.
 * @param {string} label
 * @param {string[]} pair
 */
function tile(label, [value, unit]) {
  const t = el('div', 'tile'), b = el('b', null, value);
  if (unit) b.append(el('i', null, unit));
  t.append(el('small', null, label), b); return t;
}
/** One metric as a line from a zero baseline, one point per reply; hovering a point shows its value. */
function lineChart(title, points, key, fmt) {
  const box = el('div', 'chart'), pts = points.map((s, i) => ({ i, s, v: s[key] })).filter((p) => typeof p.v === 'number');
  box.append(el('h4', null, title));
  if (!pts.length) { box.append(el('p', 'sub', 'No data yet.')); return box; }
  const W = 420, H = 116, L = 8, R = 8, T = 24, B = 18, max = Math.max(...pts.map((p) => p.v)) || 1, n = points.length;
  const x = (i) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : (W - L - R) / 2), y = (v) => H - B - (v / max) * (H - T - B);
  const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}, ${pts.length} replies, highest ${fmt(max).join(' ')}` });
  const label = (tx, ty, text, anchor = 'start') => { const t = svgEl('text', { x: tx, y: ty, 'text-anchor': anchor }); t.textContent = text; return t; };
  s.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(0), y2: y(0) }), svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(max), y2: y(max) }),
    label(L, T - 8, fmt(max).join(' ')), label(L, H - 3, `Reply ${points[0].n}`), ...(n > 1 ? [label(W - R, H - 3, `Reply ${points[n - 1].n}`, 'end')] : []),
    svgEl('polyline', { class: 'ln', points: pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ') }));
  for (const p of pts) {
    const g = svgEl('g'), tip = svgEl('title');
    tip.textContent = `Reply ${p.s.n} · ${p.s.model}: ${fmt(p.v, p.s.est).join(' ')}`;
    g.append(tip, svgEl('circle', { class: 'hit', cx: x(p.i), cy: y(p.v), r: 12 }), svgEl('circle', { class: 'pt', cx: x(p.i), cy: y(p.v), r: 4 }));
    s.append(g);
  }
  box.append(s); return box;
}
function renderStats() {
  const model = $('statsmodel').value, s = Lib.chatStats(chat, model || undefined), last = s.last;
  $('statscharts').replaceChildren();
  if (!last) return $('statsbody').replaceChildren(el('p', 'statnote', 'No replies with stats yet. They are recorded for every new reply.'));
  const avgEst = s.points.some((p) => p.est), tiles = el('div', 'tiles'), notes = [];
  tiles.append(
    tile('Last TTFT', fmtMs(last.ttft)), tile('Avg TTFT', fmtMs(s.avgTtft)),
    tile('Last speed', fmtTps(last.tps, last.est)), tile('Avg speed', fmtTps(s.avgTps, avgEst)),
    tile('Tokens used in this chat', fmtTok(s.used || null)), tile('Context size', fmtTok(s.context)),
  );
  notes.push(`Averages over ${s.points.length} repl${s.points.length === 1 ? 'y' : 'ies'}${model ? ` from ${model}` : ''}. Tokens used counts every reply, including ones regenerated or edited away.`);
  if (s.est || s.noTotal) notes.push('Some replies have no token counts, because the provider didn\'t send them or the reply was stopped early.'
    + (s.est ? ' Their speed (marked ~) is estimated from the text length.' : '') + ' They aren\'t in the token totals.');
  $('statsbody').replaceChildren(tiles, ...notes.map((t) => el('p', 'statnote', t)));
  if ($('statschart').checked) $('statscharts').append(lineChart('Time to first token', s.points, 'ttft', fmtMs), lineChart('Tokens per second', s.points, 'tps', fmtTps));
}
function openStats() {
  const { models } = Lib.chatStats(chat), sel = $('statsmodel'), keep = sel.value;
  sel.replaceChildren(new Option('All models', ''), ...models.map((m) => new Option(m, m)));
  sel.value = models.includes(keep) ? keep : ''; refreshSel(sel);
  $('statsfilter').hidden = models.length < 2; // the filter only matters once the chat has used more than one model
  try { $('statschart').checked = localStorage.getItem('statsChart') === '1'; } catch {}
  renderStats(); $('statsdlg').showModal();
}
$('statsmodel').onchange = renderStats;
$('statschart').onchange = () => { try { localStorage.setItem('statsChart', $('statschart').checked ? '1' : '0'); } catch {} renderStats(); };

// ---- Searchable model picker. The hidden <select id="model"> stays the source of truth; this is just a nicer way to choose from it. ----
let modelHi = 0, modelShown = [];
const MODEL_CAP = 200; // rendering hundreds of rows on every keystroke is slow; the count line tells the user to keep typing
function renderModelBtn() { $('modellabel').textContent = $('model').selectedOptions[0]?.text || 'No model selected'; }
function closeModelPop() { $('modelpop').hidden = $('modelpop').inert = true; $('modelbtn').setAttribute('aria-expanded', 'false'); $('modelq').setAttribute('aria-expanded', 'false'); $('modelq').removeAttribute('aria-activedescendant'); }
/** Opens the model picker (or the new-profile dialog when there is no profile yet); on phones it spans the screen under the pill. */
function openModelPop() {
  if (!state.activeId) return openProfileDialog(true);
  if (narrow()) $('modelpop').style.setProperty('--pop-top', $('modelpill').getBoundingClientRect().bottom + 8 + 'px'); // phones: full-width, under the pill
  $('modelpop').hidden = $('modelpop').inert = false; $('modelbtn').setAttribute('aria-expanded', 'true'); $('modelq').setAttribute('aria-expanded', 'true'); $('modelq').value = ''; filterModels(); $('modelq').focus();
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

/** @type {Map<HTMLElement, [HTMLElement, number]>} */
const popBtn = new Map();
/** Fixed, from its button's rect: the list is in the top layer, so a dialog can't clip it. It opens upward when there's more room above.
 * @param {HTMLElement} pop @param {HTMLElement} btn */
function placePop(pop, btn, cap = 320) {
  popBtn.set(pop, [btn, cap]); // so a resize can place it again
  const r = btn.getBoundingClientRect();
  const below = innerHeight - r.bottom - 14, above = r.top - 14, up = below < 200 && above > below;
  pop.classList.toggle('up', up);
  Object.assign(pop.style, { left: r.left + 'px', top: (up ? r.top - 6 : r.bottom + 6) + 'px', minWidth: r.width + 'px', maxWidth: innerWidth - r.left - 8 + 'px', maxHeight: Math.min(cap, up ? above : below) + 'px' });
}
// ---- Every other <select> opens the same glass list as the model picker. Each stays hidden as the source of truth: code still sets its options, value and disabled. ----
/** @type {Map<HTMLSelectElement, () => void>} */
const selSync = new Map();
/** Shows a select's value on its button. Setting `.value` fires no event, so call this after, as renderModelBtn is for the model; options and disabled are watched.
 * @param {...HTMLSelectElement} sels */
const refreshSel = (...sels) => { for (const s of sels) selSync.get(s)?.(); };
/** @param {HTMLSelectElement} sel */
function glassSelect(sel) {
  const btn = el('button', sel.closest('.pill') ? 'modelbtn selbtn' : 'selbtn'), label = el('span'), pop = el('div', 'selpop');
  const name = sel.getAttribute('aria-label') || sel.closest('label')?.firstChild?.textContent?.trim() || '';
  btn.type = 'button'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.append(label); btn.popoverTargetElement = pop;
  pop.popover = 'auto'; pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', name);
  const sync = () => { label.textContent = sel.selectedOptions[0]?.text ?? ''; btn.disabled = sel.disabled; btn.setAttribute('aria-label', `${name}: ${label.textContent}`); };
  selSync.set(sel, sync);
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  pop.addEventListener('beforetoggle', (e) => {
    const open = /** @type {ToggleEvent} */ (e).newState === 'open'; btn.setAttribute('aria-expanded', String(open)); if (!open) return;
    pop.replaceChildren(...[...sel.options].map((o) => {
      const b = el('button', 'mopt' + (o.selected ? ' cur' : ''), o.text); b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(o.selected)); b.disabled = o.disabled;
      if (o.selected) b.append(svg(['M5 12l5 5L20 7']));
      b.onclick = () => { pop.hidePopover(); btn.focus(); if (sel.value !== o.value) { sel.value = o.value; sync(); for (const t of ['input', 'change']) sel.dispatchEvent(new Event(t, { bubbles: true })); } };
      return b;
    }));
    placePop(pop, btn);
  });
  pop.addEventListener('toggle', () => { if (pop.matches(':popover-open')) /** @type {HTMLElement|null} */ (pop.querySelector('.mopt.cur:not(:disabled)') || pop.querySelector('.mopt:not(:disabled)'))?.focus(); });
  pop.onkeydown = (e) => {
    const rows = [...pop.querySelectorAll('.mopt:not(:disabled)')], i = rows.indexOf(/** @type {Element} */ (document.activeElement));
    const to = { ArrowDown: i + 1, ArrowUp: i < 0 ? -1 : i - 1, Home: 0, End: rows.length - 1 }[e.key]; // from no row, Up goes to the last
    if (to !== undefined) { e.preventDefault(); /** @type {HTMLElement|undefined} */ (rows[(to + rows.length) % rows.length])?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.hidePopover(); btn.focus(); } // only the list, not the dialog it's in
  };
  btn.onkeydown = (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !pop.matches(':popover-open')) { e.preventDefault(); pop.showPopover(); } };
  sel.hidden = true; sel.setAttribute('aria-hidden', 'true'); sel.tabIndex = -1; sel.before(btn); (sel.closest('label') || sel).after(pop); sync(); // outside a <label>, whose clicks would reach the button and toggle the list
}
document.querySelectorAll('select:not(#model)').forEach((s) => glassSelect(/** @type {HTMLSelectElement} */ (s)));
/** @type {HTMLElement|null} */
let shownPop = null; // the open .selpop, kept here so the scroll handler below costs nothing while none is open
document.addEventListener('beforetoggle', (e) => {
  const t = /** @type {HTMLElement} */ (e.target); if (!t.classList?.contains('selpop')) return;
  if (/** @type {ToggleEvent} */ (e).newState === 'open') shownPop = t; else if (shownPop === t) shownPop = null;
}, true); // beforetoggle doesn't bubble, so listen while it's captured
const closeSelPop = () => { const p = shownPop; p?.hidePopover(); return !!p; };
// a fixed list would drift off its field: close it when something around it scrolls (not the chat streaming elsewhere), follow it on resize (the phone keyboard)
document.addEventListener('scroll', (e) => { const p = shownPop; if (p && e.target !== p && e.target instanceof Node && e.target.contains(p)) p.hidePopover(); }, true);
addEventListener('resize', () => { const p = shownPop, b = p && popBtn.get(p); if (b) placePop(p, ...b); });

function setModels(infos) {
  modelInfo = Object.fromEntries(infos.map((m) => [m.id, m]));
  const ids = infos.map((m) => m.id), saved = settings.model, sel = $('model');
  if (ids.length) { // remember whether the current model lacks tools, so that is still known after a restart
    const known = modelInfo[settings.model]; settings.meta = infos.some((m) => m.meta); if (known) { settings.noTools = known.tools === false; settings.ctx = known.ctx || 0; }
    window.api.patchSettings({ meta: settings.meta, ...(known && { noTools: settings.noTools, ctx: settings.ctx }) });
  } // an empty list says nothing about the gateway
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

const titleOf = (text, files) => (text || files?.[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 40);
function ready() {
  if (!state.activeId) { openProfileDialog(true); return false; }
  if (!settings.model) { showError('Pick a model first: open the model picker (fetch models if the list is empty).'); return false; }
  return true;
}
// ---- Summaries: when the chat nears the model's context limit, its older messages are folded into chat.summary before the reply ----
/** Who writes this chat's summaries: the persona's own choice when it has one, else the default. A choice whose profile was deleted is skipped; an empty profile means the chat model. */
function summarizer() {
  const ok = (s) => s && (!s.profileId || state.profiles.some((p) => p.id === s.profileId)), own = personaOf(chat)?.summarizer;
  return ok(own) ? own : ok(state.summarizer) ? state.summarizer : { profileId: '', model: '' };
}
/**
 * Summarizes the older messages when the chat is close to the limit. Stop throws 'Stopped' like a reply would. Any other failure only says so
 * and the whole chat is sent: a cut-off summary is never kept, since the messages it stands for would no longer be sent.
 */
let sumFail = null; // {id, at}: the chat and its length when summarizing last failed
async function summarize(reply) {
  if (sumFail?.id === chat.id && chat.messages.length < sumFail.at + 4) return; // a failing summarizer is tried again two turns later, not on every send
  const cut = Lib.summaryDue(chat, ctxLimit(), personaOf(chat), { render: state.render });
  if (cut < 0) return;
  reply.status('Summarizing earlier messages…');
  const fail = (msg) => { sumFail = { id: chat.id, at: chat.messages.length }; reply.status(null); showError("Couldn't summarize the earlier messages, so the whole chat was sent: " + msg); };
  let out;
  try { out = await window.api.chat(Lib.summaryRequest(chat, personaOf(chat), cut), null, { summary: summarizer() }); }
  catch (e) { if (cleanErr(e) === 'Stopped') throw e; return fail(cleanErr(e)); }
  chat.used = (chat.used || 0) + (out.usage?.total_tokens || 0); // the summary used tokens too
  if (out.stopped) throw new Error('Stopped');
  const text = out.content.trim();
  if (out.error || !text) return fail(out.error || 'the model returned no text');
  chat.summary = { text, upto: cut, at: chat.messages.length }; sumFail = null;
  reply.status(null);
  $('log').querySelector('.sumdiv')?.remove(); $('log').querySelectorAll(':scope > .row')[cut].before(summaryDivider(chat.summary)); // one row per message, the pending reply last
}
/** The line where the summary starts; clicking it shows what the model now gets instead of the messages above. */
function summaryDivider(s) {
  const box = el('div', 'sumdiv'), b = el('button', null, 'Earlier messages summarized'), text = el('div', 'sumtext', s.text);
  b.type = 'button'; b.setAttribute('aria-expanded', 'false'); text.hidden = true;
  b.onclick = () => { text.hidden = !text.hidden; b.setAttribute('aria-expanded', String(!text.hidden)); };
  box.append(b, text); return box;
}

/**
 * Streams a reply to the chat as it stands, adds it and returns it (with `error` or `stopped` set when cut short; the caller
 * says so). With `base`, the reply is added as a new version of that message (`base` itself is left as it was).
 * On failure the reply row is removed, the error shown, and it rethrows.
 */
async function generate(base) {
  const reply = addAssistant();
  setBusy(true);
  try {
    await summarize(reply); // before the timing starts, so it never counts toward the reply's speed
    // Timing for Stats for nerds: t1 is the model's first text, and time spent waiting on web searches after it is left out of the speed.
    const model = settings.model, t0 = performance.now(); let t1 = 0, paused = 0, pauseAt = 0, sawReasoning = false;
    const onDelta = (d) => {
      const now = performance.now();
      if (d.note) { if (t1) pauseAt ||= now; }
      else { if (pauseAt) { paused += now - pauseAt; pauseAt = 0; } t1 ||= now; sawReasoning ||= !!d.reasoning; }
      reply.delta(d);
    };
    const out = await window.api.chat(Lib.requestMessages(chat, personaOf(chat), { render: state.render }), onDelta, { search: toolsOk(), mcp: toolsOk() && state.mcp.enabled });
    const t2 = performance.now(); if (pauseAt) paused += t2 - pauseAt;
    const stats = Lib.replyStats({ model, t0, t1, t2, paused, usage: out.usage, ctx: out.ctx, sent: out.sent, text: out.content + out.reasoning, sawReasoning });
    chat.used = (chat.used || 0) + (stats.total || 0); // a running total: it stays when this reply is later replaced or dropped
    const fields = { content: out.content, reasoning: out.reasoning, stats }; // reasoning and stats are display-only, never sent back
    const m = base ? Lib.addVersion(base, fields) : { role: 'assistant', ...fields };
    chat.messages.push(m); reply.done(out.content, out.reasoning, m);
    return out;
  } catch (e) {
    reply.row.remove();
    if (cleanErr(e) === 'Stopped') toast('Stopped'); else showError(cleanErr(e));
    throw e;
  } finally { setBusy(false); focusInput(); }
}

async function send() {
  const text = $('input').value.trim();
  if ((!text && !pending.length) || busy || !ready()) return;
  const atts = pending; pending = []; renderChips();
  $('input').value = ''; fitBox($('input'));
  const m = { role: 'user', content: Lib.buildContent(text, atts), text, files: atts.map(({ name, size, kind }) => ({ name, size, kind })) };
  chat.messages.push(m);
  const userRow = addUser(text, atts, m);
  try {
    const out = await generate();
    if (out.error) showError('Reply was cut off: ' + out.error); else if (out.stopped) toast('Stopped');
    if (!chat.title) chat.title = titleOf(text, atts);
    chat.updated = Date.now(); persist();
  } catch {
    // drop the failed turn and put the draft back in front of whatever was typed meanwhile
    chat.messages.pop(); userRow.remove();
    $('input').value = [text, $('input').value].filter(Boolean).join('\n'); fitBox($('input'));
    pending = [...atts, ...pending].slice(0, MAX_FILES); renderChips();
    if (chat.messages.length) persist(); // keeps a summary made before the reply failed, and the tokens it used
  }
}

// A user message gets a new reply; a reply gets a new version. Everything after is dropped, unless the new reply fails or
// is cut short (by Stop or a broken connection): then the old messages come back, where the user was reading them.
async function regenerate(m) {
  if (busy) return toast('Wait for the reply to finish');
  const i = chat.messages.indexOf(m);
  if (i < 0 || !ready()) return;
  const prev = chat.messages, prevSummary = chat.summary, top = $('scroll').scrollTop;
  const restore = () => { // saved for chat.used: the attempt may have used tokens
    chat.messages = prev; if (prevSummary) chat.summary = prevSummary; else delete chat.summary; // a summary made by the failed attempt doesn't fit the old messages
    rerender(top); persist();
  };
  const t = m.role === 'user' ? i + 1 : i, base = prev[t]?.role === 'assistant' ? prev[t] : undefined;
  if (t < (chat.summary?.upto ?? 0)) delete chat.summary; // it covers messages that are being dropped
  chat.messages = prev.slice(0, t); renderChat();
  let out;
  try { out = await generate(base); } catch { return restore(); }
  if (out.error) { restore(); showError('Regenerate was cut off, so the previous reply was kept: ' + out.error); }
  else if (out.stopped) { restore(); toast('Stopped: kept the previous reply'); }
  else { chat.updated = Date.now(); persist(); }
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
  const sum = Lib.summaryOf(chat);
  for (const [i, m] of chat.messages.entries()) {
    if (i === sum?.upto) push(summaryDivider(sum));
    if (m.role === 'assistant') { addAssistant().done(m.content, m.reasoning, m); continue; }
    const urls = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : [];
    let k = 0;
    addUser(m.text || '', (m.files || []).map((f) => (f.kind === 'image' ? { ...f, url: urls[k++] } : f)), m);
  }
  // A whole chat at once: skip each row's own entrance (openChat fades the log in once instead)
  for (const a of $('log').getAnimations({ subtree: true })) if (a.animationName?.startsWith('rise')) a.finish(); // not the endless ones: finish() throws on those
}
function startNew() {
  if (busy) return;
  chat = newChat(); showEmpty(); refreshPersonaUi(); renderList(); focusInput();
  if (narrow()) applyHist(false);
}
async function openChat(id) {
  if (busy || id === chat.id) return;
  try { chat = await window.api.loadChat(id); } catch (e) { return showError('Could not open chat: ' + cleanErr(e)); }
  renderChat(); fade($('log'), 0, 160); refreshPersonaUi(); renderList(); focusInput();
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
// Set before settings load, with .boot (in the markup) holding the slide off until it has painted, so launch doesn't animate the list in and out
applyHist(narrow() ? false : savedHist());
requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.app').classList.remove('boot')));
$('histbtn').onclick = () => {
  const open = document.querySelector('.app').classList.contains('nohist'); applyHist(open);
  try { localStorage.setItem('hist', open ? '1' : '0'); } catch {}
};
$('histscrim').onclick = () => applyHist(false); // narrow screens: tapping beside the history closes it

/** The Android back button: closes whatever is on top. Returns false when nothing was open. */
/* exported closeTopLayer */
function closeTopLayer() {
  if (closeSelPop()) return true;
  const rich = /** @type {HTMLElement|null} */ (document.querySelector('.richview')); if (rich) { /** @type {HTMLElement|null} */ (rich.querySelector('.richview-bar .btn'))?.click(); return true; }
  // Settings is the only dialog that opens another (the profile editor) on top of itself, so close any other one first.
  const open = [.../** @type {NodeListOf<HTMLDialogElement>} */ (document.querySelectorAll('dialog[open]'))], dlg = open.find((d) => d.id !== 'prefs') || open[0];
  if (dlg) { dlg.close(); return true; }
  if (!$('modelpop').hidden) { closeModelPop(); return true; }
  if (!$('morepop').hidden) { closeMore(); return true; }
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
  $('pssumon').checked = !!p.summarizer; $('pssumbox').hidden = !p.summarizer;
  if (p.summarizer) fillSumPicker($('pssumprofile'), $('pssummodel'), p.summarizer, $('pserr')); // models are only fetched when the switch is on
  $('personadlg').showModal(); $('psname').focus();
}
$('pssumon').onchange = () => {
  $('pssumbox').hidden = !$('pssumon').checked;
  if ($('pssumon').checked) fillSumPicker($('pssumprofile'), $('pssummodel'), { profileId: '', model: '' }, $('pserr'));
};
$('pssumprofile').onchange = () => fillSumModels($('pssumprofile'), $('pssummodel'), '', $('pserr'));
$('persona').onchange = () => selectPersona($('persona').value);
$('newpersona').onclick = () => openPersonaDialog(true);
$('editpersona').onclick = () => openPersonaDialog(false);
$('pscancel').onclick = () => $('personadlg').close();
$('psform').onsubmit = async (e) => {
  e.preventDefault(); $('pserr').hidden = true;
  try {
    const summarizer = $('pssumon').checked ? { profileId: $('pssumprofile').value, model: $('pssummodel').value } : undefined;
    const st = await window.api.savePersona({ id: editingPersona || undefined, name: $('psname').value, user: $('psuser').value, bot: $('psbot').value, prompt: $('psprompt').value, summarizer });
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
  $('dupsel').value = state.personas.find((p) => p.id !== personaIdOf(c))?.id ?? personaIdOf(c); refreshSel($('dupsel'));
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
  $('pname').value = p.name; $('endpoint').value = p.endpoint; $('format').value = p.format || 'auto'; refreshSel($('format')); $('key').type = 'password';
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
$('model').onchange = () => {
  const info = modelInfo[$('model').value]; settings.model = $('model').value; settings.noTools = info?.tools === false; settings.ctx = info?.ctx || 0;
  window.api.patchSettings({ model: settings.model, noTools: settings.noTools, ctx: settings.ctx }); renderLevels(); if (!chat.messages.length) showEmpty();
};
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

// ---- Settings dialog: Appearance / Profiles / Search / Tools / Replies / Summaries ----
const PANES = ['appearance', 'profiles', 'search', 'tools', 'replies', 'summaries', 'chats'];
let prefsDirty = false; // a Replies switch changed: redraw the open chat when the dialog closes
function showPane(name, focus) {
  for (const n of PANES) {
    const tab = $('tab-' + n), on = n === name;
    tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; $('pane-' + n).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (name === 'summaries') loadSummaryPane(); // only here, since it fetches a model list
  if (name === 'tools') showMcpStatus(); // only here, since it starts the servers
}
/** Says how saved chats are protected here: the host reports whether the chat key is in a real keyring (seal.js). */
async function loadChatsPane() {
  $('chatsecerr').hidden = $('experr').hidden = $('imperr').hidden = $('resetbox').hidden = true; $('chatsec').textContent = '';
  /** @type {HTMLInputElement} */ ($('exppw')).value = /** @type {HTMLInputElement} */ ($('exppw2')).value = ''; // never left filled in
  let s;
  try { s = await window.api.chatsStatus(); } catch (e) { s = { error: cleanErr(e) }; }
  if (s.error) { $('chatsecerr').textContent = `Saved chats can't be opened: ${s.error}`; $('chatsecerr').hidden = $('resetbox').hidden = false; return; }
  $('chatsec').textContent = s.keyring
    ? (s.device ? 'Chats are encrypted on this device with a key held by its keystore. Copies of the files can\'t be read.'
      : 'Chats are encrypted with a key held by your system keyring. Other users and copies of the disk can\'t read them; programs you run can.')
    : (s.device ? 'Chats are encrypted, but this device\'s keystore isn\'t working, so the key is kept unprotected in the app\'s private folder.'
      : 'Chats are encrypted, but no system keyring was found, so the key is stored unprotected beside them. Unlock or install a keyring (GNOME Keyring or KWallet) and restart the app to protect it.');
}
let resetArmed = 0;
$('resetkey').onclick = async () => {
  const btn = $('resetkey');
  if (Date.now() - resetArmed > 3000) { resetArmed = Date.now(); btn.textContent = 'Confirm: start over?'; setTimeout(() => { btn.textContent = 'Start over with a new key'; }, 3000); return; } // first click arms, as deleting a chat does
  resetArmed = 0; btn.disabled = true;
  try {
    const notice = await window.api.resetChatKey();
    await loadChatsPane(); await refreshList();
    if (notice) showError(notice);
  } catch (e) { $('chatsecerr').textContent = 'Could not start over: ' + cleanErr(e); $('chatsecerr').hidden = false; }
  finally { btn.disabled = false; btn.textContent = 'Start over with a new key'; }
};
// Export: a passphrase always gives the locked JSON, so the format is fixed to JSON while it's on
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
$('exppass').onchange = () => {
  const on = $('exppass').checked; $('exppassbox').hidden = !on; $('expformat').disabled = on;
  if (on) { $('expformat').value = 'json'; refreshSel($('expformat')); $('exppw').focus(); }
};
$('expbtn').onclick = async () => {
  const err = $('experr'), locked = $('exppass').checked, pass = locked ? $('exppw').value : '';
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (locked && pass.length < 8) return fail('Use a passphrase of at least 8 characters.');
  if (locked && pass !== $('exppw2').value) return fail("The two passphrases don't match.");
  $('expbtn').disabled = true;
  try {
    const r = await window.api.exportChats({ format: $('expformat').value, passphrase: pass });
    if (r.saved) toast(`Exported ${plural(r.count, 'chat')}${r.missed ? `; ${r.missed} couldn't be read` : ''}`);
  } catch (e) { fail('Could not export: ' + cleanErr(e)); }
  finally { $('expbtn').disabled = false; }
};
// Import: read the file in the page, ask for the passphrase if it's locked, then merge it in
let importText = '';
$('impbtn').onclick = () => {
  if (busy) return toast('Wait for the reply to finish first');
  $('imperr').hidden = true; /** @type {HTMLInputElement} */ ($('impfile')).value = ''; $('impfile').click();
};
$('impfile').onchange = async () => {
  const f = /** @type {HTMLInputElement} */ ($('impfile')).files[0]; if (!f) return;
  try { importText = await f.text(); } catch (e) { $('imperr').textContent = 'Could not read the file: ' + cleanErr(e); $('imperr').hidden = false; return; }
  let locked = false; try { locked = JSON.parse(importText)?.kind === 'chats-encrypted'; } catch {}
  if (!locked) return runImport('', $('imperr'));
  /** @type {HTMLInputElement} */ ($('imppw')).value = ''; $('imperr2').hidden = true; $('impdlg').showModal(); $('imppw').focus();
};
/** Imports importText; shows a failure in `err` and returns false. */
async function runImport(pass, err) {
  err.hidden = true;
  let r;
  try { r = await window.api.importChats(importText, pass); }
  catch (e) { err.textContent = cleanErr(e); err.hidden = false; return false; }
  importText = '';
  const extra = [r.updated && `${r.updated} updated`, r.kept && `${r.kept} already up to date`, r.skipped && `${r.skipped} skipped`].filter(Boolean);
  toast(`Imported ${plural(r.added + r.updated, 'chat')}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  await refreshList().catch((e) => showError('Could not load chats: ' + cleanErr(e)));
  if (r.ids.includes(chat.id) && !busy) { // the open chat was replaced: show the imported copy, so a later save can't undo it
    try { chat = await window.api.loadChat(chat.id); renderChat(); refreshPersonaUi(); } catch (e) { showError('Could not open chat: ' + cleanErr(e)); }
  }
  return true;
}
$('impcancel').onclick = () => $('impdlg').close();
$('impdlg').onclose = () => { importText = ''; }; // Cancel, Escape or Back: drop the file
$('impform').onsubmit = async (e) => {
  e.preventDefault(); $('impgo').disabled = true;
  try { if (await runImport(/** @type {HTMLInputElement} */ ($('imppw')).value, $('imperr2'))) $('impdlg').close(); }
  finally { $('impgo').disabled = false; }
};
function openPrefs(pane) {
  const now = Lib.themeColors(state.theme); $('c1').value = now.a1; $('c2').value = now.a2; $('gradon').checked = state.theme.gradient; // shortcut: custom colors start from the current theme; they aren't remembered while a preset is active
  renderThemes(); renderProfiles(); syncReplies(); loadSearchPane(); loadMcpPane(); loadChatsPane(); showPane(pane); $('prefs').showModal(); $('tab-' + pane).focus();
}
for (const n of PANES) $('tab-' + n).onclick = () => showPane(n);
$('prefs').querySelector('[role=tablist]').onkeydown = (e) => {
  const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
  e.preventDefault(); showPane(PANES[(PANES.indexOf(/** @type {HTMLElement} */ (document.activeElement).dataset.pane) + d + PANES.length) % PANES.length], true);
};
$('prefsclose').onclick = () => $('prefs').close();
$('prefs').onclose = () => {
  if (prefsDirty && !busy && chat.messages.length) rerender();
  prefsDirty = false; // shortcut: a reply that is still streaming keeps its old look until the chat is reopened
};

async function saveTheme(theme) {
  applyTheme(theme); // show it at once; the saved (validated) copy replaces it below
  try { applyState(await window.api.patchSettings({ theme })); } catch (e) { showError(cleanErr(e)); applyState(state); }
  renderThemes();
}
// Every theme built here carries the Gradient switch, so picking a color never turns the gradient off.
const pickTheme = (t) => ({ ...t, gradient: $('gradon').checked });
const customTheme = () => pickTheme({ id: 'custom', a1: $('c1').value, a2: $('c2').value });
function renderThemes() {
  const g = $('gradon').checked, tiles = [...Lib.THEMES, { id: 'custom', name: 'Custom', a1: $('c1').value, a2: $('c2').value }];
  $('c2wrap').hidden = !g;
  $('themegrid').replaceChildren(...tiles.map((t) => {
    const b = el('button', 'theme'), sw = el('i'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t.id === state.theme.id));
    sw.style.background = g ? `linear-gradient(135deg, ${t.a1}, ${t.a2})` : t.a1; b.append(sw, t.name);
    b.onclick = () => saveTheme(t.id === 'custom' ? customTheme() : pickTheme({ id: t.id })); return b;
  }));
}
for (const c of [$('c1'), $('c2')]) { // live preview while dragging; saved when the picker commits
  c.oninput = () => applyTheme(customTheme());
  c.onchange = () => saveTheme(customTheme());
}
$('gradon').onchange = () => saveTheme(pickTheme(state.theme));

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
  for (const c of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-render]'))) c.checked = !!state.render[c.dataset.render];
  for (const k of ['css', 'js']) (/** @type {HTMLInputElement} */ (document.querySelector(`[data-render=${k}]`))).disabled = !state.render.html; // they only apply inside HTML
}
for (const c of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-render]'))) c.onchange = async () => {
  try { applyState(await window.api.patchSettings({ render: { [c.dataset.render]: c.checked } })); prefsDirty = true; }
  catch (e) { showError(cleanErr(e)); applyState(state); }
  syncReplies();
};

// ---- Search pane: the key is fetched only when the pane opens, and an untouched field never overwrites the stored one ----
let searchKeyDirty = false, searchLoad = 0;
async function loadSearchPane() {
  const s = state.search, mine = ++searchLoad; searchKeyDirty = false; $('searchkey').type = 'password'; $('searcherr').hidden = true;
  $('searchon').checked = s.enabled; $('searchkey').value = '';
  const noTools = settings.model && !toolsOk();
  $('searchnote').textContent = noTools ? "The current model doesn't support tools, so it won't search." : ''; $('searchnote').hidden = !noTools;
  if (!s.hasKey) return;
  const stale = () => mine !== searchLoad || searchKeyDirty; // a newer load started, or the user already typed: don't overwrite their edit
  try { const k = await window.api.getSearchKey(); if (!stale()) $('searchkey').value = k; }
  catch (e) { if (!stale()) { $('searcherr').textContent = cleanErr(e); $('searcherr').hidden = false; } }
}
async function saveSearch(p) {
  $('searcherr').hidden = true;
  try { applyState(await window.api.saveSearch(p)); return true; }
  catch (e) { $('searcherr').textContent = cleanErr(e); $('searcherr').hidden = false; applyState(state); return false; }
}
$('searchkey').oninput = () => { searchKeyDirty = true; };
$('searchreveal').onclick = () => { const k = $('searchkey'); k.type = k.type === 'password' ? 'text' : 'password'; };
$('searchon').onchange = async () => {
  if (!(await saveSearch({ enabled: $('searchon').checked }))) $('searchon').checked = state.search.enabled;
  else if ($('searchon').checked && !state.search.hasKey) { $('searcherr').textContent = 'Add your Linkup API key below, or searching will not start.'; $('searcherr').hidden = false; }
};
$('searchsave').onclick = async () => {
  const sent = $('searchkey').value;
  if (!searchKeyDirty || !(await saveSearch({ key: sent }))) return;
  if ($('searchkey').value === sent) searchKeyDirty = false; // typed again while saving: stays unsaved
  toast(sent.trim() ? 'Key saved' : 'Key removed');
};

// ---- Tools pane: MCP servers. The config is fetched when the dialog opens; an untouched field never overwrites the stored one. ----
let mcpDirty = false, mcpLoad = 0, mcpStatusSeq = 0;
async function loadMcpPane() {
  const mine = ++mcpLoad; mcpDirty = false; $('mcperr').hidden = true;
  $('mcpon').checked = state.mcp.enabled; $('mcpconfig').value = '';
  if (settings.model && !toolsOk()) { $('mcperr').textContent = "The current model doesn't support tools, so it can't use these."; $('mcperr').hidden = false; }
  try { const c = await window.api.getMcpConfig(); if (mine === mcpLoad && !mcpDirty) $('mcpconfig').value = c; }
  catch (e) { if (mine === mcpLoad && !mcpDirty) { $('mcperr').textContent = cleanErr(e); $('mcperr').hidden = false; } }
}
const mcpRow = (name, text, err, button) => { const row = el('div', 'prow'), info = el('div'); info.append(el('strong', null, name), el('small', err ? 'perr' : null, text)); row.append(info); if (button) row.append(button); return row; };
/** A Sign in / Sign out button for a url server; the list redraws from the answer. */
function signButton(name, out) {
  const b = el('button', 'btn' + (out ? '' : ' primary'), out ? 'Sign out' : 'Sign in'); b.type = 'button'; b.setAttribute('aria-label', `${out ? 'Sign out of' : 'Sign in to'} ${name}`);
  b.onclick = async () => {
    const mine = ++mcpStatusSeq; $('mcperr').hidden = true;
    for (const x of /** @type {NodeListOf<HTMLButtonElement>} */ ($('mcplist').querySelectorAll('button'))) x.disabled = true;
    if (!out) b.textContent = 'Waiting for the browser…';
    try {
      const list = await (out ? window.api.mcpSignOut(name) : window.api.mcpSignIn(name));
      if (mine === mcpStatusSeq) renderMcpStatus(list);
      toast(out ? `Signed out of ${name}` : `Signed in to ${name}`);
    } catch (e) { $('mcperr').textContent = cleanErr(e); $('mcperr').hidden = false; if (mine === mcpStatusSeq) showMcpStatus(); }
  };
  return b;
}
function renderMcpStatus(list) {
  $('mcplist').replaceChildren(...list.map((s) => (s.state === 'ok' ? mcpRow(s.name, (s.tools === 1 ? '1 tool' : `${s.tools} tools`) + (s.signedIn ? ' · signed in' : ''), false, s.signedIn && signButton(s.name, true))
    : s.state === 'desktop-only' ? mcpRow(s.name, 'Desktop only: runs a command on a computer')
    : s.state === 'auth' ? mcpRow(s.name, 'Needs sign-in. Your browser opens to sign in.', false, signButton(s.name, false))
    : mcpRow(s.name, s.error || 'Not working', true, s.signedIn && signButton(s.name, true)))));
}
/** Lists each server's state; asking starts the ones that aren't running yet. `reload` restarts them all first. */
async function showMcpStatus(reload = false) {
  const mine = ++mcpStatusSeq;
  if (!state.mcp.enabled || !state.mcp.servers.length) { $('mcplist').replaceChildren(); return; }
  $('mcplist').replaceChildren(...state.mcp.servers.map((n) => mcpRow(n, 'Starting…')));
  let list;
  try { list = await (reload ? window.api.reloadMcp() : window.api.mcpStatus()); }
  catch (e) { if (mine === mcpStatusSeq) $('mcplist').replaceChildren(mcpRow('Servers', cleanErr(e), true)); return; }
  if (mine === mcpStatusSeq) renderMcpStatus(list);
}
async function saveMcp(p) {
  $('mcperr').hidden = true;
  try { applyState(await window.api.saveMcp(p)); showMcpStatus(); return true; }
  catch (e) { $('mcperr').textContent = cleanErr(e); $('mcperr').hidden = false; applyState(state); return false; }
}
$('mcpconfig').oninput = () => { mcpDirty = true; };
$('mcpon').onchange = async () => {
  if (!(await saveMcp({ enabled: $('mcpon').checked }))) $('mcpon').checked = state.mcp.enabled;
  else if ($('mcpon').checked && !state.mcp.hasConfig && !mcpDirty) { $('mcperr').textContent = 'Paste your servers below and save.'; $('mcperr').hidden = false; }
};
$('mcpsave').onclick = async () => {
  const sent = $('mcpconfig').value;
  if (!(await saveMcp({ config: sent, ...(sent.trim() && { enabled: true }) }))) return; // saving servers turns MCP on
  $('mcpon').checked = state.mcp.enabled;
  if ($('mcpconfig').value === sent) mcpDirty = false; // typed again while saving: stays unsaved
  toast(sent.trim() ? 'Servers saved' : 'Servers removed');
};
$('mcpreload').onclick = () => showMcpStatus(true);

// Before a tool runs: Deny, Allow once or Always allow. Escape, Back and anything else that closes the dialog mean Deny.
window.api.onToolApproval?.((/** @type {{server: string, tool: string, args: object}} */ info) => new Promise((resolve) => {
  const d = $('tooldlg');
  $('toolsub').textContent = `${info.server} wants to run ${info.tool} with:`;
  $('toolargs').textContent = JSON.stringify(info.args, null, 2);
  $('toolwarn').hidden = !/order|trade|buy|sell|transfer|withdraw|delete|remove|write|send|pay/i.test(info.tool);
  d.returnValue = 'deny';
  d.addEventListener('close', () => resolve(d.returnValue || 'deny'), { once: true });
  d.showModal(); $('tooldeny').focus();
}));

// ---- Summary model pickers (Settings → Summaries and the persona dialog): a profile, "Chat model" first, then one of that profile's models ----
/** Fills a picker with `s` ({profileId, model}) chosen. Errors go to `err`, since toasts sit under the modal dialog. */
function fillSumPicker(prof, model, s, err) {
  prof.replaceChildren(new Option('Chat model', ''), ...state.profiles.map((p) => new Option(p.name, p.id)));
  prof.value = state.profiles.some((p) => p.id === s.profileId) ? s.profileId : ''; refreshSel(prof);
  return fillSumModels(prof, model, prof.value ? s.model : '', err);
}
/** Lists the chosen profile's models, with `want` selected; a saved model the profile no longer lists stays, marked, as in the main picker. */
async function fillSumModels(prof, model, want, err) {
  const pid = prof.value, seq = (model.dataset.seq = String(+(model.dataset.seq || 0) + 1)); model.parentElement.hidden = !pid;
  if (!pid) return;
  model.replaceChildren(new Option('Loading models…', want)); model.disabled = true;
  let ids = [];
  try { ids = (await window.api.listModels(pid)).map((m) => m.id); }
  catch (e) { err.textContent = 'Could not load models: ' + cleanErr(e); err.hidden = false; }
  if (prof.value !== pid || model.dataset.seq !== seq) return; // another profile or a newer load came along meanwhile
  model.replaceChildren(new Option("The profile's chat model", ''), ...ids.map((id) => new Option(id, id)));
  if (want && !ids.includes(want)) model.add(new Option(`${want} (not in list)`, want), 1);
  model.value = want; model.disabled = false; refreshSel(model);
}

function syncContextLimit() {
  const c = state.contextLimit; $('ctxon').checked = c.on; $('ctxtokens').value = c.tokens; $('ctxtokens').disabled = !c.on;
}
function loadSummaryPane() {
  $('sumerr').hidden = true; syncContextLimit();
  fillSumPicker($('sumprofile'), $('summodel'), state.summarizer, $('sumerr'));
}
async function saveSummaries(patch) {
  $('sumerr').hidden = true;
  try { applyState(await window.api.patchSettings(patch)); }
  catch (e) { $('sumerr').textContent = cleanErr(e); $('sumerr').hidden = false; }
  syncContextLimit();
}
$('sumprofile').onchange = () => { saveSummaries({ summarizer: { profileId: $('sumprofile').value, model: '' } }); fillSumModels($('sumprofile'), $('summodel'), '', $('sumerr')); };
$('summodel').onchange = () => saveSummaries({ summarizer: { profileId: $('sumprofile').value, model: $('summodel').value } });
$('ctxon').onchange = () => saveSummaries({ contextLimit: { ...state.contextLimit, on: $('ctxon').checked } });
$('ctxtokens').onchange = () => {
  const n = Math.round(Number($('ctxtokens').value));
  if (n >= 1000) return saveSummaries({ contextLimit: { ...state.contextLimit, tokens: n } });
  syncContextLimit(); $('sumerr').textContent = 'The limit must be at least 1,000 tokens.'; $('sumerr').hidden = false;
};

(async () => {
  let first;
  try { first = await window.api.getSettings(); } // a read error leaves the settings file alone; say so rather than start empty
  catch (e) { return showError('Could not read your settings: ' + cleanErr(e) + '. Close the app and open it again.'); }
  applyState(first); renderTemplates(); chat = newChat(); refreshPersonaUi();
  if (settings.model) $('model').replaceChildren(new Option(settings.model, settings.model));
  renderModelBtn();
  showEmpty(); renderLevels();
  refreshList().catch((e) => showError('Could not load chats: ' + cleanErr(e)));
  if (!state.activeId) { openProfileDialog(true); if (first.notice) { $('perr').textContent = first.notice; $('perr').hidden = false; } } // toasts sit under the modal dialog
  else { focusInput(); if (first.notice) showError(first.notice); }
})();
