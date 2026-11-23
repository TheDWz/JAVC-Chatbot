// Android entry point, bundled into www/mobile.js by mobile/build.mjs. It gives the page the same window.api that
// preload.js and main.js give it on the desktop, built from the same store, chats and API client.
const { registerPlugin } = require('@capacitor/core');
const { App } = require('@capacitor/app');
const api = require('../api');
const Lib = require('../lib');
const makeStore = require('../store');
const makeChats = require('../chats');
const { makeChatSeal } = require('../seal');
const Backup = require('../backup');
const Mcp = require('../mcp');
const Make = require('../make');
const { makeNativeFetch, makeNativeDisk, makeNativeCrypto } = require('./native');

const Javc = registerPlugin('Javc');
const nativeFetch = makeNativeFetch(Javc);
const keyring = makeNativeCrypto(Javc); // the Android Keystore or the iOS Keychain: wraps API keys and the chat key
const store = makeStore({ io: makeNativeDisk(Javc), crypto: keyring });
const seal = makeChatSeal({ io: makeNativeDisk(Javc), crypto: keyring, chats: makeNativeDisk(Javc, 'chats') }); // chats are encrypted (seal.js)
const chats = makeChats(seal.io);
chats.upgrade().catch((e) => console.error('Could not encrypt the saved chats:', e)); // seals chats saved before encryption

// MCP: no local (command) servers on a phone, so those report 'desktop-only'; url servers go through nativeFetch, which has no CORS
const hub = Mcp.makeHub({ fetchFn: nativeFetch, auth: { get: (name) => store.mcpTokens(name), save: (name, tokens) => store.saveMcpTokens(name, tokens) } });
// Sign-in: the browser comes back to the app through this address (an intent filter in AndroidManifest.xml), which Capacitor reports as appUrlOpen
const REDIRECT = 'io.github.thedwz.javcchatbot:/oauth';
let waiting = null; // the sign-in waiting for the browser; a newer one replaces it, since every sign-in shares the address
App.addListener('appUrlOpen', ({ url }) => { if (url.startsWith(REDIRECT)) waiting?.resolve(url); });
const signInWays = {
  openUrl: (url) => Javc.openUrl({ url }),
  async listen() {
    waiting?.reject(new Error('Another sign-in started, so this one stopped.'));
    let me = null;
    const next = new Promise((resolve, reject) => { me = waiting = { resolve, reject }; });
    next.catch(() => {}); // it may be replaced before the sign-in waits on it
    return { uri: REDIRECT, next, close: () => { if (waiting === me) waiting = null; } };
  },
};
const mcpReady = async () => { hub.configure(await store.mcpServers()); return hub; };
/** @type {(info: object) => Promise<string>} */
let approve = async () => 'deny'; // until the page registers its dialog

const fileTokens = new Map(); // see Lib.richFiles
/** A file attach_file names by URL; a phone has no paths to read. The user approved it first. */
const readFile = async (ref, signal) => {
  if (!ref.url) throw new Error('Files on a computer can only be attached in the desktop app.');
  return Mcp.fetchFile(ref.url, nativeFetch, signal);
};

let current = null; // the reply in progress; the page runs one at a time and locks everything else meanwhile
let pdfParse = null;
const asset = (p) => new URL(p, location.href).href;
/** pdf-parse's browser build, loaded the first time a PDF is attached (and again if that load failed). */
const loadPdfParse = () => (pdfParse ??= import(asset('vendor/pdf-parse.es.js')).then(
  (m) => { m.PDFParse.setWorker(asset('vendor/pdf.worker.mjs')); return m.PDFParse; },
  (e) => { pdfParse = null; throw e; },
));
let makeLibs = null;
/** The libraries create_file uses: www/vendor/make-libs.js (mobile/make-libs.mjs), loaded with the first file (and again if that load failed). */
const loadMake = () => (makeLibs ??= import(asset('vendor/make-libs.js')).then((m) => m.default, (e) => { makeLibs = null; throw e; }));
/** Deletes the files the model created that are older than Settings → Tools allows; a failure only goes to the log. */
async function expireMade() {
  try { await chats.expire((await store.filesForReply()).keepDays); } catch (e) { console.error('Could not delete old created files:', e); }
}
setInterval(expireMade, 3600_000); // and once at the first getSettings, and when the setting changes

window.api = {
  getSettings: async () => {
    const st = await store.get();
    await chats.list().catch(() => {}); // loads the chat key (if there are chats) and sets aside ones it can't decrypt, for their notices; the page reports list errors
    expireMade();
    return { ...st, notice: [store.takeNotice(), seal.takeNotice()].filter(Boolean).join(' ') };
  },
  patchSettings: async (patch) => { const st = await store.patch(patch); if (patch?.files) expireMade(); return st; },
  saveProfile: (p) => store.saveProfile(p),
  savePersona: (p) => store.savePersona(p),
  deletePersona: (id) => store.deletePersona(id),
  deleteProfile: (id) => store.deleteProfile(id),
  activateProfile: (id) => store.activate(id),
  getProfileKey: (id) => store.key(id),
  saveSearch: (p) => store.saveSearch(p),
  getSearchKey: () => store.searchKey(),
  /**
   * Stores a rich block's page in the plugin and returns the sandbox-host URL it's served from. The files of its reply
   * (`files`) that it names go to the plugin too, which serves them under a token only this page knows (Lib.richFiles).
   */
  async createSandbox(html, color, scheme, flags, files) {
    if (typeof html !== 'string' || html.length > Lib.RICH_MAX) throw new Error('This content is too large to display');
    const use = Lib.richFiles(html, files, fileTokens), links = {};
    if (fileTokens.size > 300) fileTokens.delete(fileTokens.keys().next().value); // the plugin forgets old files anyway
    for (const [name, f] of Object.entries(use?.files ?? {})) {
      const key = `${use.token}/${name}`;
      try { // the plugin keeps the most recent 150 MB; a file it still holds isn't read and sent again
        let r = await Javc.sandboxFile({ key });
        if (!r.held) r = await Javc.sandboxFile({ key, mime: f.mime, data: await chats.readFile(f.ref) });
        links[name] = r.url;
      } catch (e) { console.error('Could not load an attached file for a rich reply:', e); } // the page still shows, without it
    }
    const { doc, csp } = await Lib.richDoc(html, color, scheme, flags, links); // csp switches CSS/JavaScript off, as on the desktop
    return (await Javc.sandboxCreate({ html: doc, csp })).url;
  },
  listModels: async (profileId) => { const s = await store.load({ profileId }); return api.listModelsDetailed(s.endpoint, s.key, nativeFetch); },
  /** Streams a reply: onDelta gets {reasoning, content} pieces as they arrive; resolves to the full reply. `opts.summary` ({profileId, model}) writes a summary instead. */
  async chat(messages, onDelta, opts) {
    const ctl = (current = new AbortController());
    try {
      const sum = opts?.summary, s = await store.load(sum ? { profileId: sum.profileId } : { search: !!opts?.search });
      // Linkup goes through nativeFetch too
      const { model, extra, search, mcp, files } = api.requestArgs(s, opts);
      const delta = (/** @type {object} */ d) => onDelta?.(d);
      const tools = mcp || files ? await Mcp.replyTools(hub, store, { approve: (i) => approve(i), onDelta: delta, signal: ctl.signal, readFile, mcp, ...(files && { make: (a) => Make.makeFile(a, loadMake) }) }) : undefined;
      return await chats.keepFiles(await api.chatStream(s.endpoint, s.key, model, messages, extra, delta, nativeFetch, ctl.signal, search, tools));
    } finally { if (current === ctl) current = null; }
  },
  stopChat: async () => current?.abort(),
  listChats: () => chats.list(),
  chatsStatus: async () => ({ ...(await seal.status()), device: true }),
  resetChatKey: () => seal.reset(),
  /** Writes every chat to a file the user picks with the system's save screen (JSON, text, or JSON locked with a passphrase). */
  exportChats: async (opts) => {
    const { chats: all, missed, files, filesMissed } = await Backup.collect(chats, opts?.format !== 'txt' || !!opts?.passphrase); // a text export lists files by name only
    const file = await Backup.buildExport(all, { format: opts?.format, passphrase: opts?.passphrase, names: Backup.personaNames((await store.get()).personas), files });
    const { saved } = await Javc.saveFile({ name: file.name, mime: file.mime, data: file.text });
    return saved ? { saved: true, count: all.length, missed, filesMissed } : { saved: false };
  },
  importChats: async (text, passphrase) => Backup.mergeInto(chats, await Backup.readExport(text, passphrase)),
  loadChat: (id) => chats.load(id),
  saveChat: (chat) => chats.save(chat),
  deleteChat: (id) => chats.remove(id),
  readAttachment: (ref) => chats.readFile(ref),
  /** Where the page finds the libraries the file dialog's previews load (renderer.js LIBS): the copies in www/vendor. */
  libs: { jszip: 'vendor/jszip.min.js', pdf: 'vendor/pdf-parse.es.js', pdfWorker: 'vendor/pdf.worker.mjs' },
  /** Saves a file the model attached with the system's save screen; resolves {saved}. */
  saveAttachment: async (ref, name, mime) => {
    const { saved } = await Javc.saveFile({ name: Mcp.cleanName(name, 'file'), mime: String(mime || 'application/octet-stream'), data: await chats.readFile(ref), base64: true });
    return { saved };
  },
  /** A PDF's text, with the same pdf-parse as the desktop (its browser build); the text never leaves the phone. */
  async extractPdf(buf) {
    const PDFParse = await loadPdfParse();
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try { return (await parser.getText()).text; }
    finally { await parser.destroy(); }
  },
  copyText: (text) => Javc.copyText({ text }),
  getMcpConfig: () => store.mcpConfig(),
  saveMcp: async (p) => { const v = await store.saveMcp(p); await mcpReady(); return v; },
  mcpStatus: async () => (await mcpReady()).status(),
  reloadMcp: async () => { await (await mcpReady()).reload(); return hub.status(); },
  mcpSignIn: async (name) => { await (await mcpReady()).signIn(name, signInWays); return hub.status(); },
  mcpSignOut: async (name) => { await (await mcpReady()).signOut(name); return hub.status(); },
  /** fn({server, tool, args}) resolves to 'once' | 'always' | 'deny' before a tool runs; anything else, or an error, denies. */
  onToolApproval: (fn) => { approve = async (info) => { try { const a = await fn(info); return ['once', 'always'].includes(a) ? a : 'deny'; } catch { return 'deny'; } }; },
};

// Back closes whatever is open (a dialog, a popup, the history…); with nothing open, the app goes to the background.
App.addListener('backButton', () => { if (!globalThis.closeTopLayer?.()) App.minimizeApp(); });
