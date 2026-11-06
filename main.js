const { app, BrowserWindow, ipcMain, safeStorage, protocol, session, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const api = require('./api');
const Lib = require('./lib');
const makeChats = require('./chats');
const makeStore = require('./store');
const { makeDisk, migrateLegacy } = require('./disk');

// Rich replies (HTML/CSS/JS from the model) run in sandboxed iframes loaded from this scheme. Being a non-local scheme,
// the documents don't inherit the app's CSP; the `sandbox` header and attribute keep them in an opaque origin with no access to the app.
protocol.registerSchemesAsPrivileged([{ scheme: 'chatbot-sandbox', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const richDocs = new Map(); // id -> {doc, csp}; the page and its CSP come from Lib.richDoc, shared with the Android app
/** Stores a rich block's page and returns the chatbot-sandbox: URL it's served from (the 300 newest are kept). */
ipcMain.handle('sandbox:create', async (_e, html, color, scheme, flags) => {
  if (typeof html !== 'string' || html.length > Lib.RICH_MAX) throw new Error('This content is too large to display');
  const id = randomUUID();
  richDocs.set(id, await Lib.richDoc(html, color, scheme, flags));
  if (richDocs.size > 300) richDocs.delete(richDocs.keys().next().value);
  return 'chatbot-sandbox://doc/' + id;
});

try { // the app was called "chatbot" before the JAVC rename; bring its settings and chats along
  const moved = migrateLegacy(path.join(app.getPath('appData'), 'chatbot'), app.getPath('userData'));
  if (moved.length) console.log('Moved from the old chatbot folder:', moved.join(', '));
} catch (e) { console.error('Could not move data from the old chatbot folder:', e); }

const store = makeStore({
  io: makeDisk(app.getPath('userData')),
  crypto: {
    available: () => safeStorage.isEncryptionAvailable(),
    enc: (t) => safeStorage.encryptString(t).toString('base64'),
    dec: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  },
});

/** The settings for the page, with any one-time notice (such as a damaged settings file). */
ipcMain.handle('settings:get', async () => { const st = await store.get(); return { ...st, notice: store.takeNotice() }; });
ipcMain.handle('settings:patch', (_e, patch) => store.patch(patch));
ipcMain.handle('profiles:save', (_e, p) => store.saveProfile(p));
ipcMain.handle('personas:save', (_e, p) => store.savePersona(p));
ipcMain.handle('personas:delete', (_e, id) => store.deletePersona(id));
ipcMain.handle('profiles:delete', (_e, id) => store.deleteProfile(id));
ipcMain.handle('profiles:activate', (_e, id) => store.activate(id));
ipcMain.handle('profiles:key', (_e, id) => store.key(id));
ipcMain.handle('search:save', (_e, p) => store.saveSearch(p));
ipcMain.handle('search:key', () => store.searchKey());
ipcMain.handle('models:list', async () => { const s = await store.load(); return api.listModelsDetailed(s.endpoint, s.key); });

const running = new Map(); // request id -> AbortController, so the Stop button can cancel a reply
ipcMain.handle('chat:abort', (_e, id) => running.get(id)?.abort());
/** Streams a reply: deltas go to the page as 'chat:delta' events; resolves to the full reply. */
ipcMain.handle('chat:send', async (e, id, messages, opts) => {
  const ctl = new AbortController();
  running.set(id, ctl); // before any await, so Stop works from the first moment
  const onDelta = (d) => { if (!e.sender.isDestroyed()) e.sender.send('chat:delta', id, d); };
  try {
    const s = await store.load({ search: !!opts?.search });
    return await api.chatStream(s.endpoint, s.key, s.model, messages, api.reasoningParams(s.endpoint, s.effort, s), onDelta, undefined, ctl.signal, opts?.search ? s.search : null);
  } finally { running.delete(id); }
});

const chats = makeChats(makeDisk(path.join(app.getPath('userData'), 'chats')));
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
  const win = new BrowserWindow({
    width: 900, height: 700, backgroundColor: '#15161a', autoHideMenuBar: true,
    // shortcut: Wayland ignores this and uses the .desktop file's icon; it matters on Windows and X11.
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  protocol.handle('chatbot-sandbox', (req) => {
    const rec = richDocs.get(new URL(req.url).pathname.slice(1));
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
