// MCP (Model Context Protocol) client, tools only: the servers in a pasted Claude-style `mcpServers` config, and their tools
// offered to the model. Platform-neutral: the desktop passes `spawn` for local (command) servers; Android has none.
// Remote (url) servers speak Streamable HTTP through the `fetchFn` each platform passes in.
// shortcut: speaks revision 2025-11-25 with the initialize handshake; add server/discover and per-request _meta (2026-07-28) when a server needs them
const { version } = require('./package.json');

const PROTOCOL = '2025-11-25';
const OLDER = ['2025-06-18', '2025-03-26', '2024-11-05']; // tools/list and tools/call are the same in these
const CONNECT_MS = 60000; // the first `npx`/`uvx` run downloads the server
const LIST_MS = 30000;
const OUT_MAX = 32 * 1024 * 1024; // shortcut: largest message a local server may send; raise it if a server's big results fail
const RESULT_MAX = 20000; // shortcut: characters of tool output the model gets; raise it if tool output comes back truncated
const DECLINED = 'The user declined this tool call.';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A server's entry, checked: {type:'stdio', command, args, env} or {type:'http', url, headers}. Errors name the server and field. */
function cleanEntry(name, e) {
  const bad = (msg) => new Error(`Server "${name}": ${msg}`);
  if (!name.trim()) throw new Error('A server needs a name');
  if (!isObj(e)) throw bad('must be an object like {"command": "…"}');
  const strMap = (v, field) => {
    if (v === undefined) return {};
    if (!isObj(v) || !Object.values(v).every((x) => typeof x === 'string')) throw bad(`"${field}" must be an object of text values`);
    return { ...v };
  };
  const type = e.type ?? (e.url !== undefined ? 'http' : 'stdio');
  if (type === 'sse') throw bad("the old SSE transport isn't supported. Use the server's Streamable HTTP URL (it often ends in /mcp) with \"type\": \"http\".");
  if (type === 'stdio') {
    if (typeof e.command !== 'string' || !e.command.trim()) throw bad('needs a "command"');
    const args = e.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw bad('"args" must be a list of text values');
    return { type: 'stdio', command: e.command.trim(), args: [...args], env: strMap(e.env, 'env') };
  }
  if (type === 'http' || type === 'streamable-http') {
    let u; try { u = new URL(e.url); } catch { throw bad('needs a valid "url"'); }
    if (!/^https?:$/.test(u.protocol)) throw bad('"url" must start with http:// or https://');
    return { type: 'http', url: u.href, headers: strMap(e.headers, 'headers') };
  }
  throw bad(`unknown "type" "${type}"`);
}

/** A name for a single pasted entry: the URL's host, or the package in the command line (npx -y @scope/pkg → pkg). */
function nameOf(e) {
  if (typeof e.url === 'string') { try { return new URL(e.url).hostname; } catch {} }
  const words = [e.command, ...(Array.isArray(e.args) ? e.args : [])].filter((a) => typeof a === 'string' && a && !a.startsWith('-'));
  return String(words.at(-1) || 'server').split(/[\\/]/).pop().replace(/@[^@]*$/, '') || 'server';
}

/**
 * Reads pasted config: {"mcpServers": {...}} as in Claude Desktop and Claude Code, a bare {name: entry}, or a single entry.
 * Returns {name: entry}; empty text is no servers. Throws a readable error for anything else.
 */
function parseConfig(text) {
  if (!String(text ?? '').trim()) return {};
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`That isn't valid JSON: ${e.message}`, { cause: e }); }
  if (!isObj(j)) throw new Error('Paste an object like {"mcpServers": {"name": {"command": "…"}}}');
  const map = 'mcpServers' in j ? j.mcpServers : (typeof j.command === 'string' || typeof j.url === 'string') ? { [nameOf(j)]: j } : j;
  if (!isObj(map)) throw new Error('"mcpServers" must be an object of servers');
  return Object.fromEntries(Object.entries(map).map(([name, e]) => [name, cleanEntry(name, e)]));
}

/**
 * JSON-RPC over a transport. `send(msg, signal)` writes one message (it may return a promise; a rejection fails that
 * request); feed incoming ones to `receive`, and a dead transport to `fail`. Requests from the server get "method not found", except ping.
 */
function rpc(send) {
  const post = (m, signal) => Promise.resolve().then(() => send(m, signal));
  const pending = new Map();
  let seq = 0, dead = null;
  const settle = (id, fn) => { const p = pending.get(id); if (p) { pending.delete(id); p.cleanup(); fn(p); } };
  return {
    /** @param {string} method @param {object} [params] @param {AbortSignal} [signal] @param {number} [ms] */
    request(method, params, signal, ms) {
      if (dead) return Promise.reject(dead);
      if (signal?.aborted) return Promise.reject(new Error('Stopped'));
      const id = ++seq;
      const late = new AbortController(); // a timeout also stops the transport's work for this request (an HTTP fetch or stream)
      const sig = signal ? AbortSignal.any([signal, late.signal]) : late.signal;
      return new Promise((resolve, reject) => {
        const timer = ms ? setTimeout(() => { settle(id, (p) => p.reject(new Error(`No answer to ${method} after ${ms / 1000} s`))); late.abort(); }, ms) : null;
        const onAbort = () => {
          settle(id, (p) => p.reject(new Error('Stopped')));
          post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Stopped by the user' } }).catch(() => {});
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } });
        post({ jsonrpc: '2.0', id, method, ...(params && { params }) }, sig).catch((e) => settle(id, (p) => p.reject(signal?.aborted ? new Error('Stopped') : e)));
      });
    },
    /** Resolves once it's sent (or failed: a notification's failure is not an error). */
    notify(method, params) { return dead ? Promise.resolve() : post({ jsonrpc: '2.0', method, ...(params && { params }) }).catch(() => {}); },
    receive(m) {
      if (!isObj(m)) return;
      if (m.method !== undefined) { // from the server
        if (m.id !== undefined) post(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }).catch(() => {});
        return;
      }
      if (m.error) settle(m.id, (p) => p.reject(new Error(m.error.message || `Error ${m.error.code}`)));
      else settle(m.id, (p) => p.resolve(m.result));
    },
    fail(err) { dead ||= err; for (const id of [...pending.keys()]) settle(id, (p) => p.reject(dead)); },
  };
}

/** `p`, unless `signal` aborts first; then it rejects with Stopped and `p` carries on by itself. */
const until = (p, signal) => (!signal ? p : new Promise((resolve, reject) => {
  const stop = () => reject(new Error('Stopped'));
  if (signal.aborted) return stop();
  signal.addEventListener('abort', stop, { once: true });
  p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
}));

const lastLines = (s) => s.trim().split('\n').slice(-6).join('\n');

/**
 * A local server: JSON-RPC as one line per message on its stdin and stdout. `spawn(command, args, env)` returns a
 * child process (or a promise of one). Messages go to `onMessage`; `onDead(error)` fires once when it stops.
 */
async function stdioTransport(spawn, entry, onMessage, onDead) {
  const child = await spawn(entry.command, entry.args, entry.env);
  let out = '', err = '', exited = false;
  const exit = new Promise((/** @type {(v?: unknown) => void} */ r) => child.once('exit', () => { exited = true; r(); }));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    let from = out.length; // only the new text can hold the next line break
    out += d;
    for (let i; (i = out.indexOf('\n', from)) >= 0; from = 0) {
      const line = out.slice(0, i).trim(); out = out.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; } // servers sometimes log to stdout; skip what isn't JSON
      onMessage(m);
    }
    if (out.length > OUT_MAX) { // cutting the buffer would break the line framing, so give up on the server
      out = '';
      onDead(new Error(`The server sent a message larger than ${OUT_MAX / 1024 / 1024} MB.`));
      close();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  child.stdin.on('error', () => {}); // EPIPE once it died; 'close' below reports it
  child.on('error', (e) => onDead(new Error(e.code === 'ENOENT' ? `"${entry.command}" wasn't found. Is it installed?` : e.message)));
  child.on('close', (code, sig) => onDead(new Error(`The server stopped (${sig || 'exit code ' + code})${err.trim() ? ':\n' + lastLines(err) : ''}`)));
  const waitExit = (ms) => new Promise((r) => { const t = setTimeout(() => r(false), ms); exit.then(() => { clearTimeout(t); r(true); }); });
  /** The spec's order: close stdin (which also reaches a server that npx/uvx started), then SIGTERM, then SIGKILL. */
  async function close() {
    if (exited || child.pid === undefined) return; // no pid: it never started
    try { child.stdin.end(); } catch {}
    if (await waitExit(2000)) return;
    child.kill('SIGTERM');
    if (!(await waitExit(2000))) child.kill('SIGKILL');
  }
  return { send: (m) => { child.stdin.write(JSON.stringify(m) + '\n'); }, close };
}

/**
 * Reads a text/event-stream body, handing each event's JSON to `onMessage`, until the stream ends or `doneId`'s answer
 * arrives. Resolves to {answered, lastId, retry, error}: the last event id and retry delay let the caller resume a stream
 * the server closed early, or that dropped (`error` is why).
 */
async function readSse(body, onMessage, doneId) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '', data = [], done = false, lastId = '', retry = null;
  const dispatch = () => {
    if (!data.length) return;
    let m; try { m = JSON.parse(data.join('\n')); } catch {}
    data = [];
    for (const x of [].concat(m ?? [])) { onMessage(x); if (isObj(x) && x.id === doneId && x.method === undefined) done = true; }
  };
  let error = null;
  try {
    while (!done) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { error = e; break; } // the connection dropped: the caller may resume
      if (chunk.done) break;
      let from = buf.length; // only the new text can hold the next line break
      buf += dec.decode(chunk.value, { stream: true });
      if (buf.length > OUT_MAX) throw new Error(`The server sent a message larger than ${OUT_MAX / 1024 / 1024} MB.`);
      for (let i; !done && (i = buf.indexOf('\n', from)) >= 0; from = 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        const field = (f) => (line.startsWith(f + ':') ? line.slice(f.length + 1).replace(/^ /, '') : null);
        if (!line) dispatch();
        else if (field('data') !== null) data.push(field('data'));
        else if (field('id') !== null) lastId = field('id');
        else if (/^\d+$/.test(field('retry') ?? '')) retry = +field('retry');
      }
    }
    if (!done && !error) dispatch();
  } finally { reader.cancel().catch(() => {}); } // the answer is in: don't wait for a server that keeps the stream open
  return { answered: done, lastId, retry, error };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(t); reject(new Error('Stopped')); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(undefined); }, ms);
  if (signal?.aborted) return stop();
  signal?.addEventListener('abort', stop, { once: true });
});

/**
 * A remote server over Streamable HTTP: each message is a POST, answered with JSON or an event stream. Keeps the
 * session id the server gives, and sends the negotiated protocol version once it's known.
 * With `token` ({get, refresh}, from a sign-in) it sends the access token, and on a 401 refreshes it once and tries again.
 * A 401 after that throws an error with `auth: true` and the server's `resourceMetadata` URL; a 404 on an open session
 * throws one with `expired: true`. Both also end the connection through `onDead`, so the next use starts a new one.
 * shortcut: the tool list is read once per connection (no notifications/tools/list_changed); Reload picks up new tools
 */
function httpTransport(entry, fetchFn, onMessage, onDead, token) {
  let session = '', proto = '', bearer = '';
  const host = new URL(entry.url).host, life = new AbortController(); // close() stops everything still in flight
  const headers = () => ({
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(proto && { 'MCP-Protocol-Version': proto }), ...(session && { 'Mcp-Session-Id': session }),
    ...(bearer && { Authorization: 'Bearer ' + bearer }), ...entry.headers,
  });
  const drain = (res) => { res.body?.cancel().catch(() => {}); };
  const dead = (e) => { onDead(e); return e; };
  /** fetch, stopped by `signal` or close(); a network error names the host. */
  async function req(opts, signal) {
    const sig = signal ? AbortSignal.any([signal, life.signal]) : life.signal;
    try { return await fetchFn(entry.url, { ...opts, signal: sig }); }
    catch (e) { throw sig.aborted ? new Error('Stopped') : new Error(`Couldn't reach ${host}: ${e.message}`, { cause: e }); }
  }
  return {
    setVersion(v) { proto = v; },
    async send(m, signal) {
      let res;
      for (let retried = false; ; retried = true) {
        if (token) bearer = await token.get();
        res = await req({ method: 'POST', headers: headers(), body: JSON.stringify(m) }, signal);
        if (res.status !== 401 || retried || !bearer || !(await token.refresh())) break;
        drain(res); // the token was refused: refreshed, so send it again
      }
      if (res.status === 401) {
        const meta = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') || '')?.[1] || '';
        drain(res);
        throw dead(Object.assign(new Error('This server needs you to sign in.'), { auth: true, resourceMetadata: meta }));
      }
      if (res.status === 404 && session) { session = ''; drain(res); throw dead(Object.assign(new Error('The server ended the session.'), { expired: true })); }
      if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const sid = res.headers.get('mcp-session-id'); if (sid) session = sid;
      if (m.method === undefined || m.id === undefined) { drain(res); return; } // a notification or our answer: 202, no body
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        let r = await readSse(res.body, onMessage, m.id);
        // The server may close the stream (or the connection may drop) before the answer; resume from the last event id after `retry` ms
        for (let tries = 0; !r.answered && r.lastId && !signal?.aborted && !life.signal.aborted && tries < 5; tries++) {
          await sleep(Math.min(r.retry ?? 1000, 30000), signal);
          const g = await req({ method: 'GET', headers: { ...headers(), Accept: 'text/event-stream', 'Last-Event-ID': r.lastId } }, signal);
          if (!g.ok || !(g.headers.get('content-type') || '').includes('text/event-stream')) { drain(g); break; }
          const next = await readSse(g.body, onMessage, m.id);
          r = { answered: next.answered, lastId: next.lastId || r.lastId, retry: next.retry ?? r.retry, error: next.error };
        }
        if (r.answered) return;
        if (signal?.aborted || life.signal.aborted) throw new Error('Stopped');
        throw new Error(r.error ? `Couldn't reach ${host}: ${r.error.message}` : `${host} closed the stream without answering`);
      }
      // shortcut: a JSON answer is read whole, unlike streams (capped at OUT_MAX); cap it too if a server sends huge ones
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { throw new Error(`${host} didn't answer with JSON`); }
      for (const x of [].concat(j)) onMessage(x);
      if (![].concat(j).some((x) => isObj(x) && x.id === m.id)) throw new Error(`${host} answered without a reply to the request`);
    },
    async close() {
      life.abort();
      if (!session) return;
      const h = headers(); session = '';
      // the server may not support it, or be unreachable: don't hold up Reload or quitting for long
      try { drain(await fetchFn(entry.url, { method: 'DELETE', headers: h, signal: AbortSignal.timeout(5000) })); } catch {}
    },
  };
}

/** Starts a server and does the initialize handshake. Resolves to {request, close, version}. `started(transport)` gets
 * the transport as soon as it exists, so the server can be stopped before the handshake ends; `ended()` fires when it stops.
 * @param {{type: string, command?: string, args?: string[], env?: object}} entry
 * @param {{spawn?: Function, fetchFn?: Function, token?: {get(): Promise<string>, refresh(): Promise<boolean>}, signal?: AbortSignal, started?: (t: {close: () => Promise<void>}) => void, ended?: () => void}} deps
 */
async function connect(entry, { spawn, fetchFn, token, signal, started, ended }) {
  let r = null, deadErr = null;
  const onDead = (e) => { deadErr ||= e; r?.fail(e); ended?.(); };
  let t;
  if (entry.type === 'http') t = httpTransport(entry, fetchFn, (m) => r.receive(m), onDead, token);
  else if (!spawn) throw new Error('Only the desktop app can run local servers.');
  else t = await stdioTransport(spawn, entry, (m) => r.receive(m), onDead);
  r = rpc(t.send);
  started?.(t);
  if (deadErr) r.fail(deadErr);
  try {
    const init = await r.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'JAVC Chatbot', version } }, signal, CONNECT_MS);
    if (![PROTOCOL, ...OLDER].includes(init?.protocolVersion)) throw new Error(`The server speaks MCP ${init?.protocolVersion}, which this app doesn't support yet.`);
    t.setVersion?.(init.protocolVersion);
    await r.notify('notifications/initialized'); // before any other request, which over HTTP could otherwise overtake it
    return { request: r.request, close: t.close, version: init.protocolVersion };
  } catch (e) { await t.close(); throw e; }
}

// ---- Sign-in (OAuth 2.1 as the MCP spec asks: discovery, dynamic client registration, PKCE, resource indicators) ----

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (text) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
/** Whether sign-in details for `resource` cover server `url`: the same origin, and the url's path at or under the resource's (the MCP SDK's rule). */
const covers = (resource, url) => {
  try {
    const r = new URL(resource), u = new URL(url), dir = (p) => (p.endsWith('/') ? p : p + '/');
    return r.origin === u.origin && dir(u.pathname).startsWith(dir(r.pathname));
  } catch { return false; }
};

/** GETs JSON, or null when the address doesn't have it (404 and the like). */
async function getJson(fetchFn, url) {
  let res;
  try { res = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } }); }
  catch (e) { throw new Error(`Couldn't reach ${new URL(url).host}: ${e.message}`, { cause: e }); }
  if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
  try { return JSON.parse(await res.text()); } catch { return null; }
}

/** POSTs a form or JSON and returns the JSON answer; an OAuth error answer throws its description. */
async function postFor(fetchFn, url, body, json = false) {
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString() });
  } catch (e) { throw new Error(`Couldn't reach ${new URL(url).host}: ${e.message}`, { cause: e }); }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${new URL(url).host} said: ${j?.error_description || j?.error || `HTTP ${res.status} ${text.slice(0, 200)}`}`);
  if (!isObj(j)) throw new Error(`${new URL(url).host} didn't answer with JSON`);
  return j;
}

/** Where to find a server's OAuth details: the 401's resource_metadata, else the well-known addresses. */
async function discover(entry, fetchFn) {
  const u = new URL(entry.url), path = u.pathname.replace(/\/$/, '');
  let hinted = '', scope = '';
  try { // an unauthenticated request: its 401 says where the metadata is
    const res = await fetchFn(entry.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...entry.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'JAVC Chatbot', version } } }) });
    const h = res.headers.get('www-authenticate') || '';
    hinted = /resource_metadata="([^"]+)"/.exec(h)?.[1] || ''; scope = /scope="([^"]+)"/.exec(h)?.[1] || '';
    res.body?.cancel().catch(() => {});
  } catch {}
  let prm = null;
  for (const url of [hinted, path && `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) {
    if ((prm = await getJson(fetchFn, url))) break;
  }
  if (!prm || !Array.isArray(prm.authorization_servers) || !prm.authorization_servers.length) throw new Error("This server doesn't say how to sign in (no OAuth protected-resource metadata).");
  if (!covers(prm.resource, entry.url)) throw new Error(`The server's sign-in details are for ${prm.resource}, not ${entry.url}, so the app won't use them.`); // RFC 9728
  const as = new URL(prm.authorization_servers[0]), asPath = as.pathname.replace(/\/$/, '');
  const tries = asPath
    ? [`${as.origin}/.well-known/oauth-authorization-server${asPath}`, `${as.origin}/.well-known/openid-configuration${asPath}`, `${as.origin}${asPath}/.well-known/openid-configuration`]
    : [`${as.origin}/.well-known/oauth-authorization-server`, `${as.origin}/.well-known/openid-configuration`];
  let meta = null;
  for (const url of tries) if ((meta = await getJson(fetchFn, url))) break;
  if (!meta?.authorization_endpoint || !meta.token_endpoint) throw new Error(`Couldn't read the sign-in server's details at ${as.origin}.`);
  if (!meta.code_challenge_methods_supported?.includes('S256')) throw new Error("The sign-in server doesn't support PKCE (S256), so the app won't sign in to it.");
  return { resource: prm.resource, scope: scope || (Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : ''), meta };
}

/**
 * Signs in to a url server and resolves to its tokens: {url, resource, issuer, tokenEndpoint, clientId, clientSecret?,
 * accessToken, refreshToken, expiresAt}. `listen()` starts catching the redirect and resolves to {uri, next, close}:
 * `next` resolves to the URL the browser was sent back to. `openUrl` shows the sign-in page in the browser.
 * shortcut: registers with dynamic client registration only; add client ID metadata documents or a pre-registered id when a server offers no registration_endpoint
 * @param {{url: string, headers?: object}} entry
 * @param {{fetchFn: Function, openUrl: (url: string) => any, listen: () => Promise<{uri: string, next: Promise<string>, close: () => void}>, timeoutMs?: number}} deps
 */
async function signIn(entry, { fetchFn, openUrl, listen, timeoutMs = 300000 }) {
  const { resource, scope, meta } = await discover(entry, fetchFn);
  if (!meta.registration_endpoint) throw new Error("The sign-in server doesn't let new apps register, so this app can't sign in to it yet.");
  const catcher = await listen();
  try {
    const reg = await postFor(fetchFn, meta.registration_endpoint, {
      client_name: 'JAVC Chatbot', redirect_uris: [catcher.uri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', application_type: 'native', ...(scope && { scope }),
    }, true);
    if (typeof reg.client_id !== 'string' || !reg.client_id) throw new Error('The sign-in server registered the app without a client id.');
    const verifier = randomText(), state = randomText();
    const auth = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: catcher.uri, code_challenge: await sha256(verifier),
      code_challenge_method: 'S256', state, resource, ...(scope && { scope }) })) auth.searchParams.set(k, v);
    await openUrl(auth.href);
    let timer;
    const back = new URL(await Promise.race([catcher.next, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Sign-in timed out. Try again.')), timeoutMs); })]).finally(() => clearTimeout(timer)));
    const q = back.searchParams;
    if (q.get('state') !== state) throw new Error("The sign-in answer didn't match this sign-in, so it was ignored.");
    if ((q.has('iss') || meta.authorization_response_iss_parameter_supported) && q.get('iss') !== meta.issuer) throw new Error('The sign-in answer came from a different server than expected, so it was ignored.'); // RFC 9207
    if (q.get('error')) throw new Error('Sign-in was refused: ' + (q.get('error_description') || q.get('error')));
    if (!q.get('code')) throw new Error('The sign-in answer had no code.');
    const tok = await postFor(fetchFn, meta.token_endpoint, { grant_type: 'authorization_code', code: q.get('code'), redirect_uri: catcher.uri, client_id: reg.client_id,
      code_verifier: verifier, resource, ...(reg.client_secret && { client_secret: reg.client_secret }) });
    return tokensFrom(tok, { url: entry.url, resource, issuer: meta.issuer || '', tokenEndpoint: meta.token_endpoint, clientId: reg.client_id, ...(reg.client_secret && { clientSecret: reg.client_secret }) });
  } finally { catcher.close(); }
}

/** @typedef {{url: string, resource: string, issuer: string, tokenEndpoint: string, clientId: string, clientSecret?: string, accessToken: string, refreshToken: string, expiresAt: number}} Tokens */

/** A token answer as what's saved. @returns {Tokens} */
function tokensFrom(tok, base) {
  if (typeof tok.access_token !== 'string' || !tok.access_token) throw new Error('The sign-in server gave no access token.');
  return { ...base, accessToken: tok.access_token, refreshToken: typeof tok.refresh_token === 'string' ? tok.refresh_token : base.refreshToken || '',
    expiresAt: Number.isFinite(tok.expires_in) ? Date.now() + tok.expires_in * 1000 : 0 };
}

/** New tokens from a refresh token; throws when the server refuses. */
async function refreshTokens(t, fetchFn) {
  const tok = await postFor(fetchFn, t.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId, resource: t.resource,
    ...(t.clientSecret && { client_secret: t.clientSecret }) });
  return tokensFrom(tok, t);
}

/** All of a server's tools, following nextCursor. */
async function listTools(conn, signal) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await conn.request('tools/list', cursor ? { cursor } : {}, signal, LIST_MS);
    tools.push(...(Array.isArray(res?.tools) ? res.tools.filter((t) => t && typeof t.name === 'string') : []));
    if (!(cursor = res?.nextCursor)) break;
  }
  return tools;
}

/** A tools/call result as text for the model: text parts joined, embedded text resources inlined, other media noted. */
function resultText(res) {
  const parts = (Array.isArray(res?.content) ? res.content : []).map((c) => {
    if (c?.type === 'text') return String(c.text ?? '');
    if (c?.type === 'resource' && typeof c.resource?.text === 'string') return c.resource.text;
    if (c?.type === 'resource_link') return `[${c.name || 'resource'}: ${c.uri}]`;
    return `[${c?.type || 'content'} omitted]`;
  });
  let text = parts.join('\n');
  if (!text.trim() && res?.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
  if (res?.isError) text = 'Tool error: ' + (text || 'unknown error');
  return text.length > RESULT_MAX ? text.slice(0, RESULT_MAX) + `\n[cut off after ${RESULT_MAX} characters]` : text || '(no output)';
}

/** Function names for the model: mcp__server__tool in [a-zA-Z0-9_-], at most 64 characters, unique. */
function toolNames(list) {
  const used = new Set();
  return list.map(({ server, tool }) => {
    const clean = (s) => s.replace(/[^a-zA-Z0-9_-]+/g, '_');
    let base = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64), name = base;
    for (let i = 2; used.has(name); i++) name = base.slice(0, 64 - String(i).length - 1) + '_' + i;
    used.add(name); return name;
  });
}

/**
 * The servers, connected lazily and kept running. `spawn` is the desktop's; without it local servers report 'desktop-only'.
 * @param {{spawn?: (command: string, args: string[], env: object) => any, fetchFn?: Function, auth?: {get(name: string): Promise<Tokens|null>, save(name: string, tokens: Tokens|null): Promise<void>}}} deps
 *   `fetchFn` is for url servers (fetch by default). `auth` keeps their sign-in tokens.
 */
function makeHub({ spawn, fetchFn = (url, opts) => fetch(url, opts), auth }) {
  let servers = {};
  /** A url server's saved tokens, or null; ones saved for another address don't count. */
  const tokensOf = async (name) => { const t = await auth?.get(name); return t && t.url === servers[name]?.url ? t : null; };
  /** {get, refresh} for a server's access token: refreshed when it's about to expire, or when the server refuses it (one refresh at a time). */
  function tokenFor(name) {
    let busy = null;
    const refresh = () => (busy ??= (async () => {
      try {
        const t = await tokensOf(name);
        if (!t?.refreshToken) return null;
        const next = await refreshTokens(t, fetchFn).catch(() => null);
        if (next) await auth.save(name, next);
        return next;
      } finally { busy = null; }
    })());
    return {
      async get() {
        const t = await tokensOf(name);
        if (t?.expiresAt && t.expiresAt < Date.now() + 60000 && t.refreshToken) return (await refresh())?.accessToken || '';
        return t?.accessToken || '';
      },
      refresh: async () => !!(await refresh()),
    };
  }
  const conns = new Map(); // name -> {key, conn: Promise<{conn, tools}>, stop: () => Promise<void>}

  /** Stops a server, even one still starting (its transport is closed right away, or as soon as it exists). */
  const drop = (name) => { const c = conns.get(name); conns.delete(name); return c ? c.stop() : Promise.resolve(); };
  /**
   * The server's connection and tool list, started on first use. A failed start, or a server that stops, is forgotten so
   * the next use starts it again.
   * shortcut: a server that hangs at startup is waited for (up to CONNECT_MS) on every reply; remember timed-out starts until Reload if that bites
   */
  function open(name) {
    const entry = servers[name], key = JSON.stringify(entry);
    let c = conns.get(name);
    if (!c || c.key !== key) {
      if (c) drop(name);
      let transport = null, stopped = false, mine = null;
      const started = (t) => { transport = t; if (stopped) t.close(); };
      const forget = () => { if (conns.get(name) === mine) conns.delete(name); };
      mine = c = {
        key,
        conn: connect(entry, { spawn, fetchFn, token: entry.type === 'http' && auth ? tokenFor(name) : undefined, started, ended: forget }).then(async (conn) => {
          try { return { conn, tools: await listTools(conn) }; } catch (e) { await conn.close(); throw e; }
        }),
        stop: async () => { stopped = true; await transport?.close(); },
      };
      conns.set(name, c);
      c.conn.catch(forget);
    }
    return c.conn;
  }
  const local = (name) => servers[name].type === 'stdio';

  return {
    /** Sets the servers ({name: entry} from parseConfig); running ones that changed or are gone are stopped. */
    configure(next) {
      servers = next || {};
      for (const [name, c] of [...conns]) if (!servers[name] || c.key !== JSON.stringify(servers[name])) drop(name);
    },
    /** Every server's state, starting any that aren't running: [{name, type, state: ok|error|auth|desktop-only, tools, error}]. */
    async status() {
      return Promise.all(Object.keys(servers).map(async (name) => {
        const type = servers[name].type;
        if (local(name) && !spawn) return { name, type, state: 'desktop-only', tools: 0, error: '', signedIn: false };
        const signedIn = type === 'http' && !!(await tokensOf(name));
        try { return { name, type, state: 'ok', tools: (await open(name)).tools.length, error: '', signedIn }; }
        catch (e) { return { name, type, state: e.auth ? 'auth' : 'error', tools: 0, error: e.message, signedIn }; }
      }));
    },
    /** Restarts every server (the Reload button). */
    async reload() { await Promise.all([...conns.keys()].map(drop)); },
    /**
     * The tools of every server that starts, for one reply: {defs, has, label, info, run, failed}. Servers that fail are
     * left out and listed in `failed` ({name, error}). Rejects with Stopped if `signal` aborts while servers start.
     * @param {AbortSignal} [signal]
     */
    async tools(signal) {
      const failed = [], list = [];
      const keys = Object.fromEntries(Object.entries(servers).map(([name, e]) => [name, JSON.stringify(e)]));
      await Promise.all(Object.keys(servers).map(async (name) => {
        if (local(name) && !spawn) return;
        try { for (const t of (await until(open(name), signal)).tools) list.push({ server: name, tool: t.name, def: t }); }
        catch (e) { if (signal?.aborted) throw e; failed.push({ name, error: e.message, auth: !!e.auth }); } // Stop while a server starts: it keeps starting for next time
      }));
      list.sort((a, b) => (a.server + '\0' + a.tool < b.server + '\0' + b.tool ? -1 : 1)); // the same order every time
      const byName = new Map(toolNames(list).map((n, i) => [n, list[i]]));
      const defs = [...byName].map(([n, { def }]) => {
        const schema = { ...(isObj(def.inputSchema) ? def.inputSchema : { type: 'object', properties: {} }) };
        delete schema.$schema; // some providers reject it
        return { type: 'function', function: { name: n, description: String(def.description || def.title || def.name).slice(0, 1024), parameters: schema } };
      });
      return {
        defs, failed,
        has: (n) => byName.has(n),
        label: (n) => { const t = byName.get(n); return t ? `${t.server} › ${t.tool}` : n; },
        info: (n) => byName.get(n),
        /** Calls the tool; resolves to text for the model. Refuses if the server was changed or removed since this list. */
        async run(n, args, signal) {
          const t = byName.get(n);
          const call = async () => {
            if (JSON.stringify(servers[t.server]) !== keys[t.server]) throw new Error(`The server "${t.server}" was changed or removed in Settings during this reply.`);
            return resultText(await (await until(open(t.server), signal)).conn.request('tools/call', { name: t.tool, arguments: args }, signal));
          };
          try { return await call(); }
          catch (e) { if (!e.expired) throw e; return call(); } // the HTTP session ended, and the hub forgot it: start a new one, once
        },
      };
    },
    /** Stops every server. */
    async closeAll() { await Promise.all([...conns.keys()].map(drop)); },
    /**
     * Signs in to url server `name` (see signIn for `ways`), saves the tokens and reconnects it.
     * @param {string} name
     * @param {{openUrl: (url: string) => any, listen: () => Promise<{uri: string, next: Promise<string>, close: () => void}>}} ways
     */
    async signIn(name, ways) {
      const entry = servers[name];
      if (entry?.type !== 'http') throw new Error('Only servers with a "url" have a sign-in.');
      await auth.save(name, await signIn(entry, { fetchFn, ...ways }));
      await drop(name);
    },
    /** Forgets a server's sign-in and reconnects it without one. */
    async signOut(name) { await auth.save(name, null); await drop(name); },
  };
}

/**
 * What chatStream gets: the tool set, with every call put to the user first. `approve({server, tool, args})` resolves to
 * 'once' | 'always' | 'deny'; tools the user always allows (`allowed(server, tool)`) skip it.
 * @param {Awaited<ReturnType<ReturnType<typeof makeHub>['tools']>>} set
 * @param {{allowed: (server: string, tool: string) => boolean, approve: (info: {server: string, tool: string, args: object}) => Promise<string>}} gate
 */
function gated(set, { allowed, approve }) {
  return {
    defs: set.defs, has: set.has, label: set.label,
    /** Runs model call `name` with its JSON `argsJson`; resolves to the text the model gets back. */
    async call(name, argsJson, signal) {
      const t = set.info(name);
      if (!t) return `Error: there is no tool called "${name}".`;
      let args = null; try { args = argsJson?.trim() ? JSON.parse(argsJson) : {}; } catch {}
      if (!isObj(args)) return 'Error: the arguments must be a JSON object.';
      if (!allowed(t.server, t.tool) && (await until(approve({ server: t.server, tool: t.tool, args }), signal)) === 'deny') return DECLINED;
      return set.run(name, args, signal);
    },
  };
}

/**
 * The MCP tools for one reply, each call put to the user through `approve`; "Always allow" is saved. Servers that don't
 * start, and a config that can't be read (a locked keyring), become notes in the reply instead of failing it.
 * @param {ReturnType<typeof makeHub>} hub
 * @param {{mcpForReply: () => Promise<{servers: object, allow: Record<string, string[]>}>, allowMcpTool: (server: string, tool: string) => Promise<unknown>}} store
 * @param {{approve: (info: {server: string, tool: string, args: object}) => Promise<string>, onDelta: (d: object) => void, signal?: AbortSignal}} reply
 */
async function replyTools(hub, store, { approve, onDelta, signal }) {
  const note = (text) => onDelta({ reasoning: text + '\n', content: '', note: true });
  let mcp;
  try { mcp = await store.mcpForReply(); } catch (e) { note(`MCP tools are off for this reply: ${e.message}`); return undefined; }
  hub.configure(mcp.servers);
  const set = await hub.tools(signal), allow = mcp.allow;
  for (const f of set.failed) note(f.auth ? `MCP server "${f.name}" needs you to sign in (Settings → Tools).` : `MCP server "${f.name}" didn't start: ${f.error}`);
  return gated(set, {
    allowed: (server, tool) => !!allow[server]?.includes(tool),
    approve: async (info) => {
      const a = await approve(info);
      if (a === 'always') { await store.allowMcpTool(info.server, info.tool); (allow[info.server] ||= []).push(info.tool); } // counts for the rest of this reply too
      return a;
    },
  });
}

module.exports = { parseConfig, makeHub, gated, replyTools, resultText, toolNames, signIn, DECLINED };
