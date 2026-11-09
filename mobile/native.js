// Android: the parts of window.api that need native code (android/app/src/main/java/.../JavcPlugin.java).
// The plugin is passed in, so the tests can run all of this with a fake one.

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
/** Base64 to bytes (atob gives one character per byte). */
const bytes = (b64) => { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
const NULL_BODY = new Set([204, 205, 304]);

/**
 * fetch() through the plugin: no CORS, http:// works for local servers, and the body streams in as it arrives.
 * @param {import('@capacitor/core').Plugin & {httpStart(req: object): Promise<{status: number, headers: object}>, httpAbort(req: object): Promise<void>}} plugin The native plugin: httpStart, httpAbort and "http" events ({id, type: data|end|error}).
 * @returns {(url: string, opts?: object) => Promise<Response>} A fetch that returns a real Response, so api.js uses it exactly like the desktop's.
 */
function makeNativeFetch(plugin) {
  const open = new Map(); // request id -> { controller, done }
  let seq = 0;
  const listening = plugin.addListener('http', (ev) => {
    const r = open.get(ev?.id); if (!r) return;
    if (ev.type === 'data') { try { r.controller.enqueue(bytes(ev.data)); } catch {} return; }
    open.delete(ev.id); r.done();
    try { if (ev.type === 'end') r.controller.close(); else r.controller.error(new TypeError(ev.message || 'Network error')); } catch {}
  });

  /** Starts the request; resolves once the status and headers arrive, and aborts through `opts.signal` like fetch. */
  return async function nativeFetch(url, /** @type {{signal?: AbortSignal, method?: string, headers?: object, body?: (string|null)}} */ opts = {}) {
    await listening;
    const signal = opts.signal;
    if (signal?.aborted) throw abortError();
    const id = `r${++seq}-${Math.random().toString(36).slice(2)}`;
    const cancel = () => { if (open.delete(id)) plugin.httpAbort({ id }).catch(() => {}); };
    let controller, onAbortStart;
    const body = new ReadableStream({ start(c) { controller = c; }, cancel });
    const abortedStart = new Promise((_, no) => { onAbortStart = no; });
    abortedStart.catch(() => {}); // only ever raced below
    const onAbort = () => {
      const r = open.get(id); cancel();
      try { r?.controller.error(abortError()); } catch {}
      onAbortStart(abortError());
    };
    const done = () => signal?.removeEventListener('abort', onAbort);
    open.set(id, { controller, done });
    signal?.addEventListener('abort', onAbort, { once: true });

    let head;
    try {
      head = await Promise.race([
        plugin.httpStart({ id, url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ?? null }),
        abortedStart,
      ]);
    } catch (e) {
      open.delete(id); done();
      if (signal?.aborted) throw abortError();
      throw new TypeError(e?.message || 'Network error', { cause: e }); // like fetch: a request that never got an answer is a TypeError
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(head.headers || {})) { try { headers.append(k, v); } catch {} } // skip anything Headers refuses
    if (NULL_BODY.has(head.status)) { open.delete(id); done(); return new Response(null, { status: head.status, headers }); } // no body to wait for; the request ends by itself
    return new Response(body, { status: head.status, headers });
  };
}

/**
 * The `io` that store.js and chats.js expect (see disk.js), inside the app's private files folder.
 * @param {{fsRead(p: object): Promise<{exists: boolean, text?: string}>, fsWrite(p: object): Promise<void>, fsRemove(p: object): Promise<void>, fsList(p: object): Promise<{names: string[]}>, fsRename(p: object): Promise<void>}} plugin The native plugin (fsRead, fsWrite, fsRemove, fsList, fsRename).
 * @param {string} [dir] A subfolder, such as 'chats'.
 */
function makeNativeDisk(plugin, dir = '') {
  /** The path of `name` inside `dir`; it must be a plain file name. */
  const at = (name) => {
    if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Invalid file name');
    return dir ? `${dir}/${name}` : name;
  };
  return {
    async read(name) { const r = await plugin.fsRead({ path: at(name) }); return r.exists ? r.text : null; },
    async write(name, text) { await plugin.fsWrite({ path: at(name), text }); },
    async remove(name) { await plugin.fsRemove({ path: at(name) }); },
    async list() { return (await plugin.fsList({ path: dir })).names; },
    async rename(from, to) { await plugin.fsRename({ from: at(from), to: at(to) }); },
  };
}

/**
 * The `crypto` that store.js expects. API keys are encrypted with a key that never leaves the Android Keystore. If the
 * Keystore doesn't work on this device, the self-test fails once and keys are kept in the app's private storage
 * instead (like Linux without a keyring).
 */
function makeNativeCrypto(plugin) {
  let ok = null;
  return {
    available: () => (ok ??= plugin.cryptoAvailable().then((r) => r.available === true, () => false)),
    enc: async (text) => (await plugin.encrypt({ text })).data,
    dec: async (data) => (await plugin.decrypt({ data })).text,
  };
}

module.exports = { makeNativeFetch, makeNativeDisk, makeNativeCrypto };
