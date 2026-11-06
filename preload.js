const { contextBridge, ipcRenderer } = require('electron');

let currentId = null; // one reply at a time; the page locks everything else while it runs

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('settings:patch', patch),
  saveProfile: (p) => ipcRenderer.invoke('profiles:save', p),
  savePersona: (p) => ipcRenderer.invoke('personas:save', p),
  deletePersona: (id) => ipcRenderer.invoke('personas:delete', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  activateProfile: (id) => ipcRenderer.invoke('profiles:activate', id),
  saveSearch: (p) => ipcRenderer.invoke('search:save', p),
  getSearchKey: () => ipcRenderer.invoke('search:key'),
  getProfileKey: (id) => ipcRenderer.invoke('profiles:key', id),
  createSandbox: (html, color, scheme, flags) => ipcRenderer.invoke('sandbox:create', html, color, scheme, flags),
  listModels: () => ipcRenderer.invoke('models:list'),
  // Streams: onDelta gets {reasoning, content} pieces tagged with this request's id; resolves to the full reply.
  chat: async (messages, onDelta, opts) => {
    const id = (currentId = Date.now().toString(36) + Math.random().toString(36).slice(2));
    const listener = (_e, rid, d) => { if (rid === id) onDelta?.(d); };
    ipcRenderer.on('chat:delta', listener);
    try { return await ipcRenderer.invoke('chat:send', id, messages, opts); }
    finally { ipcRenderer.removeListener('chat:delta', listener); currentId = null; }
  },
  stopChat: () => currentId && ipcRenderer.invoke('chat:abort', currentId),
  listChats: () => ipcRenderer.invoke('chats:list'),
  loadChat: (id) => ipcRenderer.invoke('chats:load', id),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', chat),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),
  extractPdf: (buf) => ipcRenderer.invoke('pdf:extract', buf),
});
