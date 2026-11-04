// Settings + profiles on disk. Electron's safeStorage is injected as `crypto` so this can be tested without Electron.
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('./profiles');
const { THINKING_SWITCH } = require('./api');
const Lib = require('./lib');

// crypto: { available(): boolean, enc(text): base64, dec(base64): text (throws when it can't)}
module.exports = ({ file, crypto }) => {
  let notice = '';
  const encKey = (key) => (crypto.available() ? { keyEnc: crypto.enc(key) } : { keyPlain: key }); // no keyring: the file is still chmod 600

  function write(st) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file); // a crash mid-write can't leave a half-written settings file
  }

  function read() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; }
    catch (e) {
      if (e.code !== 'ENOENT') { // damaged file: keep it for recovery instead of treating this as a first run and overwriting it
        fs.renameSync(file, file + '.bad');
        notice = `Your settings file was damaged. A copy was kept as ${path.basename(file)}.bad, so profiles and keys need to be set up again.`;
      }
    }
    const st = profiles.migrate(raw);
    let changed = raw.version !== 2; // persist a migrated file right away so profile ids stay stable
    if (crypto.available()) { // upgrade leftover plaintext keys now that a keyring is available
      for (const p of st.profiles) if (p.keyPlain) { Object.assign(p, encKey(p.keyPlain)); delete p.keyPlain; changed = true; }
    }
    if (changed) write(st);
    return st;
  }

  function keyOf(p) {
    if (p.keyEnc) {
      try { return crypto.dec(p.keyEnc); }
      catch { throw new Error("Couldn't read the saved API key (the system keyring may be locked or changed). Type the key again and save."); }
    }
    return p.keyPlain || '';
  }
  const withFlags = (st) => {
    const v = profiles.publicView(st);
    for (const p of v.profiles) p.thinkingSwitch = THINKING_SWITCH.test(p.endpoint);
    return v;
  };
  const commit = (st) => { write(st); return withFlags(st); };

  return {
    read, write,
    takeNotice() { const n = notice; notice = ''; return n; },
    get: () => withFlags(read()),
    // Flat view of the active profile, used by chat and model fetching.
    load() {
      const st = read(), p = st.profiles.find((x) => x.id === st.activeId);
      if (!p) throw new Error('No profile yet. Use the new-profile button to add one.');
      return { endpoint: p.endpoint, model: p.model || '', effort: st.effort || '', format: p.format || 'auto', meta: !!p.meta, key: keyOf(p) };
    },
    key(id) { const p = read().profiles.find((x) => x.id === id); return p ? keyOf(p) : ''; },
    patch(patch) { // {effort, personaId, render, theme} are global; {model, meta} belong to the active profile
      let st = read();
      if (st.personas.some((p) => p.id === patch.personaId)) st.personaId = patch.personaId;
      if (patch.effort !== undefined) st.effort = patch.effort || '';
      if (patch.render && typeof patch.render === 'object') for (const k of Lib.RENDER_KEYS) if (typeof patch.render[k] === 'boolean') st.render = { ...st.render, [k]: patch.render[k] };
      const theme = Lib.cleanTheme(patch.theme); if (theme) st.theme = theme;
      const own = {}; for (const k of ['model', 'meta']) if (patch[k] !== undefined) own[k] = patch[k];
      if (Object.keys(own).length && st.activeId) st = profiles.upsert(st, { id: st.activeId, ...own }); // never create a profile from a patch
      return commit(st);
    },
    saveProfile(p) {
      let url; try { url = new URL(String(p.endpoint || '').trim()); } catch { throw new Error('Endpoint must be a valid URL'); }
      if (!/^https?:$/.test(url.protocol)) throw new Error('Endpoint must start with http:// or https://');
      const upd = { id: p.id, name: (p.name || '').trim() || url.host, endpoint: url.href.replace(/\/+$/, ''), format: p.format || 'auto' };
      if (typeof p.key === 'string') Object.assign(upd, p.key.trim() ? encKey(p.key.trim()) : { keyEnc: '' }); // no `key` field at all means "keep the stored key"
      return commit(profiles.upsert(read(), upd));
    },
    savePersona(p) {
      const st = read(), s = (v) => String(v ?? '').trim();
      const rec = { user: s(p.user), bot: s(p.bot), prompt: s(p.prompt) };
      rec.name = s(p.name) || rec.bot || 'Persona';
      const id = st.personas.some((x) => x.id === p.id) ? p.id : 'ps-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      st.personas = st.personas.some((x) => x.id === id) ? st.personas.map((x) => (x.id === id ? { id, ...rec } : x)) : [...st.personas, { id, ...rec }];
      st.personaId = id;
      return commit(st);
    },
    deletePersona(id) {
      if (id === 'default') throw new Error("The Default persona can't be deleted");
      const st = read();
      st.personas = st.personas.filter((p) => p.id !== id);
      if (st.personaId === id) st.personaId = 'default';
      return commit(st);
    },
    deleteProfile: (id) => commit(profiles.remove(read(), id)),
    activate(id) {
      const st = read();
      if (!st.profiles.some((p) => p.id === id)) throw new Error('Unknown profile');
      st.activeId = id; return commit(st);
    },
  };
};

// One-time move of settings and chats from an old data folder (the app was named "chatbot" before the JAVC rename).
// Item by item, because Electron may already have created the new folder; nothing in `to` is ever overwritten.
module.exports.migrateLegacy = (from, to) => {
  if (fs.existsSync(path.join(to, 'settings.json')) || !fs.existsSync(path.join(from, 'settings.json'))) return [];
  fs.mkdirSync(to, { recursive: true });
  const moved = [];
  for (const name of ['settings.json', 'settings.json.bad', 'chats']) {
    if (fs.existsSync(path.join(from, name)) && !fs.existsSync(path.join(to, name))) { fs.renameSync(path.join(from, name), path.join(to, name)); moved.push(name); }
  }
  return moved;
};
