// Encrypted chat files. One random AES-256-GCM key per install encrypts every file in the chats folder. The key is kept in
// chatkey.json next to settings.json (not inside it, so quarantining a damaged settings file can't lose it), wrapped by the
// host's keyring: the same `crypto` that protects API keys. WebCrypto does the work, so this runs unchanged in Electron's main
// process, in the phone web views and under node --test.

const PREFIX = 'JAVC-SEALED-1\n', KEYFILE = 'chatkey.json';
const utf8 = new TextEncoder(), text = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

/** @param {Uint8Array} bytes */
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // chunks: a spread of millions of bytes overflows the stack
  return btoa(s);
}
/** @param {string} b64 */
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Chat encryption for one install.
 * @param {{io: import('./disk').DiskIo, crypto: import('./store').KeyCrypto, chats: import('./disk').DiskIo}} hosts
 *   `io` is the settings folder (for chatkey.json), `crypto` the host keyring, `chats` the plain chats folder.
 */
function makeChatSeal({ io, crypto, chats }) {
  let ready = null, notice = '', setAside = 0;
  /** The keyring's wrapping of `b64`, used only if it reads back: a broken keyring must not lock the chats away. */
  const wrap = async (b64) => {
    if (!(await crypto.available())) return null;
    const keyEnc = await crypto.enc(b64);
    return (await crypto.dec(keyEnc)) === b64 ? keyEnc : null;
  };
  const save = (rec) => io.write(KEYFILE, JSON.stringify({ version: 1, ...rec }));
  /** Sealed chat files (not the _index), which a new key could never open. */
  const sealedCount = async () => {
    let n = 0;
    for (const name of (await chats.list()).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) if ((await chats.read(name))?.startsWith(PREFIX)) n++;
    return n;
  };
  const damaged = () => new Error('the chat key file (chatkey.json) is damaged, so saved chats can\'t be opened. It was left as it is.');

  /** Reads the key, creating it only when chatkey.json is missing, and moves a plaintext key into the keyring once one works. */
  async function loadKey() {
    const saved = await io.read(KEYFILE); // a read error propagates: never replace a key that is merely unreadable
    if (saved === null) {
      const lost = await sealedCount(); // sealed chats with no key file: they stay on disk, and the user is told
      const raw = globalThis.crypto.getRandomValues(new Uint8Array(32)), b64 = toB64(raw), keyEnc = await wrap(b64);
      await save(keyEnc ? { keyEnc } : { keyPlain: b64 });
      if (lost) notice = `${lost} saved chat${lost === 1 ? ' was' : 's were'} encrypted with a key this device no longer has. ${lost === 1 ? 'It is' : 'They are'} kept on disk; restore from an export with Import.`;
      return { key: await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']), keyring: !!keyEnc };
    }
    let rec;
    try { rec = JSON.parse(saved); } catch { throw damaged(); }
    if (!rec || rec.version !== 1 || typeof (rec.keyEnc || rec.keyPlain) !== 'string') throw damaged();
    let b64 = rec.keyPlain, keyring = false;
    if (rec.keyEnc) {
      try { b64 = await crypto.dec(rec.keyEnc); keyring = true; }
      catch (e) { throw new Error(`the system keyring couldn't unlock the chat key (${e.message}). Your chats are kept as they are.`, { cause: e }); }
    } else {
      const keyEnc = await wrap(b64); // a keyring appeared since: protect the key now
      if (keyEnc) { await save({ keyEnc }); keyring = true; }
    }
    let raw;
    try { raw = fromB64(b64); } catch { throw damaged(); }
    if (raw.length !== 32) throw damaged();
    return { key: await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']), keyring };
  }
  /** The key, loaded once on first use (after the app is ready, which Linux's keyring needs); a failure is retried next time. */
  const key = () => (ready ??= loadKey().catch((e) => { ready = null; throw e; }));

  /** @type {import('./disk').DiskIo & {needsSeal(name: string): Promise<boolean>, ready(): Promise<void>, setAside(name: string): Promise<void>}} */
  const sealed = {
    /** Rejects when the key can't be loaded; chats.list checks it first, since it skips files it can't read. */
    async ready() { await key(); },
    async read(name) {
      const t = await chats.read(name);
      if (t === null || !t.startsWith(PREFIX)) return t; // missing, or written before encryption (chats.upgrade seals it)
      const { key: k } = await key();
      let plain;
      try { const all = fromB64(t.slice(PREFIX.length)); plain = await subtle().decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: utf8.encode(name) }, k, all.subarray(12)); }
      catch { throw Object.assign(new Error(`${name} could not be decrypted (a different key, or the file was changed)`), { code: 'UNREADABLE' }); }
      return text.decode(plain);
    },
    async write(name, t) {
      const { key: k } = await key(), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      // the file name is authenticated too, so one chat (or the index) can't be swapped in for another
      const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(name) }, k, utf8.encode(t)));
      const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
      await chats.write(name, PREFIX + toB64(all));
    },
    remove: (name) => chats.remove(name),
    list: () => chats.list(),
    async rename(from, to) { const t = await sealed.read(from); if (t !== null) { await sealed.write(to, t); await chats.remove(from); } }, // re-sealed: the name is part of the seal
    async needsSeal(name) { const t = await chats.read(name); return t !== null && !t.startsWith(PREFIX); },
    /** Moves a chat that can't be decrypted out of the list (kept as is, so the right key still opens it), for one notice. */
    async setAside(name) { await chats.rename(name, `${name}.${Date.now()}.unreadable`); setAside++; },
  };

  return {
    io: sealed,
    /** {keyring} once the key is loaded, or {error}; loading it here also prepares any one-time notice. */
    async status() {
      try { return { keyring: (await key()).keyring }; } catch (e) { return { error: e.message }; }
    },
    takeNotice() {
      const n = notice || (setAside ? `${setAside} saved chat${setAside === 1 ? '' : 's'} couldn't be decrypted (a key from another device, or the file was changed), so ${setAside === 1 ? 'it was' : 'they were'} left out of the list. ${setAside === 1 ? 'It is' : 'They are'} kept on disk; restore from an export with Import.` : '');
      notice = ''; setAside = 0; // after a lost key, those notices are about the same files: one is enough
      return n;
    },
  };
}

module.exports = { makeChatSeal, PREFIX, toB64, fromB64 };
