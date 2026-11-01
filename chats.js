// One JSON file per chat, plus _index.json (id, title, updated, personaId) so listing never opens the chats themselves.
// Each chat holds only its own messages, which is what keeps chats isolated.
const fs = require('node:fs');
const path = require('node:path');

module.exports = (dir) => {
  const file = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid chat id');
    return path.join(dir, id + '.json');
  };
  const indexFile = path.join(dir, '_index.json'); // '_' can't appear in an id, so it never collides with a chat
  const atomicWrite = (f, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f + '.tmp', text, { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // a crash mid-write can't corrupt the saved file
  };
  const scan = () => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== '_index.json'); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { const c = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); out.push({ id: c.id, title: c.title, updated: c.updated, personaId: c.personaId }); }
      catch {} // skip a corrupt file instead of losing the whole list
    }
    return out;
  };
  const readIndex = () => { try { const ix = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(ix) ? ix : null; } catch { return null; } };
  const index = () => readIndex() ?? scan(); // missing or damaged index: rebuild from the chats
  const sorted = (ix) => ix.toSorted((a, b) => b.updated - a.updated);

  return {
    list() {
      let ix = readIndex();
      if (!ix) { ix = scan(); if (ix.length) atomicWrite(indexFile, JSON.stringify(ix)); }
      return sorted(ix);
    },
    load: (id) => JSON.parse(fs.readFileSync(file(id), 'utf8')),
    save(chat) {
      const f = file(chat.id);
      atomicWrite(f, JSON.stringify(chat));
      atomicWrite(indexFile, JSON.stringify([...index().filter((c) => c.id !== chat.id), { id: chat.id, title: chat.title, updated: chat.updated, personaId: chat.personaId }]));
    },
    remove(id) {
      fs.rmSync(file(id), { force: true });
      atomicWrite(indexFile, JSON.stringify(index().filter((c) => c.id !== id)));
    },
  };
};
