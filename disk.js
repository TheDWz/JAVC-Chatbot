// Desktop file access for store.js and chats.js: one folder, flat file names, plain Node fs.
// Android has its own version of this interface in mobile/native.js.
const fs = require('node:fs');
const path = require('node:path');

// io: { read(name) -> text | null when missing, write(name, text), remove(name), list() -> names, rename(from, to) }
function makeDisk(root) {
  const at = (name) => {
    if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Invalid file name');
    return path.join(root, name);
  };
  return {
    async read(name) {
      try { return fs.readFileSync(at(name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async write(name, text) {
      const f = at(name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(f + '.tmp', text, { mode: 0o600 });
      fs.renameSync(f + '.tmp', f); // a crash mid-write can't leave a half-written file
    },
    async remove(name) { fs.rmSync(at(name), { force: true }); },
    async list() {
      try { return fs.readdirSync(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    async rename(from, to) { fs.renameSync(at(from), at(to)); },
  };
}

// One-time move of settings and chats from an old data folder (the app was named "chatbot" before the JAVC rename).
// Item by item, because Electron may already have created the new folder; nothing in `to` is ever overwritten.
function migrateLegacy(from, to) {
  if (fs.existsSync(path.join(to, 'settings.json')) || !fs.existsSync(path.join(from, 'settings.json'))) return [];
  fs.mkdirSync(to, { recursive: true });
  const moved = [];
  for (const name of ['settings.json', 'settings.json.bad', 'chats']) {
    if (fs.existsSync(path.join(from, name)) && !fs.existsSync(path.join(to, name))) { fs.renameSync(path.join(from, name), path.join(to, name)); moved.push(name); }
  }
  return moved;
}

module.exports = { makeDisk, migrateLegacy };
