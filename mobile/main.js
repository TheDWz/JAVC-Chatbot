// Android entry point, bundled into www/mobile.js by mobile/build.mjs. It gives the page the same window.api that
// preload.js and main.js give it on the desktop, built from the same store, chats and API client.
const { registerPlugin } = require('@capacitor/core');
const { App } = require('@capacitor/app');
const api = require('../api');
const Lib = require('../lib');
const makeStore = require('../store');
const makeChats = require('../chats');
const { makeNativeFetch, makeNativeDisk, makeNativeCrypto } = require('./native');

const Javc = registerPlugin('Javc');
const nativeFetch = makeNativeFetch(Javc);
const store = makeStore({ io: makeNativeDisk(Javc), crypto: makeNativeCrypto(Javc) });
const chats = makeChats(makeNativeDisk(Javc, 'chats'));

let current = null; // the reply in progress; the page runs one at a time and locks everything else meanwhile
let pdfParse = null;
const asset = (p) => new URL(p, location.href).href;
/** pdf-parse's browser build, loaded the first time a PDF is attached (and again if that load failed). */
const loadPdfParse = () => (pdfParse ??= import(asset('vendor/pdf-parse.es.js')).then(
  (m) => { m.PDFParse.setWorker(asset('vendor/pdf.worker.mjs')); return m.PDFParse; },
  (e) => { pdfParse = null; throw e; },
));

window.api = {
  getSettings: async () => { const st = await store.get(); return { ...st, notice: store.takeNotice() }; },
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
      // a summary goes to its own profile and model, with no reasoning level and no search; Linkup goes through nativeFetch too
      return await api.chatStream(s.endpoint, s.key, sum?.model || s.model, messages, sum ? {} : api.reasoningParams(s.endpoint, s.effort, s), (d) => onDelta?.(d), nativeFetch, ctl.signal, !sum && opts?.search ? s.search : null);
    } finally { if (current === ctl) current = null; }
  },
  stopChat: async () => current?.abort(),
  listChats: () => chats.list(),
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
};

// Back closes whatever is open (a dialog, the options panel, the history…); with nothing open, the app goes to the background.
App.addListener('backButton', () => { if (!globalThis.closeTopLayer?.()) App.minimizeApp(); });
