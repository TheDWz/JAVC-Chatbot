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

let current = null; // the reply in progress; the page runs one at a time and locks everything else meanwhile
let pdfParse = null;
const asset = (p) => new URL(p, location.href).href;
/** pdf-parse's browser build, loaded the first time a PDF is attached (and again if that load failed). */
const loadPdfParse = () => (pdfParse ??= import(asset('vendor/pdf-parse.es.js')).then(
  (m) => { m.PDFParse.setWorker(asset('vendor/pdf.worker.mjs')); return m.PDFParse; },
  (e) => { pdfParse = null; throw e; },
));

window.api = {
  getSettings: async () => {
    const st = await store.get(); await seal.status(); // loading the chat key here gets any notice about it in too
    await chats.list().catch(() => {}); // and listing sets aside chats that can't be decrypted, for the same notice (the page reports list errors)
    return { ...st, notice: [store.takeNotice(), seal.takeNotice()].filter(Boolean).join(' ') };
  },
  patchSettings: (patch) => store.patch(patch),
  saveProfile: (p) => store.saveProfile(p),
  savePersona: (p) => store.savePersona(p),
  deletePersona: (id) => store.deletePersona(id),
  deleteProfile: (id) => store.deleteProfile(id),
  activateProfile: (id) => store.activate(id),
  getProfileKey: (id) => store.key(id),
  saveSearch: (p) => store.saveSearch(p),
  getSearchKey: () => store.searchKey(),
  /** Stores a rich block's page in the plugin and returns the sandbox-host URL it's served from. */
  async createSandbox(html, color, scheme, flags) {
    if (typeof html !== 'string' || html.length > Lib.RICH_MAX) throw new Error('This content is too large to display');
    const { doc, csp } = await Lib.richDoc(html, color, scheme, flags); // csp switches CSS/JavaScript off, as on the desktop
    return (await Javc.sandboxCreate({ html: doc, csp })).url;
  },
  listModels: async (profileId) => { const s = await store.load({ profileId }); return api.listModelsDetailed(s.endpoint, s.key, nativeFetch); },
  /** Streams a reply: onDelta gets {reasoning, content} pieces as they arrive; resolves to the full reply. `opts.summary` ({profileId, model}) writes a summary instead. */
  async chat(messages, onDelta, opts) {
    const ctl = (current = new AbortController());
    try {
      const sum = opts?.summary, s = await store.load(sum ? { profileId: sum.profileId } : { search: !!opts?.search });
      // Linkup goes through nativeFetch too
      const { model, extra, search, mcp } = api.requestArgs(s, opts);
      const delta = (/** @type {object} */ d) => onDelta?.(d);
      return await api.chatStream(s.endpoint, s.key, model, messages, extra, delta, nativeFetch, ctl.signal, search, mcp ? await Mcp.replyTools(hub, store, { approve: (i) => approve(i), onDelta: delta, signal: ctl.signal }) : undefined);
    } finally { if (current === ctl) current = null; }
  },
  stopChat: async () => current?.abort(),
  listChats: () => chats.list(),
  chatsStatus: async () => ({ ...(await seal.status()), device: true }),
  /** Writes every chat to a file the user picks with the system's save screen (JSON, text, or JSON locked with a passphrase). */
  exportChats: async (opts) => {
    const { chats: all, missed } = await Backup.collect(chats);
    const names = Object.fromEntries((await store.get()).personas.map((p) => [p.id, { user: p.user, bot: p.bot }]));
    const file = await Backup.buildExport(all, { format: opts?.format, passphrase: opts?.passphrase, names });
    const { saved } = await Javc.saveFile({ name: file.name, mime: file.mime, data: file.text });
    return saved ? { saved: true, count: all.length, missed } : { saved: false };
  },
  importChats: async (text, passphrase) => Backup.mergeInto(chats, await Backup.readExport(text, passphrase)),
  loadChat: (id) => chats.load(id),
  saveChat: (chat) => chats.save(chat),
  deleteChat: (id) => chats.remove(id),
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
