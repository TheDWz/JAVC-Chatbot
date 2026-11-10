const { app, clipboard, BrowserWindow, ipcMain, safeStorage, protocol, session, shell } = require('electron');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const api = require('./api');
const Lib = require('./lib');
const makeChats = require('./chats');
const makeStore = require('./store');
const { makeChatSeal } = require('./seal');
const Mcp = require('./mcp');
const { makeDisk, migrateLegacy } = require('./disk');

// Rich replies (HTML/CSS/JS from the model) run in sandboxed iframes loaded from this scheme. Being a non-local scheme,
// the documents don't inherit the app's CSP; the `sandbox` header and attribute keep them in an opaque origin with no access to the app.
protocol.registerSchemesAsPrivileged([{ scheme: 'chatbot-sandbox', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const richDocs = new Map(); // id -> {doc, csp}; the page and its CSP come from Lib.richDoc, shared with the Android app
/** Stores a rich block's page and returns the chatbot-sandbox: URL it's served from (the 300 most recently used are kept). */
ipcMain.handle('sandbox:create', async (_e, html, color, scheme, flags) => {
  if (typeof html !== 'string' || html.length > Lib.RICH_MAX) throw new Error('This content is too large to display');
  const rec = await Lib.richDoc(html, color, scheme, flags);
  const id = createHash('sha256').update(rec.csp + '\n' + rec.doc).digest('hex'); // the same page gets the same id, so re-renders reuse it
  richDocs.delete(id); richDocs.set(id, rec); // re-set: the Map's order is the eviction order
  if (richDocs.size > 300) richDocs.delete(richDocs.keys().next().value);
  return 'chatbot-sandbox://doc/' + id;
});

try { // the app was called "chatbot" before the JAVC rename; bring its settings and chats along
  const moved = migrateLegacy(path.join(app.getPath('appData'), 'chatbot'), app.getPath('userData'));
  if (moved.length) console.log('Moved from the old chatbot folder:', moved.join(', '));
} catch (e) { console.error('Could not move data from the old chatbot folder:', e); }

/** The OS keyring (DPAPI on Windows, the Secret Service or KWallet on Linux): wraps API keys and the chat key. */
const keyring = {
  available: () => safeStorage.isEncryptionAvailable(),
  enc: (t) => safeStorage.encryptString(t).toString('base64'),
  dec: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
};
const store = makeStore({ io: makeDisk(app.getPath('userData')), crypto: keyring });
// Chats are encrypted with a key the keyring wraps (seal.js). It loads on first use, after the app is ready, as Linux's keyring needs.
const seal = makeChatSeal({ io: makeDisk(app.getPath('userData')), crypto: keyring, chats: makeDisk(path.join(app.getPath('userData'), 'chats')) });

/** The settings for the page, with any one-time notice (such as a damaged settings file). */
ipcMain.handle('settings:get', async () => {
  const st = await store.get(); await seal.status(); // loading the chat key here gets any notice about it in too
  return { ...st, notice: [store.takeNotice(), seal.takeNotice()].filter(Boolean).join(' ') };
});
ipcMain.handle('settings:patch', (_e, patch) => store.patch(patch));
ipcMain.handle('profiles:save', (_e, p) => store.saveProfile(p));
ipcMain.handle('personas:save', (_e, p) => store.savePersona(p));
ipcMain.handle('personas:delete', (_e, id) => store.deletePersona(id));
ipcMain.handle('profiles:delete', (_e, id) => store.deleteProfile(id));
ipcMain.handle('profiles:activate', (_e, id) => store.activate(id));
ipcMain.handle('profiles:key', (_e, id) => store.key(id));
ipcMain.handle('search:save', (_e, p) => store.saveSearch(p));
ipcMain.handle('search:key', () => store.searchKey());
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text ?? '')));
ipcMain.handle('models:list', async (_e, profileId) => { const s = await store.load({ profileId }); return api.listModelsDetailed(s.endpoint, s.key); });

const running = new Map(); // request id -> AbortController, so the Stop button can cancel a reply
ipcMain.handle('chat:abort', (_e, id) => running.get(id)?.abort());
/** Streams a reply: deltas go to the page as 'chat:delta' events; resolves to the full reply. `opts.summary` ({profileId, model}) writes a summary instead. */
ipcMain.handle('chat:send', async (e, id, messages, opts) => {
  const ctl = new AbortController();
  running.set(id, ctl); // before any await, so Stop works from the first moment
  const onDelta = (d) => { if (!e.sender.isDestroyed()) e.sender.send('chat:delta', id, d); };
  try {
    const sum = opts?.summary, s = await store.load(sum ? { profileId: sum.profileId } : { search: !!opts?.search });
    const { model, extra, search, mcp } = api.requestArgs(s, opts);
    return await api.chatStream(s.endpoint, s.key, model, messages, extra, onDelta, undefined, ctl.signal, search, mcp ? await Mcp.replyTools(hub, store, { approve: approver(e.sender), onDelta, signal: ctl.signal }) : undefined);
  } finally { running.delete(id); }
});

// ---- MCP servers: local ones run as child processes of this one ----
const win32 = process.platform === 'win32';
let loginPath = null;
/** The login shell's PATH, read once: an app started from the desktop menu misses what nvm, ~/.local/bin and the like add. */
const shellPath = () => (loginPath ??= win32 ? Promise.resolve(process.env.PATH || '') : new Promise((resolve) => {
  execFile(process.env.SHELL || '/bin/bash', ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 5000 }, (_err, out) => {
    const m = /__P__(.*)__P__/s.exec(String(out || '')); // .bashrc may print things of its own around it
    resolve([...new Set([m?.[1], process.env.PATH].filter(Boolean).join(path.delimiter).split(path.delimiter))].join(path.delimiter));
  });
}));
const quoteWin = (a) => (/[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a);
const hub = Mcp.makeHub({
  spawn: async (command, args, env) => {
    const opts = { env: { ...process.env, PATH: await shellPath(), ...env }, stdio: /** @type {['pipe', 'pipe', 'pipe']} */ (['pipe', 'pipe', 'pipe']), windowsHide: true };
    // shortcut: Windows goes through cmd so npx.cmd and uvx.exe resolve; quoting covers spaces and quotes, revisit if a server's args still break
    if (win32) return spawn([command, ...args].map(quoteWin).join(' '), { ...opts, shell: true });
    // its own process group, so SIGTERM/SIGKILL also reach the server that npx/uvx start under them
    // shortcut: on Windows only cmd.exe is killed; a server that ignores stdin closing outlives it, use taskkill /T if that bites
    const child = spawn(command, args, { ...opts, detached: true });
    child.kill = (sig) => { try { if (child.pid) process.kill(-child.pid, sig); return true; } catch { return false; } };
    return child;
  },
  auth: { get: (name) => store.mcpTokens(name), save: (name, tokens) => store.saveMcpTokens(name, tokens) },
});
/** Catches the browser's return from a sign-in on a one-time page on 127.0.0.1 (a loopback redirect, as OAuth asks of desktop apps). */
const listen = () => new Promise((resolve, reject) => {
  let got; const next = new Promise((r) => { got = r; });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const ok = u.searchParams.has('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>JAVC Chatbot</title><body style="font:16px system-ui;margin:3em;text-align:center">${ok ? 'Signed in. You can close this tab and go back to JAVC Chatbot.' : "Sign-in didn't finish. Go back to JAVC Chatbot to see why."}</body>`);
    got(new URL(req.url || '/', `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`).href);
  });
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => resolve({ uri: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/callback`, next, close: () => { srv.close(); srv.closeAllConnections(); } })); // the browser may keep its connection open
});
const openUrl = (url) => { if (!/^https?:/i.test(url)) throw new Error("The sign-in page isn't a web address"); return shell.openExternal(url); };
const mcpReady = async () => { hub.configure(await store.mcpServers()); return hub; };
ipcMain.handle('mcp:config', () => store.mcpConfig());
ipcMain.handle('mcp:save', async (_e, p) => { const v = await store.saveMcp(p); await mcpReady(); return v; });
ipcMain.handle('mcp:status', async () => (await mcpReady()).status());
ipcMain.handle('mcp:reload', async () => { await (await mcpReady()).reload(); return hub.status(); });
ipcMain.handle('mcp:signin', async (_e, name) => { await (await mcpReady()).signIn(name, { openUrl, listen }); return hub.status(); });
ipcMain.handle('mcp:signout', async (_e, name) => { await (await mcpReady()).signOut(name); return hub.status(); });
const asking = new Map(); // approval id -> resolve, while the page shows the dialog
ipcMain.handle('mcp:answer', (_e, id, answer) => asking.get(id)?.(answer));
/** Asks the page whether a tool may run: 'once' | 'always' | 'deny'. A page that closes or crashes meanwhile denies. */
const approver = (sender) => async (info) => {
  if (sender.isDestroyed()) return 'deny';
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (a) => { sender.off('destroyed', gone); sender.off('render-process-gone', gone); resolve(['once', 'always'].includes(a) ? a : 'deny'); };
    const gone = () => done('deny');
    asking.set(id, done);
    sender.once('destroyed', gone); sender.once('render-process-gone', gone);
    sender.send('mcp:approve', id, info);
  }).finally(() => asking.delete(id));
};
let quitting = false;
app.on('before-quit', (e) => { // stop the servers first; before-quit doesn't wait for promises by itself
  if (quitting) return;
  quitting = true; e.preventDefault();
  Promise.race([hub.closeAll(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.quit());
});

const chats = makeChats(seal.io);
/** Whether chats are encrypted and the key is really protected. Linux's 'basic_text' store uses a fixed built-in key, so it doesn't count. */
ipcMain.handle('chats:status', async () => {
  const s = await seal.status();
  if (s.keyring && process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') s.keyring = false;
  return s;
});
ipcMain.handle('chats:list', () => chats.list());
ipcMain.handle('chats:load', (_e, id) => chats.load(id));
ipcMain.handle('chats:save', (_e, chat) => chats.save(chat));
ipcMain.handle('chats:delete', (_e, id) => chats.remove(id));

ipcMain.handle('pdf:extract', async (_e, buf) => {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await parser.getText()).text; }
  finally { await parser.destroy(); }
});

app.whenReady().then(() => {
  chats.upgrade().then((n) => { if (n) console.log(`Encrypted ${n} chat files`); }, (e) => console.error('Could not encrypt the saved chats:', e));
  const win = new BrowserWindow({
    width: 900, height: 700, backgroundColor: '#15161a', autoHideMenuBar: true,
    // shortcut: Wayland ignores this and uses the .desktop file's icon; it matters on Windows and X11.
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  protocol.handle('chatbot-sandbox', (req) => {
    const id = new URL(req.url).pathname.slice(1), rec = richDocs.get(id);
    if (rec) { richDocs.delete(id); richDocs.set(id, rec); } // showing a page counts as using it, as on Android
    return rec
      ? new Response(rec.doc, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': rec.csp } })
      : new Response('Not found', { status: 404 });
  });
  // Rich content gets no camera, microphone, location, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // A clicked link opens in the system browser; the app window never navigates away.
  const external = (url) => { if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); external(url); } });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
