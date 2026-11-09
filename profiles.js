// Connection profiles: pure state functions (no Electron) so they can be unit-tested.
// Stored profile: {id, name, endpoint, model, format, meta, keyEnc | keyPlain}. Keys are opaque here; main.js encrypts them.
const Lib = require('./lib');
const TEMPLATES = [
  { id: 'nanogpt', name: 'NanoGPT', endpoint: 'https://nano-gpt.com/api/v1' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1' },
  { id: 'venice', name: 'Venice', endpoint: 'https://api.venice.ai/api/v1' },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
];

const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
const KEY_FIELDS = ['keyEnc', 'keyPlain'];
const keyOf = (o) => Object.fromEntries(KEY_FIELDS.filter((k) => o[k]).map((k) => [k, o[k]]));
const hasKey = (p) => KEY_FIELDS.some((k) => p[k]);
const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
const fallbackActive = (profiles, id) => (profiles.some((p) => p.id === id) ? id : profiles[0]?.id || '');

// Turns whatever is on disk (nothing, the old single-endpoint file, or v2) into v2 state.
// Templates are NOT profiles: they only exist as starting points in the New profile dialog.
function migrate(raw) {
  if (raw && raw.version === 2 && Array.isArray(raw.profiles)) {
    // an earlier version pre-created the four templates; drop the ones that never got a key
    const profiles = raw.profiles.filter((p) => !(TEMPLATE_IDS.includes(p.id) && !hasKey(p)));
    return finishState({ version: 2, activeId: fallbackActive(profiles, raw.activeId), effort: raw.effort || '', profiles }, raw);
  }
  const state = { version: 2, activeId: '', effort: (raw && raw.effort) || '', profiles: [] };
  if (raw && raw.endpoint) { // old single-endpoint file becomes one profile
    let host = 'Custom'; try { host = new URL(raw.endpoint).host || host; } catch {}
    const tpl = TEMPLATES.find((t) => norm(t.endpoint) === norm(raw.endpoint));
    state.profiles.push({
      id: 'custom-' + host.toLowerCase().replace(/[^a-z0-9]+/g, '-'), // stable: migrate() runs on every read until the file is rewritten
      name: tpl ? tpl.name : host, endpoint: raw.endpoint, model: raw.model || '', format: raw.format || 'auto', meta: !!raw.meta, ...keyOf(raw),
    });
    state.activeId = state.profiles[0].id;
  }
  return finishState(state, raw);
}

const str = (v) => (typeof v === 'string' ? v : '');
// Summarizer: {profileId, model}; an empty profileId means the chat model writes the summaries. Returns null when `v` isn't one.
const cleanSummarizer = (v) => (v && typeof v === 'object' ? { profileId: str(v.profileId), model: str(v.profileId) ? str(v.model) : '' } : null);
// The context limit used for models whose list gives none: {on, tokens}. Returns null for anything that isn't a whole number of at least 1000 tokens.
const cleanContextLimit = (v) => (v && typeof v === 'object' && Number.isInteger(v.tokens) && v.tokens >= 1000 ? { on: v.on === true, tokens: v.tokens } : null);

// Personas: {id, name, user, bot, prompt, summarizer?}. `summarizer` is there only while the persona's own-summary-model switch is on. 'default' always exists and can't be deleted. `render` (which reply formats are shown and hinted) and `theme` have defaults; `rich` is the old single switch.
function finishState(state, raw) {
  const personas = (Array.isArray(raw?.personas) ? raw.personas : []).filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p) => { const sum = cleanSummarizer(p.summarizer); return { id: p.id, name: str(p.name), user: str(p.user), bot: str(p.bot), prompt: str(p.prompt), ...(sum && { summarizer: sum }) }; });
  if (!personas.some((p) => p.id === 'default')) personas.unshift({ id: 'default', name: 'Default', user: '', bot: '', prompt: '' });
  const richOff = raw?.rich === false; // old single switch: off meant "no HTML/CSS/JS", Markdown stayed on
  const r = raw?.render && typeof raw.render === 'object' ? raw.render : {};
  const render = Object.fromEntries(Lib.RENDER_KEYS.map((k) => [k, typeof r[k] === 'boolean' ? r[k] : !(richOff && k !== 'markdown')]));
  const search = { enabled: raw?.search?.enabled === true, ...(raw?.search && typeof raw.search === 'object' ? keyOf(raw.search) : {}) }; // web search: {enabled, keyEnc|keyPlain}
  // MCP servers: {enabled, keyEnc|keyPlain, names, allow}. The pasted config sits in the key fields, encrypted like a key, since env and headers often hold tokens.
  // `names` is a plain copy of its server names for the window; `allow` is {server: [tool]} for "Always allow".
  const m = raw?.mcp && typeof raw.mcp === 'object' ? raw.mcp : {};
  const allow = Object.fromEntries(Object.entries(m.allow && typeof m.allow === 'object' ? m.allow : {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.filter((t) => typeof t === 'string')]));
  const mcp = { enabled: m.enabled === true, ...keyOf(m), names: Array.isArray(m.names) ? m.names.filter((n) => typeof n === 'string') : [], allow };
  const summarizer = cleanSummarizer(raw?.summarizer) || { profileId: '', model: '' }, contextLimit = cleanContextLimit(raw?.contextLimit) || { on: false, tokens: Lib.DEFAULT_CTX };
  return { ...state, search, mcp, summarizer, contextLimit, personas, personaId: personas.some((p) => p.id === raw?.personaId) ? raw.personaId : 'default', render, theme: Lib.cleanTheme(raw?.theme) || { id: 'aurora' } };
}

const newId = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Insert a profile (made active) or update one (active profile unchanged). Key fields in `p` replace the stored key only when present.
function upsert(state, p) {
  const profiles = state.profiles.map((x) => ({ ...x }));
  let target = p.id && profiles.find((x) => x.id === p.id);
  if (!target) { target = { id: newId(), model: '', format: 'auto', meta: false }; profiles.push(target); }
  for (const k of ['name', 'endpoint', 'format', 'model', 'meta', 'noTools', 'ctx']) if (p[k] !== undefined) target[k] = p[k];
  if (p.keyEnc !== undefined || p.keyPlain !== undefined) { for (const k of KEY_FIELDS) delete target[k]; Object.assign(target, keyOf(p)); }
  const editing = p.id && state.profiles.some((x) => x.id === p.id) && state.profiles.some((x) => x.id === state.activeId);
  return { ...state, profiles, activeId: editing ? state.activeId : target.id }; // a new profile becomes active; editing another one doesn't switch
}

function remove(state, id) {
  const profiles = state.profiles.filter((p) => p.id !== id);
  return { ...state, profiles, activeId: fallbackActive(profiles, state.activeId) };
}

// What the window gets: never the keys themselves.
function publicView(state) {
  return {
    activeId: state.activeId, effort: state.effort, templates: TEMPLATES, personas: state.personas, personaId: state.personaId, render: state.render, theme: state.theme,
    summarizer: state.summarizer, contextLimit: state.contextLimit, search: { enabled: state.search.enabled, hasKey: hasKey(state.search) },
    mcp: { enabled: state.mcp.enabled, hasConfig: hasKey(state.mcp), servers: state.mcp.names, allow: state.mcp.allow },
    profiles: state.profiles.map(({ id, name, endpoint, model, format, meta, noTools, ctx, ...rest }) => ({
      id, name, endpoint, model: model || '', format: format || 'auto', meta: !!meta, noTools: !!noTools, ctx: ctx || 0, hasKey: hasKey(rest),
    })),
  };
}

module.exports = { TEMPLATES, migrate, upsert, remove, publicView, cleanSummarizer, cleanContextLimit };
