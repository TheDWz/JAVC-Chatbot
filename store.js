// Settings + profiles on disk. File access (`io`, see disk.js) and key encryption (`crypto`) are injected,
// so the same code runs on the desktop (Node fs + Electron safeStorage), on Android, and in the tests.
/** @typedef {import('./disk').DiskIo} DiskIo */
/** @typedef {{available(): (boolean|Promise<boolean>), enc(text: string): (string|Promise<string>), dec(data: string): (string|Promise<string>)}} KeyCrypto */
const profiles = require('./profiles');
const { THINKING_SWITCH } = require('./api');
const Lib = require('./lib');
const { parseConfig } = require('./mcp');

const FILE = 'settings.json';
const hasKey = (o) => !!(o.keyEnc || o.keyPlain);

/**
 * The settings store: profiles, personas and display settings in settings.json.
 * @param {{io: DiskIo, crypto: KeyCrypto}} deps `io` is the data folder (see disk.js). `crypto` is
 *   { available(): boolean, enc(text): base64, dec(base64): text (throws when it can't) }; each may return a promise.
 */
module.exports = ({ io, crypto }) => {
  let notice = '';
  // One operation at a time, so two quick changes can never read the same old file and overwrite each other.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => { const run = queue.then(() => fn(...args)); queue = run.catch(() => {}); return run; };

  /** Key fields for a profile: encrypted when a keyring is available, otherwise kept as-is (the file is still private to the user). */
  const encKey = async (key) => ((await crypto.available()) ? { keyEnc: await crypto.enc(key) } : { keyPlain: key });

  const write = (st) => io.write(FILE, JSON.stringify(st, null, 2));

  /** Moves a damaged settings file aside under the first free name (settings.json.bad, .bad-2, …), so no earlier copy is overwritten. */
  async function quarantine() {
    const names = new Set(await io.list());
    let bad = FILE + '.bad';
    for (let i = 2; names.has(bad); i++) bad = `${FILE}.bad-${i}`;
    await io.rename(FILE, bad);
    notice = `Your settings file was damaged. A copy was kept as ${bad}, so profiles and keys need to be set up again.`;
  }

  /**
   * Reads the settings, migrating older formats. A file that can't be parsed is quarantined; a read error propagates and
   * leaves the file alone. A missing file is not written back, so a first run (or an unfinished move from the old
   * folder, see disk.js) leaves no settings.json until something is actually saved.
   */
  async function read() {
    let raw = {};
    const text = await io.read(FILE);
    if (text !== null) {
      try { raw = JSON.parse(text) ?? {}; }
      catch { await quarantine(); } // damaged file: keep it for recovery instead of treating this as a first run and overwriting it
    }
    const st = profiles.migrate(raw);
    let changed = text !== null && raw.version !== 2; // persist a migrated file right away so profile ids stay stable
    if (await crypto.available()) { // upgrade leftover plaintext keys now that a keyring is available
      for (const p of [...st.profiles, st.search, st.mcp, ...Object.values(st.mcp.auth)]) if (p.keyPlain) { Object.assign(p, await encKey(p.keyPlain)); delete p.keyPlain; changed = true; }
    }
    if (changed) await write(st);
    return st;
  }

  /** The decrypted API key of a stored profile (or the search key), or a clear error when the keyring can't decrypt it. */
  async function keyOf(p, what = 'API key') {
    if (p.keyEnc) {
      try { return await crypto.dec(p.keyEnc); }
      catch { throw new Error(`Couldn't read the saved ${what} (the system keyring may be locked or changed). Type the key again and save.`); }
    }
    return p.keyPlain || '';
  }
  const withFlags = (st) => {
    const v = profiles.publicView(st);
    for (const p of v.profiles) p.thinkingSwitch = THINKING_SWITCH.test(p.endpoint);
    return v;
  };
  const commit = async (st) => { await write(st); return withFlags(st); };

  return {
    read: serial(read), write: serial(write),
    /** The one-time message about a damaged settings file, if there is one; cleared once taken. */
    takeNotice() { const n = notice; notice = ''; return n; },
    get: serial(async () => withFlags(await read())),
    /** Flat view of profile `profileId` (the active one when it's not given or no longer exists), used by chat and model fetching. */
    load: serial(async ({ search: wantSearch = false, profileId } = /** @type {{search?: boolean, profileId?: string}} */ ({})) => {
      const st = await read(), p = st.profiles.find((x) => x.id === profileId) || st.profiles.find((x) => x.id === st.activeId);
      if (!p) throw new Error('No profile yet. Use the new-profile button to add one.');
      // the search key is only decrypted when the caller will search, so a locked keyring can't break model refresh or chats without search
      const search = wantSearch && st.search.enabled && hasKey(st.search) ? { key: await keyOf(st.search, 'search key') } : null;
      return { endpoint: p.endpoint, model: p.model || '', effort: st.effort || '', format: p.format || 'auto', meta: !!p.meta, key: await keyOf(p), search };
    }),
    /** The Linkup API key, or '' when none is saved. */
    searchKey: serial(async () => keyOf((await read()).search, 'search key')),
    /** Saves {enabled, key} for web search. No `key` field keeps the stored key; `key: ''` clears it. */
    saveSearch: serial(async (p) => {
      const st = await read();
      if (typeof p.enabled === 'boolean') st.search.enabled = p.enabled;
      if (typeof p.key === 'string') {
        delete st.search.keyEnc; delete st.search.keyPlain;
        if (p.key.trim()) Object.assign(st.search, await encKey(p.key.trim()));
      }
      return commit(st);
    }),
    /** The pasted MCP config as text, or '' when there is none. */
    mcpConfig: serial(async () => keyOf((await read()).mcp, 'MCP servers')),
    /** The MCP servers ({name: entry}, see mcp.js), or {} when MCP is off or none are set up. */
    mcpServers: serial(async () => { const m = (await read()).mcp; return m.enabled && hasKey(m) ? parseConfig(await keyOf(m, 'MCP servers')) : {}; }),
    /**
     * Saves {enabled, config} for MCP. `config` is checked first, so a bad paste throws and saves nothing; '' removes every server.
     * A server whose entry changed, or that is gone, loses its "Always allow" tools and its sign-in.
     */
    saveMcp: serial(async (p) => {
      const st = await read();
      if (typeof p.enabled === 'boolean') st.mcp.enabled = p.enabled;
      if (typeof p.config === 'string') {
        const next = parseConfig(p.config);
        let prev = {}; try { prev = parseConfig(await keyOf(st.mcp, 'MCP servers')); } catch {} // unreadable: treat every server as new
        for (const name of new Set([...Object.keys(st.mcp.allow), ...Object.keys(st.mcp.auth)])) {
          if (!next[name] || JSON.stringify(prev[name]) !== JSON.stringify(next[name])) { delete st.mcp.allow[name]; delete st.mcp.auth[name]; }
        }
        delete st.mcp.keyEnc; delete st.mcp.keyPlain;
        if (p.config.trim()) Object.assign(st.mcp, await encKey(p.config.trim()));
        st.mcp.names = Object.keys(next);
      }
      return commit(st);
    }),
    /** A url server's sign-in tokens (see mcp.js), or null when there are none or they can't be read. */
    mcpTokens: serial(async (name) => {
      const rec = (await read()).mcp.auth[name];
      if (!rec) return null;
      try { return JSON.parse(await keyOf(rec, 'sign-in')); } catch { return null; } // unreadable: the server shows as needing sign-in again
    }),
    /** Saves a url server's sign-in tokens; null forgets them. */
    saveMcpTokens: serial(async (name, tokens) => {
      const st = await read();
      if (tokens) { if (st.mcp.names.includes(name)) st.mcp.auth[name] = await encKey(JSON.stringify(tokens)); }
      else delete st.mcp.auth[name];
      await write(st);
    }),
    /** Remembers "Always allow" for one server's tool. */
    allowMcpTool: serial(async (server, tool) => {
      const st = await read(), list = st.mcp.allow[server] || [];
      if (st.mcp.names.includes(server) && !list.includes(tool)) st.mcp.allow[server] = [...list, tool];
      return commit(st);
    }),
    /** The API key of profile `id`, or '' for an unknown profile. */
    key: serial(async (id) => { const p = (await read()).profiles.find((x) => x.id === id); return p ? keyOf(p) : ''; }),
    /** Applies a partial change: {effort, personaId, render, theme, summarizer, contextLimit} are global; {model, meta, noTools, ctx} belong to the active profile. Invalid values are ignored. */
    patch: serial(async (patch) => {
      let st = await read();
      if (st.personas.some((p) => p.id === patch.personaId)) st.personaId = patch.personaId;
      if (patch.effort !== undefined) st.effort = patch.effort || '';
      if (patch.render && typeof patch.render === 'object') for (const k of Lib.RENDER_KEYS) if (typeof patch.render[k] === 'boolean') st.render = { ...st.render, [k]: patch.render[k] };
      const theme = Lib.cleanTheme(patch.theme); if (theme) st.theme = theme;
      const sum = profiles.cleanSummarizer(patch.summarizer); if (sum) st.summarizer = sum;
      const lim = profiles.cleanContextLimit(patch.contextLimit); if (lim) st.contextLimit = lim;
      const own = {}; for (const k of ['model', 'meta']) if (patch[k] !== undefined) own[k] = patch[k];
      if (typeof patch.noTools === 'boolean') own.noTools = patch.noTools; // whether the profile's current model is known to lack tool support
      if (Number.isInteger(patch.ctx) && patch.ctx >= 0) own.ctx = patch.ctx; // the current model's context limit from its list; 0 = the list gives none
      if (Object.keys(own).length && st.activeId) st = profiles.upsert(st, { id: st.activeId, ...own }); // never create a profile from a patch
      return commit(st);
    }),
    /** Creates or updates a profile. No `key` field keeps the stored key; `key: ''` clears it. */
    saveProfile: serial(async (p) => {
      let url; try { url = new URL(String(p.endpoint || '').trim()); } catch { throw new Error('Endpoint must be a valid URL'); }
      if (!/^https?:$/.test(url.protocol)) throw new Error('Endpoint must start with http:// or https://');
      const upd = { id: p.id, name: (p.name || '').trim() || url.host, endpoint: url.href.replace(/\/+$/, ''), format: p.format || 'auto' };
      if (typeof p.key === 'string') Object.assign(upd, p.key.trim() ? await encKey(p.key.trim()) : { keyEnc: '' }); // no `key` field at all means "keep the stored key"
      return commit(profiles.upsert(await read(), upd));
    }),
    /** Creates or updates a persona and makes it the selected one. A `summarizer` turns on its own summary model; without one it uses the default. */
    savePersona: serial(async (p) => {
      const st = await read(), s = (v) => String(v ?? '').trim(), sum = profiles.cleanSummarizer(p.summarizer);
      const rec = /** @type {{user: string, bot: string, prompt: string, summarizer?: {profileId: string, model: string}, name?: string}} */ ({ user: s(p.user), bot: s(p.bot), prompt: s(p.prompt), ...(sum && { summarizer: sum }) });
      rec.name = s(p.name) || rec.bot || 'Persona';
      const id = st.personas.some((x) => x.id === p.id) ? p.id : 'ps-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      st.personas = st.personas.some((x) => x.id === id) ? st.personas.map((x) => (x.id === id ? { id, ...rec } : x)) : [...st.personas, { id, ...rec }];
      st.personaId = id;
      return commit(st);
    }),
    /** Deletes a persona (never Default); its chats then count as Default's. */
    deletePersona: serial(async (id) => {
      if (id === 'default') throw new Error("The Default persona can't be deleted");
      const st = await read();
      st.personas = st.personas.filter((p) => p.id !== id);
      if (st.personaId === id) st.personaId = 'default';
      return commit(st);
    }),
    deleteProfile: serial(async (id) => commit(profiles.remove(await read(), id))),
    /** Makes profile `id` the active one. */
    activate: serial(async (id) => {
      const st = await read();
      if (!st.profiles.some((p) => p.id === id)) throw new Error('Unknown profile');
      st.activeId = id; return commit(st);
    }),
  };
};
