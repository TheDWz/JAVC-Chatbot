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
  async createSandbox(html, color, scheme, flags) {
    if (typeof html !== 'string' || html.length > Lib.RICH_MAX) throw new Error('This content is too large to display');
    const { doc, csp } = await Lib.richDoc(html, color, scheme, flags); // csp switches CSS/JavaScript off, as on the desktop
    return (await Javc.sandboxCreate({ html: doc, csp })).url;
  },
  listModels: async () => { const s = await store.load(); return api.listModelsDetailed(s.endpoint, s.key, nativeFetch); },
  // Streams: onDelta gets {reasoning, content} pieces as they arrive; resolves to the full reply.
  async chat(messages, onDelta) {
    const ctl = (current = new AbortController());
    try {
      const s = await store.load();
      return await api.chatStream(s.endpoint, s.key, s.model, messages, api.reasoningParams(s.endpoint, s.effort, s), (d) => onDelta?.(d), nativeFetch, ctl.signal);
    } finally { if (current === ctl) current = null; }
  },
  stopChat: async () => current?.abort(),
  listChats: () => chats.list(),
  loadChat: (id) => chats.load(id),
  saveChat: (chat) => chats.save(chat),
  deleteChat: (id) => chats.remove(id),
  // Same pdf-parse as the desktop, in its browser build; the text never leaves the phone.
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
