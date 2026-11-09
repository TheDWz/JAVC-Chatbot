// Minimal OpenAI-compatible client. fetchFn is injectable for tests.
async function call(endpoint, key, path, body, fetchFn = fetch, signal) {
  let res;
  try {
    res = await fetchFn(endpoint.replace(/\/+$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) { throw signal?.aborted ? new Error('Stopped') : e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error("The server didn't return JSON. Is the endpoint right?"); }
}

// efforts: array of levels the model reports, null = endpoint doesn't say, false = reports no reasoning.
// Only OpenRouter-style lists carry this metadata; plain OpenAI /models does not.
function reasoningInfo(m) {
  const r = m.reasoning;
  if (r && typeof r === 'object') {
    return { efforts: Array.isArray(r.supported_efforts) ? r.supported_efforts : null, mandatory: !!r.mandatory, default: r.default_effort, meta: true };
  }
  const sp = m.supported_parameters;
  if (Array.isArray(sp) && !sp.some((p) => p === 'reasoning' || p === 'reasoning_effort')) return { efforts: false, meta: false };
  return { efforts: null, meta: false };
}

// tools:false only when the list says so (OpenRouter-style supported_parameters without `tools`); plain /models says nothing.
const noTools = (m) => Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools');

// The model's context window in tokens, from whichever field the provider uses (OpenRouter, Venice, NanoGPT, others), or 0 when none says.
const ctxOf = (m) => [m.context_length, m.top_provider?.context_length, m.model_spec?.availableContextTokens, m.context_window, m.max_context_length, m.max_model_len]
  .find((v) => Number.isInteger(v) && v > 0) || 0;

async function listModelsDetailed(endpoint, key, fetchFn) {
  // NanoGPT only lists context lengths when asked; other servers never see the extra parameter
  const path = /nano-gpt\.com/i.test(endpoint) ? '/models?detailed=true' : '/models';
  const json = parseJson(await (await call(endpoint, key, path, null, fetchFn)).text());
  return (json.data || []).map((m) => ({ id: m.id, ...reasoningInfo(m), ...(noTools(m) && { tools: false }), ...(ctxOf(m) && { ctx: ctxOf(m) }) })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// DeepSeek, Z.ai (GLM) and Moonshot (Kimi) turn thinking off with thinking:{type:'disabled'}, not effort 'none'.
const THINKING_SWITCH = /deepseek\.com|api\.z\.ai|bigmodel\.cn|moonshot\.(ai|cn)/i;

// Which request shape to use. A gateway whose model list carries OpenRouter-style `reasoning` metadata (meta)
// is treated as OpenRouter-compatible, so custom gateway domains work; `format` overrides the guess.
function resolveFormat(format, endpoint, meta) {
  if (format && format !== 'auto') return format;
  if (meta || /openrouter\.ai/i.test(endpoint)) return 'openrouter';
  return THINKING_SWITCH.test(endpoint) ? 'thinking' : 'openai';
}

function reasoningParams(endpoint, effort, { format, meta } = {}) {
  if (!effort) return {};
  const f = resolveFormat(format, endpoint, meta);
  if (f === 'openrouter') return { reasoning: { effort } };
  if (f === 'thinking') {
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    // shortcut: Moonshot's thinking field isn't accepted by always-on models (k3), so only non-Moonshot gets an explicit enable; revisit if Kimi docs say otherwise
    return /moonshot/i.test(endpoint) ? { reasoning_effort: effort } : { reasoning_effort: effort, thinking: { type: 'enabled' } };
  }
  return { reasoning_effort: effort };
}

// Local R1-style models put reasoning in content as <think>…</think>. Only a block at the very start counts,
// so an answer that merely mentions "<think>" is left alone. Tags may be split across stream chunks.
function thinkSplitter() {
  let mode = 'start', buf = '';
  const OPEN = '<think>', CLOSE = '</think>';
  return (chunk, flush = false) => {
    buf += chunk;
    const out = { reasoning: '', content: '' };
    if (mode === 'start') {
      const t = buf.trimStart();
      if (t.startsWith(OPEN)) { mode = 'think'; buf = t.slice(OPEN.length); }
      else if (!flush && OPEN.startsWith(t)) return out; // could still become <think>, wait for more
      else mode = 'done';
    }
    if (mode === 'think') {
      const i = buf.indexOf(CLOSE);
      if (i >= 0) { out.reasoning = buf.slice(0, i); buf = buf.slice(i + CLOSE.length).replace(/^\s+/, ''); mode = 'done'; }
      else {
        let keep = 0; // hold back a possible partial </think> at the end
        if (!flush) for (let k = Math.min(CLOSE.length - 1, buf.length); k > 0; k--) if (CLOSE.startsWith(buf.slice(-k))) { keep = k; break; }
        out.reasoning = buf.slice(0, buf.length - keep); buf = buf.slice(buf.length - keep);
        return out;
      }
    }
    out.content = buf; buf = '';
    return out;
  };
}

const pickReasoning = (o) => (typeof o.reasoning_content === 'string' ? o.reasoning_content : typeof o.reasoning === 'string' ? o.reasoning : '');

// ---- Web search through Linkup (https://docs.linkup.so). The model asks for it with a web_search tool call. ----
const SEARCH_TOOL = { type: 'function', function: {
  name: 'web_search',
  description: 'Search the web for current information, recent events or facts you are unsure about. Returns titles, URLs and page excerpts.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'A natural-language search query' } }, required: ['query'] },
} };
const SEARCH_ROUNDS = 4; // Linkup requests (and tool rounds) per reply; after that the model must answer

async function linkupSearch(key, q, fetchFn = fetch, signal) {
  let res;
  try {
    res = await fetchFn('https://api.linkup.so/v1/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal,
      body: JSON.stringify({ q, depth: 'fast', outputType: 'searchResults', maxResults: 5 }),
    });
  } catch (e) { throw signal?.aborted ? new Error('Stopped') : e; }
  if (!res.ok) throw new Error(`Linkup HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let json; try { json = JSON.parse(await res.text()); } catch { throw new Error("Linkup didn't return JSON"); }
  const hits = (json.results || []).filter((r) => r.type === 'text' && r.content);
  // shortcut: 2000 characters per result keeps a search from flooding the context; raise it if answers come back too thin
  return hits.length ? hits.map((r, i) => `[${i + 1}] ${r.name}\n${r.url}\n${String(r.content).slice(0, 2000)}`).join('\n\n') : 'No results.';
}

// One streamed request. onDelta({reasoning, content}) fires as text arrives; resolves to the full {content, reasoning}.
// If the stream breaks or is stopped after some text arrived, the partial reply is returned with `error` or `stopped` set.
// Tool calls the model makes are pushed onto `calls` as {id, type, function:{name, arguments}}.
const NO_USAGE = new Set(); // endpoints that rejected stream_options, for as long as the app runs
async function streamOnce(endpoint, key, model, messages, extra, onDelta, fetchFn, signal, calls) {
  const req = (usage) => call(endpoint, key, '/chat/completions', { model, messages, ...extra, stream: true, ...(usage && { stream_options: { include_usage: true } }) }, fetchFn, signal);
  // include_usage gets token counts for Stats for nerds. Strict servers reject unknown fields without always naming them, so any
  // 400/422 is asked once more without it; the endpoint is remembered only when that works, so a real error never sticks.
  const res = await req(!NO_USAGE.has(endpoint)).catch(async (e) => {
    if (NO_USAGE.has(endpoint) || !/^HTTP (400|422):/.test(e.message)) throw e;
    const r = await req(false); NO_USAGE.add(endpoint); return r;
  });

  const out = { content: '', reasoning: '' };
  const split = thinkSplitter();
  const emit = (reasoning, content, flush = false) => {
    const t = split(content || '', flush);
    const d = { reasoning: (reasoning || '') + t.reasoning, content: t.content };
    if (!d.reasoning && !d.content) return;
    out.reasoning += d.reasoning; out.content += d.content; onDelta(d);
  };

  // Some servers ignore stream:true and answer with plain JSON.
  if ((res.headers?.get?.('content-type') || '').includes('application/json')) {
    const json = parseJson(await res.text());
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const m = json.choices?.[0]?.message || {};
    emit(pickReasoning(m), m.content || '', true);
    for (const c of m.tool_calls || []) calls.push({ id: c.id, type: 'function', function: { name: c.function?.name || '', arguments: c.function?.arguments || '' } });
    if (json.usage) out.usage = json.usage;
    return out;
  }

  const byIndex = []; // streamed tool calls arrive in pieces: id and name first, then the arguments text
  const handle = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    let j; try { j = JSON.parse(data); } catch { return false; }
    if (j.error) throw new Error('Stream error: ' + (j.error.message || JSON.stringify(j.error)));
    if (j.usage) out.usage = j.usage; // usually its own last chunk, with empty choices
    const d = j.choices?.[0]?.delta || {};
    emit(pickReasoning(d), d.content);
    for (const t of d.tool_calls || []) {
      const c = (byIndex[t.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (t.id) c.id = t.id;
      if (t.function?.name) c.function.name ||= t.function.name;
      c.function.arguments += t.function?.arguments || '';
    }
    return false;
  };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', finished = false, cut = null;
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while (!finished && (i = buf.indexOf('\n')) >= 0) { finished = handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (!finished && buf) handle(buf);
  } catch (e) {
    emit('', '', true);
    if (!out.content) throw signal?.aborted ? new Error('Stopped') : e; // nothing worth keeping
    cut = signal?.aborted ? { stopped: true } : { error: e.message };
  } finally { reader.cancel().catch(() => {}); }
  emit('', '', true); // flush anything the think splitter held back
  calls.push(...byIndex.filter(Boolean));
  return cut ? { ...out, ...cut } : out;
}

// Streams a reply. Without `search` ({key}) this is a single request. With it, the model may call web_search up to SEARCH_ROUNDS times
// before answering; text and reasoning from every round are joined. shortcut: the tool exchange stays inside this call and isn't saved
// with the chat, so later turns see only the final answer, not the raw search results.
async function chatStream(endpoint, key, model, messages, extra = {}, onDelta = () => {}, fetchFn = fetch, signal, search) {
  if (!search) return streamOnce(endpoint, key, model, messages, extra, onDelta, fetchFn, signal, []);
  const total = { content: '', reasoning: '' }, msgs = [...messages];
  let searches = 0; // Linkup requests so far in this reply, across rounds and parallel calls
  const add = (r, c) => { total.reasoning += r; total.content += c; };
  // every round is billed, so token counts add up; the last round's total is the context size
  const addUsage = (u) => {
    if (!u) return;
    const s = (total.usage ||= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    for (const k in s) s[k] += u[k] || 0;
    total.ctx = u.total_tokens;
  };
  for (let round = 0; ; round++) {
    const final = round >= SEARCH_ROUNDS, calls = [];
    // tools stay in the request on the last round (tool_choice none): some backends reject tool messages when no tools are defined
    const out = await streamOnce(endpoint, key, model, msgs, { ...extra, tools: [SEARCH_TOOL], tool_choice: final ? 'none' : 'auto' }, onDelta, fetchFn, signal, calls)
      .catch((e) => { if (total.content) return { content: '', reasoning: '', ...(signal?.aborted ? { stopped: true } : { error: e.message }) }; throw e; });
    add(out.reasoning, out.content); addUsage(out.usage);
    if (out.error || out.stopped || final || !calls.length) return { ...total, ...(out.error && { error: out.error }), ...(out.stopped && { stopped: true }) };
    // Thinking-mode providers (DeepSeek, GLM, Kimi) reject the follow-up with a 400 unless the round's reasoning goes back with its tool calls
    msgs.push({ role: 'assistant', content: out.content, tool_calls: calls, ...(THINKING_SWITCH.test(endpoint) && out.reasoning && { reasoning_content: out.reasoning }) });
    for (const c of calls) {
      let q = '', result;
      try { q = String(JSON.parse(c.function.arguments || '{}').query || '').trim(); } catch {}
      if (c.function.name !== 'web_search' || !q) result = 'Error: call web_search with a JSON object like {"query": "..."}.';
      else if (searches >= SEARCH_ROUNDS) result = 'Search limit reached. Answer with what you already have.';
      else {
        searches++;
        const note = `Searching the web: ${q}\n`;
        add(note, ''); onDelta({ reasoning: note, content: '', note: true }); // note: our own text, so stats don't time it as the model's
        try { result = await linkupSearch(search.key, q, fetchFn, signal); }
        catch (e) {
          if (signal?.aborted) { if (total.content) return { ...total, stopped: true }; throw new Error('Stopped'); }
          result = 'Search failed: ' + e.message; // the model can still answer without it
        }
      }
      msgs.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
}

module.exports = { listModelsDetailed, reasoningParams, chatStream, thinkSplitter, THINKING_SWITCH };
