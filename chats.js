// One JSON file per chat, plus _index.json (id, title, updated, personaId) so listing never opens the chats themselves.
// Each chat holds only its own messages, which is what keeps chats isolated.
// `io` is the chats folder (see disk.js); the same code runs on the desktop and on Android.
module.exports = (io) => {
  const file = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid chat id');
    return id + '.json';
  };
  const INDEX = '_index.json'; // '_' can't appear in an id, so it never collides with a chat
  let queue = Promise.resolve(); // one operation at a time, so the index is never rewritten from a stale copy
  const serial = (fn) => (...args) => { const run = queue.then(() => fn(...args)); queue = run.catch(() => {}); return run; };

  const scan = async () => {
    let names = [];
    try { names = (await io.list()).filter((n) => n.endsWith('.json') && n !== INDEX); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { const c = JSON.parse(await io.read(n)); out.push({ id: c.id, title: c.title, updated: c.updated, personaId: c.personaId }); }
      catch {} // skip a corrupt file instead of losing the whole list
    }
    return out;
  };
  const readIndex = async () => { try { const ix = JSON.parse(await io.read(INDEX)); return Array.isArray(ix) ? ix : null; } catch { return null; } };
  const index = async () => (await readIndex()) ?? scan(); // missing or damaged index: rebuild from the chats
  const sorted = (ix) => [...ix].sort((a, b) => b.updated - a.updated);

  return {
    list: serial(async () => {
      let ix = await readIndex();
      if (!ix) { ix = await scan(); if (ix.length) await io.write(INDEX, JSON.stringify(ix)); }
      return sorted(ix);
    }),
    load: serial(async (id) => {
      const text = await io.read(file(id));
      if (text === null) throw new Error('This chat no longer exists');
      return JSON.parse(text);
    }),
    save: serial(async (chat) => {
      const f = file(chat.id);
      await io.write(f, JSON.stringify(chat));
      await io.write(INDEX, JSON.stringify([...(await index()).filter((c) => c.id !== chat.id), { id: chat.id, title: chat.title, updated: chat.updated, personaId: chat.personaId }]));
    }),
    remove: serial(async (id) => {
      await io.remove(file(id));
      await io.write(INDEX, JSON.stringify((await index()).filter((c) => c.id !== id)));
    }),
  };
};
