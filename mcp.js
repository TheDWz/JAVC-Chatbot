// MCP (Model Context Protocol) client, tools only: the servers in a pasted Claude-style `mcpServers` config, and their tools
// offered to the model. Platform-neutral: the desktop passes `spawn` for local (command) servers; Android has none.
// Remote (url) servers speak Streamable HTTP through the `fetchFn` each platform passes in.
// shortcut: speaks revision 2025-11-25 with the initialize handshake; add server/discover and per-request _meta (2026-07-28) when a server needs them
const { version } = require('./package.json');

const PROTOCOL = '2025-11-25';
const OLDER = ['2025-06-18', '2025-03-26', '2024-11-05']; // tools/list and tools/call are the same in these
const CONNECT_MS = 60000; // the first `npx`/`uvx` run downloads the server
const LIST_MS = 30000;
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
      return new Promise((resolve, reject) => {
        const timer = ms ? setTimeout(() => { settle(id, (p) => p.reject(new Error(`No answer to ${method} after ${ms / 1000} s`))); }, ms) : null;
        const onAbort = () => {
          settle(id, (p) => p.reject(new Error('Stopped')));
          post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Stopped by the user' } }).catch(() => {});
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } });
        post({ jsonrpc: '2.0', id, method, ...(params && { params }) }, signal).catch((e) => settle(id, (p) => p.reject(signal?.aborted ? new Error('Stopped') : e)));
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
    out += d;
    for (let i; (i = out.indexOf('\n')) >= 0; ) {
      const line = out.slice(0, i).trim(); out = out.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; } // servers sometimes log to stdout; skip what isn't JSON
      onMessage(m);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  child.stdin.on('error', () => {}); // EPIPE once it died; 'close' below reports it
  child.on('error', (e) => onDead(new Error(e.code === 'ENOENT' ? `"${entry.command}" wasn't found. Is it installed?` : e.message)));
  child.on('close', (code, sig) => onDead(new Error(`The server stopped (${sig || 'exit code ' + code})${err.trim() ? ':\n' + lastLines(err) : ''}`)));
  const waitExit = (ms) => new Promise((r) => { const t = setTimeout(() => r(false), ms); exit.then(() => { clearTimeout(t); r(true); }); });
  return {
    send: (m) => { child.stdin.write(JSON.stringify(m) + '\n'); },
    /** The spec's order: close stdin (which also reaches a server that npx/uvx started), then SIGTERM, then SIGKILL. */
    async close() {
      if (exited || child.pid === undefined) return; // no pid: it never started
      try { child.stdin.end(); } catch {}
      if (await waitExit(2000)) return;
      child.kill('SIGTERM');
      if (!(await waitExit(2000))) child.kill('SIGKILL');
    },
  };
}

/**
 * Reads a text/event-stream body, handing each event's JSON to `onMessage`, until the stream ends or `doneId`'s answer
 * arrives. Resolves to {answered, lastId, retry}: the last event id and retry delay let the caller resume a stream the
 * server closed early.
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
  try {
    while (!done) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      for (let i; !done && (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        const field = (f) => (line.startsWith(f + ':') ? line.slice(f.length + 1).replace(/^ /, '') : null);
        if (!line) dispatch();
        else if (field('data') !== null) data.push(field('data'));
        else if (field('id') !== null) lastId = field('id');
        else if (/^\d+$/.test(field('retry') ?? '')) retry = +field('retry');
      }
    }
    if (!done) dispatch();
  } finally { reader.cancel().catch(() => {}); } // the answer is in: don't wait for a server that keeps the stream open
  return { answered: done, lastId, retry };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Stopped')); }, { once: true });
});

/**
 * A remote server over Streamable HTTP: each message is a POST, answered with JSON or an event stream. Keeps the
 * session id the server gives, and sends the negotiated protocol version once it's known.
 * A 401 throws an error with `auth: true` and the server's `resourceMetadata` URL; a 404 on an open session throws
 * one with `expired: true`, so the caller can start a new session.
 */
function httpTransport(entry, fetchFn, onMessage) {
  let session = '', proto = '';
  const host = new URL(entry.url).host;
  const headers = () => ({
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(proto && { 'MCP-Protocol-Version': proto }), ...(session && { 'Mcp-Session-Id': session }), ...entry.headers,
  });
  return {
    setVersion(v) { proto = v; },
    async send(m, signal) {
      let res;
      try { res = await fetchFn(entry.url, { method: 'POST', headers: headers(), body: JSON.stringify(m), signal }); }
      catch (e) { throw signal?.aborted ? new Error('Stopped') : new Error(`Couldn't reach ${host}: ${e.message}`, { cause: e }); }
      if (res.status === 401) {
        const meta = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') || '')?.[1] || '';
        res.body?.cancel().catch(() => {});
        throw Object.assign(new Error('This server needs you to sign in.'), { auth: true, resourceMetadata: meta });
      }
      if (res.status === 404 && session) { session = ''; res.body?.cancel().catch(() => {}); throw Object.assign(new Error('The server ended the session.'), { expired: true }); }
      if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const sid = res.headers.get('mcp-session-id'); if (sid) session = sid;
      if (m.method === undefined || m.id === undefined) { res.body?.cancel().catch(() => {}); return; } // a notification or our answer: 202, no body
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        let r = await readSse(res.body, onMessage, m.id);
        // The server may close the connection before answering and expect the client to resume from the last event id, after `retry` ms
        for (let tries = 0; !r.answered && r.lastId && tries < 5; tries++) {
          await sleep(Math.min(r.retry ?? 1000, 30000), signal);
          let g;
          try { g = await fetchFn(entry.url, { method: 'GET', headers: { ...headers(), Accept: 'text/event-stream', 'Last-Event-ID': r.lastId }, signal }); }
          catch (e) { throw signal?.aborted ? new Error('Stopped') : new Error(`Couldn't reach ${host}: ${e.message}`, { cause: e }); }
          if (!g.ok || !(g.headers.get('content-type') || '').includes('text/event-stream')) { g.body?.cancel().catch(() => {}); break; }
          const next = await readSse(g.body, onMessage, m.id);
          r = { answered: next.answered, lastId: next.lastId || r.lastId, retry: next.retry ?? r.retry };
        }
        if (!r.answered) throw new Error(`${host} closed the stream without answering`);
        return;
      }
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { throw new Error(`${host} didn't answer with JSON`); }
      for (const x of [].concat(j)) onMessage(x);
      if (![].concat(j).some((x) => isObj(x) && x.id === m.id)) throw new Error(`${host} answered without a reply to the request`);
    },
    async close() {
      if (!session) return;
      const h = headers(); session = '';
      try { (await fetchFn(entry.url, { method: 'DELETE', headers: h })).body?.cancel().catch(() => {}); } catch {} // the server may not support it
    },
  };
}

/** Starts a server and does the initialize handshake. Resolves to {request, close, version}. `started(transport)` gets
 * the transport as soon as it exists, so the server can be stopped before the handshake ends.
 * @param {{type: string, command?: string, args?: string[], env?: object}} entry
 * @param {{spawn?: Function, fetchFn?: Function, signal?: AbortSignal, started?: (t: {close: () => Promise<void>}) => void}} deps
 */
async function connect(entry, { spawn, fetchFn, signal, started }) {
  let r = null, deadErr = null;
  const onDead = (e) => { deadErr ||= e; r?.fail(e); };
  let t;
  if (entry.type === 'http') t = httpTransport(entry, fetchFn, (m) => r.receive(m));
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
 * @param {{spawn?: (command: string, args: string[], env: object) => any, fetchFn?: Function}} deps `fetchFn` is for url servers (fetch by default).
 */
function makeHub({ spawn, fetchFn = (url, opts) => fetch(url, opts) }) {
  let servers = {};
  const conns = new Map(); // name -> {key, conn: Promise<{conn, tools}>, stop: () => Promise<void>}

  /** Stops a server, even one still starting (its transport is closed right away, or as soon as it exists). */
  const drop = (name) => { const c = conns.get(name); conns.delete(name); return c ? c.stop() : Promise.resolve(); };
  /** The server's connection and tool list, started on first use; a failed start is forgotten so the next use tries again. */
  function open(name) {
    const entry = servers[name], key = JSON.stringify(entry);
    let c = conns.get(name);
    if (!c || c.key !== key) {
      if (c) drop(name);
      let transport = null, stopped = false;
      const started = (t) => { transport = t; if (stopped) t.close(); };
      c = {
        key,
        conn: connect(entry, { spawn, fetchFn, started }).then(async (conn) => {
          try { return { conn, tools: await listTools(conn) }; } catch (e) { await conn.close(); throw e; }
        }),
        stop: async () => { stopped = true; await transport?.close(); },
      };
      conns.set(name, c);
      const mine = c;
      c.conn.catch(() => { if (conns.get(name) === mine) conns.delete(name); });
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
        if (local(name) && !spawn) return { name, type, state: 'desktop-only', tools: 0, error: '' };
        try { return { name, type, state: 'ok', tools: (await open(name)).tools.length, error: '' }; }
        catch (e) { return { name, type, state: e.auth ? 'auth' : 'error', tools: 0, error: e.message }; }
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
      await Promise.all(Object.keys(servers).map(async (name) => {
        if (local(name) && !spawn) return;
        try { for (const t of (await until(open(name), signal)).tools) list.push({ server: name, tool: t.name, def: t }); }
        catch (e) { if (signal?.aborted) throw e; failed.push({ name, error: e.message }); } // Stop while a server starts: it keeps starting for next time
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
        /** Calls the tool; resolves to text for the model. */
        async run(n, args, signal) {
          const t = byName.get(n), call = async () => resultText(await (await until(open(t.server), signal)).conn.request('tools/call', { name: t.tool, arguments: args }, signal));
          try { return await call(); }
          catch (e) { if (!e.expired) throw e; await drop(t.server); return call(); } // the HTTP session ended: start a new one, once
        },
      };
    },
    /** Stops every server. */
    async closeAll() { await Promise.all([...conns.keys()].map(drop)); },
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
      if (!allowed(t.server, t.tool) && (await approve({ server: t.server, tool: t.tool, args })) === 'deny') return DECLINED;
      return set.run(name, args, signal);
    },
  };
}

module.exports = { parseConfig, makeHub, gated, resultText, toolNames, DECLINED };
