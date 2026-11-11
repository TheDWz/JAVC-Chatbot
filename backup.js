// Chat export and import. An export is JSON (all chats, importable), plain text (for reading), or JSON locked with a
// passphrase (PBKDF2 + AES-256-GCM). WebCrypto, like seal.js, so the hosts share it: they only collect, save and pick files.
const { toB64, fromB64 } = require('./seal');

const APP = 'javc-chatbot', ITERATIONS = 600000; // OWASP's PBKDF2-SHA256 figure
const utf8 = new TextEncoder(), text = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const notExport = () => new Error("This file isn't a JAVC Chatbot chat export.");
const newer = () => new Error('This export is from a newer version of the app. Update the app to import it.');

/** Every chat in full, oldest list entry last; a chat that can't be read (another key, damage) is left out and counted. */
async function collect(chats) {
  const out = []; let missed = 0;
  for (const { id } of await chats.list()) { try { out.push(await chats.load(id)); } catch { missed++; } }
  return { chats: out, missed };
}

/** The AES key for `pass` with these PBKDF2 settings. */
async function passKey(pass, salt, iterations) {
  const base = await subtle().importKey('raw', utf8.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** `json` locked with `pass`. */
async function encryptExport(json, pass) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await passKey(pass, salt, ITERATIONS), utf8.encode(json)));
  return JSON.stringify({ app: APP, kind: 'chats-encrypted', version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) }, iv: toB64(iv), data: toB64(data) });
}
/** The JSON inside a locked export. */
async function decryptExport(f, pass) {
  const k = f.kdf;
  // bounded, so a crafted file can't make the app hash for minutes
  if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iterations) || k.iterations < 100000 || k.iterations > 10000000) throw notExport();
  let iv, data, salt;
  try { iv = fromB64(f.iv); data = fromB64(f.data); salt = fromB64(k.salt); } catch { throw notExport(); }
  try { return text.decode(await subtle().decrypt({ name: 'AES-GCM', iv }, await passKey(pass, salt, k.iterations), data)); }
  catch { throw new Error('Wrong passphrase, or the file is damaged.'); }
}

/** A readable transcript. `names` maps a persona id to {user, bot}; reasoning and attachment contents are left out. */
function transcript(chats, names = {}, now = Date.now()) {
  const day = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const parts = [`JAVC Chatbot chats, exported ${day(now)} (${chats.length} chat${chats.length === 1 ? '' : 's'})`];
  for (const c of chats) {
    const who = names[c.personaId] || {}, user = who.user || 'You', bot = who.bot || 'Assistant';
    const lines = [`=== ${c.title || 'New chat'} ===`, `Updated ${day(c.updated)}`];
    for (const m of c.messages) {
      if (m.role === 'user') {
        const files = (m.files || []).map((f) => `[${f.kind === 'image' ? 'image' : 'file'}: ${f.name}]`);
        lines.push('', `${user}:`, ...[m.text || '', ...files].filter(Boolean));
      } else if (m.role === 'assistant') lines.push('', `${bot}:`, typeof m.content === 'string' ? m.content : '');
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n\n') + '\n';
}

/**
 * The export file for `chats`.
 * @param {object[]} chats Full chats, as `collect` gives them.
 * @param {{format?: string, passphrase?: string, names?: object, now?: number}} opts A passphrase always gives the locked
 *   JSON (it can be imported back); otherwise `format` is 'json' or 'txt'.
 * @returns {Promise<{name: string, mime: string, text: string}>}
 */
async function buildExport(chats, { format = 'json', passphrase = '', names = {}, now = Date.now() } = {}) {
  const { name, mime } = exportName({ format, passphrase, now });
  if (mime === 'text/plain') return { name, mime, text: transcript(chats, names, now) };
  const json = JSON.stringify({ app: APP, kind: 'chats', version: 1, exported: now, chats });
  return { name, mime, text: passphrase ? await encryptExport(json, passphrase) : json };
}
/** The file name and type `buildExport` gives for these options, known before any work (the desktop asks where to save first). */
function exportName({ format = 'json', passphrase = '', now = Date.now() } = {}) {
  const d = new Date(now), stamp = `javc-chats-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (passphrase) return { name: `${stamp}-protected.json`, mime: 'application/json' };
  return format === 'txt' ? { name: `${stamp}.txt`, mime: 'text/plain' } : { name: `${stamp}.json`, mime: 'application/json' };
}
/** Persona id -> {user, bot}, the names a text export uses. */
const personaNames = (personas) => Object.fromEntries(personas.map((p) => [p.id, { user: p.user, bot: p.bot }]));

const validMessage = (m) => !!m && typeof m === 'object' && typeof m.role === 'string' && (m.files === undefined || Array.isArray(m.files));
const validChat = (c) => !!c && typeof c === 'object' && typeof c.id === 'string' && /^[a-z0-9-]+$/.test(c.id)
  && Array.isArray(c.messages) && c.messages.every(validMessage) && Number.isFinite(c.updated) && (c.title === undefined || typeof c.title === 'string');
/** The chats in an export file, unlocking it with `passphrase` if it is locked. Chats that don't look right are counted, not kept. */
async function readExport(t, passphrase = '') {
  let f;
  try { f = JSON.parse(t); } catch { throw notExport(); }
  if (f?.app !== APP) throw notExport();
  if (f.kind === 'chats-encrypted') {
    if (f.version !== 1) throw newer();
    if (!passphrase) throw new Error('This export is protected with a passphrase.');
    try { f = JSON.parse(await decryptExport(f, passphrase)); } catch (e) { throw e.message.startsWith('Wrong') ? e : notExport(); }
  }
  if (f?.kind !== 'chats' || !Array.isArray(f.chats)) throw notExport();
  if (f.version !== 1) throw newer();
  const chats = f.chats.filter(validChat);
  return { chats, skipped: f.chats.length - chats.length };
}

/**
 * Saves imported chats into the store: new ids are added, and a chat already here is replaced only by a newer copy.
 * @param {{list(): Promise<{id: string, updated: number}[]>, save(chat: object): Promise<void>}} store The chat store.
 * @returns {Promise<{added: number, updated: number, kept: number, skipped: number, ids: string[]}>} `ids` are the chats replaced.
 */
async function mergeInto(store, { chats, skipped }) {
  const have = new Map((await store.list()).map((c) => [c.id, c.updated])), newest = new Map();
  for (const c of chats) if (!newest.has(c.id) || c.updated > newest.get(c.id).updated) newest.set(c.id, c); // the same id twice: the newer copy
  let added = 0, kept = 0; const ids = [];
  for (const c of newest.values()) {
    if (!have.has(c.id)) added++;
    else if (c.updated > have.get(c.id)) ids.push(c.id);
    else { kept++; continue; }
    await store.save(c);
  }
  return { added, updated: ids.length, kept, skipped, ids };
}

module.exports = { collect, buildExport, exportName, personaNames, readExport, mergeInto, transcript };
