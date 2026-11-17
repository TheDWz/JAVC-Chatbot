// Anthropic's native Messages API through the official SDK. It speaks the same shapes as api.js's streamOnce
// (OpenAI-style messages and tools in, {content, reasoning, usage} out), so the tool loop in api.js stays one loop.
const { Anthropic, APIError, APIUserAbortError } = require('@anthropic-ai/sdk');

// shortcut: a host match only, so Anthropic-compatible proxies aren't detected; add a per-profile protocol switch if users need one
const isAnthropic = (endpoint) => { try { return /(^|\.)anthropic\.com$/i.test(new URL(endpoint).hostname); } catch { return false; } };

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const OUT_CAP = 64000; // max_tokens per reply; lower if the model's own cap is lower
// Models whose refusals can be retried on Anthropic's default fallback model, inside the same request.
const FALLBACKS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** @param {string} endpoint @param {string} key @param {any} [fetchFn] */
const client = (endpoint, key, fetchFn) => new Anthropic({
  apiKey: key || null, baseURL: endpoint.replace(/\/+$/, '').replace(/\/v1$/, ''), fetch: fetchFn, dangerouslyAllowBrowser: true, // phones run the core in the web view; the key still only lives in the host
});

// What a request needs to know about a model, from the Models API: {maxOut, adaptive, efforts}. Kept for as long as the app runs.
const INFO = new Map();
const infoOf = (m) => {
  const c = m.capabilities || {};
  const efforts = c.effort?.supported ? EFFORTS.filter((e) => c.effort[e]?.supported) : false;
  return { maxOut: m.max_tokens || OUT_CAP, adaptive: c.thinking ? !!c.thinking.types?.adaptive?.supported : true, efforts };
};

const httpError = (e, signal) => {
  if (signal?.aborted || e instanceof APIUserAbortError) return new Error('Stopped');
  if (e instanceof APIError && e.status) return new Error(`HTTP ${e.status}: ${String(e.error ? JSON.stringify(e.error) : e.message).slice(0, 500)}`);
  return e;
};

/** The model list in the shape api.js's listModelsDetailed returns. */
async function listModels(endpoint, key, fetchFn) {
  const out = [];
  try {
    for await (const m of client(endpoint, key, fetchFn).models.list({ limit: 1000 })) {
      const info = infoOf(m); INFO.set(endpoint + ' ' + m.id, info);
      out.push({ id: m.id, efforts: info.efforts, meta: false, ...(m.max_input_tokens && { ctx: m.max_input_tokens }) });
    }
  } catch (e) { throw httpError(e); }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// One image part: data URLs go as base64, anything else by URL.
const image = (url) => {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url } };
};
const userContent = (c) => (Array.isArray(c) ? c.map((p) => (p.type === 'image_url' ? image(p.image_url?.url || '') : { type: 'text', text: p.text || '' })) : String(c ?? ''));

/** OpenAI-style messages to {system, messages}. Tool results of one round go in one user message; an assistant turn from an earlier tool round keeps its own blocks. */
function convert(messages) {
  const system = [], out = [];
  for (const m of messages) {
    if (m.role === 'system') { system.push(String(m.content ?? '')); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.blocks) out.push({ role: 'assistant', content: m.blocks });
      else if (String(m.content ?? '').trim()) out.push({ role: 'assistant', content: String(m.content) });
      continue;
    }
    out.push({ role: 'user', content: userContent(m.content) });
  }
  return { system: system.join('\n\n'), messages: out };
}

/** Thinking and effort for the app's reasoning level ('' = send nothing). */
function reasoning(info, effort) {
  if (!info.adaptive) return {}; // shortcut: older models (Haiku 4.5) only take budget_tokens; they reply without reasoning here
  if (effort === 'none') return { thinking: { type: 'disabled' } }; // models that can't turn thinking off say so
  const level = effort === 'minimal' ? 'low' : effort;
  return { thinking: { type: 'adaptive', display: 'summarized' }, ...(EFFORTS.includes(level) && info.efforts !== false && { output_config: { effort: level } }) };
}

// After a mid-output fallback, the declined model's thinking and tool calls before the last fallback block must not be sent back or run.
function afterFallback(blocks) {
  const i = blocks.map((b) => b.type).lastIndexOf('fallback');
  return i < 0 ? blocks : blocks.filter((b, j) => j >= i || !['thinking', 'redacted_thinking', 'tool_use'].includes(b.type));
}

/**
 * One streamed request; same contract as api.js streamOnce. `extra` is {effort?, tools?, tool_choice?} from api.js.
 * Tool calls are pushed onto `calls` in OpenAI shape; `blocks` (the reply's content) goes back with them on the next round.
 * @returns {Promise<{content: string, reasoning: string, usage?: object, blocks?: object[], error?: string, stopped?: boolean}>}
 */
async function streamOnce(endpoint, key, model, messages, extra, onDelta, fetchFn, signal, calls) {
  const api = client(endpoint, key, fetchFn), id = endpoint + ' ' + model;
  if (!INFO.has(id)) {
    try { INFO.set(id, infoOf(await api.models.retrieve(model, null, { signal }))); }
    catch (e) { if (signal?.aborted) throw new Error('Stopped', { cause: e }); INFO.set(id, { maxOut: OUT_CAP, adaptive: true, efforts: EFFORTS }); } // unknown: assume a current model
  }
  const info = INFO.get(id), { system, messages: msgs } = convert(messages);
  const tools = extra.tools?.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  const params = {
    model, max_tokens: Math.min(info.maxOut, OUT_CAP), messages: msgs, cache_control: { type: 'ephemeral' },
    ...(system && { system }), ...reasoning(info, extra.effort),
    ...(tools && { tools, tool_choice: { type: extra.tool_choice === 'none' ? 'none' : 'auto' } }),
    ...(FALLBACKS.has(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
  };
  const out = { content: '', reasoning: '' };
  const stream = api.beta.messages.stream(/** @type {any} */ (params), { signal });
  stream.on('thinking', (d) => { out.reasoning += d; onDelta({ reasoning: d, content: '' }); });
  stream.on('text', (d) => { out.content += d; onDelta({ reasoning: '', content: d }); });
  let msg;
  try { msg = await stream.finalMessage(); }
  catch (e) {
    if (!out.content) throw httpError(e, signal); // nothing worth keeping
    return signal?.aborted ? { ...out, stopped: true } : { ...out, error: httpError(e, signal).message };
  }
  const u = msg.usage || {}, input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  out.usage = { prompt_tokens: input, completion_tokens: u.output_tokens || 0, total_tokens: input + (u.output_tokens || 0) };
  if (msg.stop_reason === 'refusal') {
    if (!out.content) throw new Error('Claude declined to answer.');
    return { ...out, error: 'Claude stopped: it declined to continue.' };
  }
  const blocks = afterFallback(/** @type {any[]} */ (msg.content));
  for (const b of blocks) if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  return { ...out, blocks };
}

module.exports = { isAnthropic, listModels, streamOnce, convert };
