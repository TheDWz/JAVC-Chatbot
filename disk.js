// Desktop file access for store.js and chats.js: one folder, flat file names, plain Node fs.
// Android has its own version of this interface in mobile/native.js.
const fs = require('node:fs');
const path = require('node:path');

/**
 * File access rooted at one folder, with flat file names.
 * @param {string} root The folder.
 * @returns {{read(name): Promise<string|null>, write(name, text): Promise<void>, remove(name): Promise<void>, list(): Promise<string[]>, rename(from, to): Promise<void>}}
 *   `read` gives null for a missing file; `write` is atomic and owner-only; `remove` of a missing file is fine; `list` of a missing folder is [].
 */
function makeDisk(root) {
  /** The full path of `name`, which must be a plain file name (no folders, no `..`). */
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

/**
 * Moves settings and chats from the old data folder (the app was named "chatbot" before the JAVC rename).
 * Each item moves on its own and is retried on every launch, so a move that was interrupted is finished later.
 * Nothing in `to` is ever overwritten: settings only move into a folder that has none, and chats are merged file by
 * file into an existing chats folder (chats.js adds files that aren't in its index).
 * @returns {string[]} What was moved.
 */
function migrateLegacy(from, to) {
  const moved = [], has = (...p) => fs.existsSync(path.join(...p));
  const move = (name) => { fs.mkdirSync(path.dirname(path.join(to, name)), { recursive: true }); fs.renameSync(path.join(from, name), path.join(to, name)); moved.push(name); };
  for (const name of ['settings.json', 'settings.json.bad']) if (has(from, name) && !has(to, name)) move(name);
  if (has(from, 'chats')) {
    if (!has(to, 'chats')) move('chats');
    else for (const n of fs.readdirSync(path.join(from, 'chats'))) if (n.endsWith('.json') && n !== '_index.json' && !has(to, 'chats', n)) move(path.join('chats', n));
  }
  return moved;
}

module.exports = { makeDisk, migrateLegacy };
