// One JSON file per chat, plus _index.json (id, title, updated, personaId, files) so listing doesn't open every chat.
// Each chat holds only its own messages, which is what keeps chats isolated. Files the model attached to replies are kept
// beside them as a-<sha256>.bin (base64, sealed like the chats); messages hold only that name, and the index lists each chat's.
// `io` is the chats folder (see disk.js); the same code runs on the desktop and on Android. Hosts pass it sealed (seal.js),
// so every file is encrypted; `ready`, `needsSeal` and `setAside` come from there.

/**
 * The chat history store.
 * @param {import('./disk').DiskIo & {ready?(): Promise<void>, needsSeal?(name: string): Promise<boolean>, setAside?(name: string): Promise<void>}} io The chats folder:
 *   { read, write, remove, list } as in disk.js, optionally sealed.
 */
const FILE = /^a-[0-9a-f]{64}\.bin$/;
/** The files chat `c` uses, in any version of any message. */
const filesOf = (c) => [...new Set((Array.isArray(c.messages) ? c.messages : []).flatMap((m) => [m, ...(Array.isArray(m?.versions) ? m.versions : [])])
  .flatMap((m) => (Array.isArray(m?.attachments) ? m.attachments.map((a) => a?.ref) : [])).filter((r) => typeof r === 'string' && FILE.test(r)))];

function makeChats(io) {
  /** The file name of chat `id`; rejects anything that isn't a plain id, so a name can never point outside the folder. */
  const file = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid chat id');
    return id + '.json';
  };
  const INDEX = '_index.json'; // '_' can't appear in an id, so it never collides with a chat
  const fileName = (ref) => { if (typeof ref !== 'string' || !FILE.test(ref)) throw new Error('Invalid file'); return ref; };
  const fresh = new Set(); // files saved since the app started: a reply's files are saved before its chat is, so they're never swept meanwhile
  let stored = null; // the file names in the folder, listed once, so saving 20 files doesn't list it 20 times
  let lost = false; // chats were set aside as unreadable when it was listed: a key may have been lost (Start over)
  let swept = false;
  const entryOf = (c) => ({ id: c.id, title: c.title, updated: c.updated, personaId: c.personaId, files: filesOf(c) });
  /**
   * Deletes the files no chat in index `ix` uses. Skipped while that can't be known: an entry from an older version without
   * its file list, a chat file the index doesn't list (it couldn't be read just now), or a chat set aside as unreadable (the
   * right key may still open it).
   */
  const sweep = async (ix) => {
    if (ix.some((c) => !Array.isArray(c.files))) return;
    let names; try { names = await io.list(); } catch { return; }
    const listed = new Set(ix.map((c) => c.id + '.json'));
    if (names.some((n) => n.endsWith('.unreadable') || (n.endsWith('.json') && n !== INDEX && !listed.has(n)))) return;
    const used = new Set(ix.flatMap((c) => c.files));
    for (const n of names) if (FILE.test(n) && !used.has(n) && !fresh.has(n)) { await io.remove(n).catch(() => {}); stored?.delete(n); }
  };
  let queue = Promise.resolve(); // one operation at a time, so the index is never rewritten from a stale copy
  const serial = (fn) => (...args) => { const run = queue.then(() => fn(...args)); queue = run.catch(() => {}); return run; };

  /** The chat file names in the folder, or null when the folder can't be listed. */
  const chatFiles = async () => {
    try { return (await io.list()).filter((n) => n.endsWith('.json') && n !== INDEX); } catch { return null; }
  };
  /**
   * Index entries read from the given chat files. A corrupt file, or one whose id doesn't match its name, is skipped
   * instead of losing the whole list (an entry under the wrong id could never be opened, and would be re-added forever).
   */
  const entries = async (names) => {
    const out = [];
    for (const n of names) {
      try {
        const c = JSON.parse(await io.read(n));
        if (c && c.id + '.json' === n) out.push(entryOf(c));
      } catch (e) { if (e?.code === 'UNREADABLE') await io.setAside?.(n).catch(() => {}); } // it would fail every list; the seal gives one notice
    }
    return out;
  };
  /** The saved index, or null when it's missing or damaged. */
  const readIndex = async () => { try { const ix = JSON.parse(await io.read(INDEX)); return Array.isArray(ix) ? ix : null; } catch { return null; } };
  /** The index, rebuilt from the chat files when it's missing or damaged. */
  const index = async () => (await readIndex()) ?? entries((await chatFiles()) ?? []);
  const sorted = (ix) => [...ix].sort((a, b) => b.updated - a.updated);

  const store = {
    /**
     * All chats, newest first. The index is checked against the chat files, so an interrupted save or delete can't hide a
     * chat or list a deleted one: entries without a file are dropped and files missing from the index are added.
     */
    list: serial(async () => {
      const names = await chatFiles();
      // a key that can't be unlocked is an error, not an empty list (the reads below skip what they can't read); with no chats
      // there's nothing to unlock, so a first launch doesn't wait on the keystore making a key
      if (names === null || names.length) await io.ready?.();
      const saved = await readIndex();
      if (!names) return sorted(saved ?? []); // can't see the folder: show what the index says
      let ix = saved;
      if (!ix) ix = await entries(names);
      else {
        const onDisk = new Set(names.map((n) => n.slice(0, -5)));
        const kept = ix.filter((c) => onDisk.has(c.id)), known = new Set(kept.map((c) => c.id));
        const added = await entries(names.filter((n) => !known.has(n.slice(0, -5))));
        ix = kept.length === saved.length && !added.length ? saved : [...kept, ...added];
      }
      const old = ix.filter((c) => !Array.isArray(c.files)); // written by a version before attachments: read their files once
      if (old.length) {
        const got = new Map((await entries(old.map((c) => c.id + '.json'))).map((c) => [c.id, c]));
        ix = ix.map((c) => got.get(c.id) ?? c);
      }
      if (ix !== saved && (ix.length || saved)) await io.write(INDEX, JSON.stringify(ix));
      if (!swept) { swept = true; await sweep(ix); } // once a run: files of deleted chats, and of replies that were never saved
      return sorted(ix);
    }),
    /** The full chat `id`; an error if it no longer exists. */
    load: serial(async (id) => {
      const f = file(id);
      let text;
      try { text = await io.read(f); }
      catch (e) { if (e?.code === 'UNREADABLE') await io.setAside?.(f).catch(() => {}); throw e; } // as in list: it can never open, so the next list drops it
      if (text === null) throw new Error('This chat no longer exists');
      return JSON.parse(text);
    }),
    /** Writes the chat, then its index entry. */
    save: serial(async (chat) => {
      const f = file(chat.id), entry = entryOf(chat), ix = await index(), had = ix.find((c) => c.id === chat.id), rest = ix.filter((c) => c.id !== chat.id);
      // new files go in the index first, so an app killed before the index catches up can't have them swept as unused
      const added = Array.isArray(had?.files) ? entry.files.filter((r) => !had.files.includes(r)) : [];
      if (added.length) await io.write(INDEX, JSON.stringify([...rest, { ...had, files: [...had.files, ...added] }]));
      await io.write(f, JSON.stringify(chat));
      await io.write(INDEX, JSON.stringify([...rest, entry]));
    }),
    /**
     * Keeps a file (base64) and returns the name messages refer to it by; the same file is kept once.
     * shortcut: the folder takes text, so a file is base64 sealed as text (about 1.8x its size, decoded twice per read); give seal.js a byte path if files get big
     */
    saveFile: serial(async (data) => {
      if (typeof data !== 'string') throw new Error('Invalid file');
      const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
      const name = `a-${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}.bin`;
      const known = fresh.has(name); fresh.add(name);
      if (!stored) { stored = new Set(await io.list()); lost = [...stored].some((n) => n.endsWith('.unreadable')); }
      // after a lost key, one from an earlier run may be sealed with it: write it again unless it still reads (this decrypts it, so only then)
      if (!stored.has(name) || (lost && !known && !(await io.read(name).then((d) => d !== null, () => false)))) { await io.write(name, data); stored.add(name); }
      return name;
    }),
    /** File `ref` as base64; an error if it's gone. */
    async readFile(ref) {
      const data = await io.read(fileName(ref));
      if (data === null) throw new Error('This file is no longer saved');
      return data;
    },
    /** Seals any file still saved as plain text (from before encryption). Returns how many it sealed. */
    upgrade: serial(async () => {
      if (!io.needsSeal) return 0;
      const all = (await io.list()).filter((x) => x.endsWith('.json')), hasIndex = all.includes(INDEX);
      // the index is sealed last, so a sealed index means nothing is left (an older build that writes plain chats rewrites it plain)
      if (hasIndex && !(await io.needsSeal(INDEX))) return 0;
      let n = 0;
      for (const name of [...all.filter((x) => x !== INDEX), ...(hasIndex ? [INDEX] : [])]) if (await io.needsSeal(name)) { await io.write(name, await io.read(name)); n++; }
      return n;
    }),
    /** Deletes the chat, then its index entry. */
    remove: serial(async (id) => {
      await io.remove(file(id));
      const ix = (await index()).filter((c) => c.id !== id);
      await io.write(INDEX, JSON.stringify(ix));
      await sweep(ix);
    }),
  };
  /** A reply from api.chatStream with its attached files saved: each becomes {name, mime, size, ref}. If they can't be saved, the reply comes back without them and says so. */
  store.keepFiles = async (reply) => {
    if (!reply?.files) return reply;
    const { files, ...rest } = reply, out = [];
    try { for (const { data, ...f } of files) out.push({ ...f, ref: await store.saveFile(data) }); }
    catch (e) { return { ...rest, error: rest.error || `The attached files couldn't be saved: ${e.message}` }; }
    return { ...rest, files: out };
  };
  return store;
}
makeChats.filesOf = filesOf;
module.exports = makeChats;
