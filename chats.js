// One JSON file per chat, plus _index.json (id, title, updated, personaId) so listing doesn't open every chat.
// Each chat holds only its own messages, which is what keeps chats isolated.
// `io` is the chats folder (see disk.js); the same code runs on the desktop and on Android. Hosts pass it sealed (seal.js),
// so every file is encrypted; `ready`, `needsSeal` and `setAside` come from there.

/**
 * The chat history store.
 * @param {import('./disk').DiskIo & {ready?(): Promise<void>, needsSeal?(name: string): Promise<boolean>, setAside?(name: string): Promise<void>}} io The chats folder:
 *   { read, write, remove, list } as in disk.js, optionally sealed.
 */
module.exports = (io) => {
  /** The file name of chat `id`; rejects anything that isn't a plain id, so a name can never point outside the folder. */
  const file = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid chat id');
    return id + '.json';
  };
  const INDEX = '_index.json'; // '_' can't appear in an id, so it never collides with a chat
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
        if (c && c.id + '.json' === n) out.push({ id: c.id, title: c.title, updated: c.updated, personaId: c.personaId });
      } catch (e) { if (e?.code === 'UNREADABLE') await io.setAside?.(n).catch(() => {}); } // it would fail every list; the seal gives one notice
    }
    return out;
  };
  /** The saved index, or null when it's missing or damaged. */
  const readIndex = async () => { try { const ix = JSON.parse(await io.read(INDEX)); return Array.isArray(ix) ? ix : null; } catch { return null; } };
  /** The index, rebuilt from the chat files when it's missing or damaged. */
  const index = async () => (await readIndex()) ?? entries((await chatFiles()) ?? []);
  const sorted = (ix) => [...ix].sort((a, b) => b.updated - a.updated);

  return {
    /**
     * All chats, newest first. The index is checked against the chat files, so an interrupted save or delete can't hide a
     * chat or list a deleted one: entries without a file are dropped and files missing from the index are added.
     */
    list: serial(async () => {
      await io.ready?.(); // a key that can't be unlocked is an error, not an empty list: the reads below skip what they can't read
      const names = await chatFiles(), saved = await readIndex();
      if (!names) return sorted(saved ?? []); // can't see the folder: show what the index says
      let ix = saved;
      if (!ix) ix = await entries(names);
      else {
        const onDisk = new Set(names.map((n) => n.slice(0, -5)));
        const kept = ix.filter((c) => onDisk.has(c.id)), known = new Set(kept.map((c) => c.id));
        const added = await entries(names.filter((n) => !known.has(n.slice(0, -5))));
        ix = kept.length === saved.length && !added.length ? saved : [...kept, ...added];
      }
      if (ix !== saved && (ix.length || saved)) await io.write(INDEX, JSON.stringify(ix));
      return sorted(ix);
    }),
    /** The full chat `id`; an error if it no longer exists. */
    load: serial(async (id) => {
      const text = await io.read(file(id));
      if (text === null) throw new Error('This chat no longer exists');
      return JSON.parse(text);
    }),
    /** Writes the chat, then its index entry. */
    save: serial(async (chat) => {
      const f = file(chat.id);
      await io.write(f, JSON.stringify(chat));
      await io.write(INDEX, JSON.stringify([...(await index()).filter((c) => c.id !== chat.id), { id: chat.id, title: chat.title, updated: chat.updated, personaId: chat.personaId }]));
    }),
    /** Seals any file still saved as plain text (from before encryption). Returns how many it sealed. */
    upgrade: serial(async () => {
      if (!io.needsSeal) return 0;
      let n = 0;
      for (const name of (await io.list()).filter((x) => x.endsWith('.json'))) if (await io.needsSeal(name)) { await io.write(name, await io.read(name)); n++; }
      return n;
    }),
    /** Deletes the chat, then its index entry. */
    remove: serial(async (id) => {
      await io.remove(file(id));
      await io.write(INDEX, JSON.stringify((await index()).filter((c) => c.id !== id)));
    }),
  };
};
