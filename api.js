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

async function listModelsDetailed(endpoint, key, fetchFn) {
  const json = parseJson(await (await call(endpoint, key, '/models', null, fetchFn)).text());
  return (json.data || []).map((m) => ({ id: m.id, ...reasoningInfo(m) })).sort((a, b) => (a.id < b.id ? -1 : 1));
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

// Streams a chat completion. onDelta({reasoning, content}) fires as text arrives; resolves to the full {content, reasoning}.
// If the stream breaks or is stopped after some text arrived, the partial reply is returned with `error` or `stopped` set.
async function chatStream(endpoint, key, model, messages, extra = {}, onDelta = () => {}, fetchFn = fetch, signal) {
  const res = await call(endpoint, key, '/chat/completions', { model, messages, ...extra, stream: true }, fetchFn, signal);

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
    return out;
  }

  const handle = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    let j; try { j = JSON.parse(data); } catch { return false; }
    if (j.error) throw new Error('Stream error: ' + (j.error.message || JSON.stringify(j.error)));
    const d = j.choices?.[0]?.delta || {};
    emit(pickReasoning(d), d.content);
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
  return cut ? { ...out, ...cut } : out;
}

module.exports = { listModelsDetailed, reasoningParams, chatStream, thinkSplitter, THINKING_SWITCH };
