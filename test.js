const test = require('node:test');
const assert = require('node:assert');
const { listModelsDetailed, chatStream, thinkSplitter } = require('./api');

const fake = (status, body, seen = {}) => async (url, opts) => {
  Object.assign(seen, { url, opts });
  return { ok: status < 300, status, text: async () => JSON.stringify(body) };
};

test('listModelsDetailed sorts ids and strips trailing slash', async () => {
  const seen = {};
  const ids = (await listModelsDetailed('http://x/v1/', 'k', fake(200, { data: [{ id: 'b' }, { id: 'a' }] }, seen))).map((m) => m.id);
  assert.deepStrictEqual(ids, ['a', 'b']);
  assert.strictEqual(seen.url, 'http://x/v1/models');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer k');
});

test('error response throws', async () => {
  await assert.rejects(listModelsDetailed('http://x', 'k', fake(401, { error: 'bad key' })), /HTTP 401/);
});

const { reasoningParams } = require('./api');

test('reasoningParams picks the right shape per endpoint', () => {
  assert.deepStrictEqual(reasoningParams('https://api.openai.com/v1', 'high'), { reasoning_effort: 'high' });
  assert.deepStrictEqual(reasoningParams('https://openrouter.ai/api/v1', 'low'), { reasoning: { effort: 'low' } });
  assert.deepStrictEqual(reasoningParams('https://api.openai.com/v1', ''), {});
});

test('listModelsDetailed reads reasoning metadata', async () => {
  const data = [
    { id: 'a', reasoning: { mandatory: true, supported_efforts: ['high', 'low'], default_effort: 'low' } },
    { id: 'b', reasoning: { mandatory: false } },
    { id: 'c', supported_parameters: ['temperature'] },
    { id: 'd' },
  ];
  const [a, b, c, d] = await listModelsDetailed('http://x', '', fake(200, { data }));
  assert.deepStrictEqual(a, { id: 'a', efforts: ['high', 'low'], mandatory: true, default: 'low', meta: true });
  assert.strictEqual(b.efforts, null);
  assert.strictEqual(c.efforts, false);
  assert.strictEqual(d.efforts, null);
});

test('reasoningParams handles DeepSeek, GLM and Kimi direct endpoints', () => {
  assert.deepStrictEqual(reasoningParams('https://api.deepseek.com/v1', 'max'), { reasoning_effort: 'max', thinking: { type: 'enabled' } });
  assert.deepStrictEqual(reasoningParams('https://api.z.ai/api/paas/v4', 'none'), { thinking: { type: 'disabled' } });
  assert.deepStrictEqual(reasoningParams('https://api.z.ai/api/paas/v4', 'high'), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
  assert.deepStrictEqual(reasoningParams('https://api.moonshot.ai/v1', 'low'), { reasoning_effort: 'low' });
  assert.deepStrictEqual(reasoningParams('https://api.moonshot.ai/v1', 'none'), { thinking: { type: 'disabled' } });
});

test('custom gateway: metadata or manual format selects the request shape', () => {
  const gw = 'https://my-gateway.example.com/v1';
  assert.deepStrictEqual(reasoningParams(gw, 'high'), { reasoning_effort: 'high' });
  assert.deepStrictEqual(reasoningParams(gw, 'high', { meta: true }), { reasoning: { effort: 'high' } });
  assert.deepStrictEqual(reasoningParams(gw, 'none', { format: 'thinking' }), { thinking: { type: 'disabled' } });
  assert.deepStrictEqual(reasoningParams(gw, 'low', { format: 'openai', meta: true }), { reasoning_effort: 'low' });
});

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const makeChats = require('./chats');

test('chat store keeps chats separate, sorted, deletable, and rejects bad ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
  const store = makeChats(dir);
  store.save({ id: 'a1', title: 'A', updated: 1, messages: [{ role: 'user', content: 'alpha' }] });
  store.save({ id: 'b2', title: 'B', updated: 2, messages: [{ role: 'user', content: 'beta' }] });
  assert.deepStrictEqual(store.list().map((c) => c.id), ['b2', 'a1']);
  assert.deepStrictEqual(store.load('a1').messages, [{ role: 'user', content: 'alpha' }]);
  store.remove('a1');
  assert.deepStrictEqual(store.list().map((c) => c.id), ['b2']);
  assert.throws(() => store.load('../x'), /Invalid chat id/);
  assert.throws(() => store.save({ id: '../../evil' }), /Invalid chat id/);
  fs.rmSync(dir, { recursive: true });
});

// Fake streaming fetch: SSE text cut into awkward 7-byte pieces.
const sse = (text, seen = {}, ctype = 'text/event-stream; charset=utf-8') => async (url, opts) => {
  Object.assign(seen, { url, opts });
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true, status: 200, headers: new Headers({ 'content-type': ctype }), text: async () => text,
    body: new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }),
  };
};
const frames = (deltas) => deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n';

test('chatStream streams reasoning_content, reasoning and content deltas', async () => {
  const seen = {}, deltas = [];
  const out = await chatStream('http://x', '', 'm', [], { reasoning_effort: 'high' }, (d) => deltas.push(d),
    sse(frames([{ reasoning_content: 'Let me ' }, { reasoning_content: 'think.' }, { reasoning: ' More.' }, { content: 'Hello' }, { content: ' wörld' }]), seen));
  assert.deepStrictEqual(out, { reasoning: 'Let me think. More.', content: 'Hello wörld' });
  assert.ok(deltas.length >= 2);
  const body = JSON.parse(seen.opts.body);
  assert.strictEqual(body.stream, true); assert.strictEqual(body.reasoning_effort, 'high');
});

test('chatStream splits <think> tags even when cut across chunks', async () => {
  const out = await chatStream('http://x', '', 'm', [], {}, () => {}, sse(frames([{ content: '<thi' }, { content: 'nk>abc</th' }, { content: 'ink>\n\nAnswer' }])));
  assert.deepStrictEqual(out, { reasoning: 'abc', content: 'Answer' });
  const split = thinkSplitter();
  assert.deepStrictEqual(split('Use <think> tags', true), { reasoning: '', content: 'Use <think> tags' });
});

test('chatStream falls back to plain JSON when the server ignores stream', async () => {
  const json = JSON.stringify({ choices: [{ message: { content: 'hi', reasoning_content: 'r' } }] });
  assert.deepStrictEqual(await chatStream('http://x', '', 'm', [], {}, () => {}, sse(json, {}, 'application/json')), { content: 'hi', reasoning: 'r' });
});

test('chatStream throws on HTTP errors and mid-stream error chunks', async () => {
  await assert.rejects(chatStream('http://x', '', 'm', [], {}, () => {}, fake(400, { error: 'bad level' })), /HTTP 400/);
  await assert.rejects(chatStream('http://x', '', 'm', [], {}, () => {}, sse('data: {"error":{"message":"boom"}}\n\n')), /boom/);
});

const profiles = require('./profiles');

test('profiles: first run is empty; templates are not profiles', () => {
  const st = profiles.migrate(null);
  assert.deepStrictEqual([st.profiles, st.activeId], [[], '']);
  assert.deepStrictEqual(profiles.publicView(st).templates.map((t) => t.name), ['NanoGPT', 'OpenRouter', 'Venice', 'OpenAI']);
  const urls = Object.fromEntries(profiles.TEMPLATES.map((t) => [t.id, t.endpoint]));
  assert.strictEqual(urls.nanogpt, 'https://nano-gpt.com/api/v1'); assert.strictEqual(urls.venice, 'https://api.venice.ai/api/v1');
  assert.strictEqual(urls.openrouter, 'https://openrouter.ai/api/v1'); assert.strictEqual(urls.openai, 'https://api.openai.com/v1');
});

test('profiles: an old settings file becomes one profile named after its template or host', () => {
  const t = profiles.migrate({ endpoint: 'https://openrouter.ai/api/v1/', model: 'x/y', effort: 'high', format: 'openai', keyEnc: 'ENC' });
  assert.strictEqual(t.profiles.length, 1);
  assert.deepStrictEqual([t.profiles[0].name, t.profiles[0].keyEnc, t.profiles[0].model, t.profiles[0].format, t.effort], ['OpenRouter', 'ENC', 'x/y', 'openai', 'high']);
  assert.strictEqual(t.activeId, t.profiles[0].id);
  const c = profiles.migrate({ endpoint: 'http://localhost:1234/v1', keyPlain: 'k' });
  assert.deepStrictEqual([c.profiles[0].name, c.profiles[0].keyPlain], ['localhost:1234', 'k']);
  assert.strictEqual(profiles.migrate({ endpoint: 'http://127.0.0.1:1/v1' }).activeId, profiles.migrate({ endpoint: 'http://127.0.0.1:1/v1' }).activeId); // id is stable
  // a keyless migrated profile survives re-reads (its id is not a template id)
  const again = profiles.migrate(JSON.parse(JSON.stringify(profiles.migrate({ endpoint: 'https://api.openai.com/v1' }))));
  assert.strictEqual(again.profiles.length, 1);
});

test('profiles: v2 files drop seeded template profiles that never got a key, keep keyed ones', () => {
  const seed = (id, extra = {}) => ({ id, name: id, endpoint: 'https://x/' + id, model: '', format: 'auto', meta: false, ...extra });
  const raw = { version: 2, activeId: 'openai', effort: 'low', profiles: [seed('nanogpt', { keyEnc: 'K' }), seed('openrouter'), seed('venice'), seed('openai'), seed('p-mine')] };
  const st = profiles.migrate(raw);
  assert.deepStrictEqual(st.profiles.map((p) => p.id), ['nanogpt', 'p-mine']);
  assert.strictEqual(st.activeId, 'nanogpt');            // active one was pruned, falls back
  assert.strictEqual(st.effort, 'low');
  assert.strictEqual(profiles.migrate({ version: 2, activeId: 'x', profiles: [seed('openai')] }).activeId, ''); // nothing left
});

test('profiles: upsert creates, updates, sets/keeps/clears keys, and activates', () => {
  let st = profiles.upsert(profiles.migrate(null), { name: 'Mine', endpoint: 'http://a/v1', keyPlain: 'k1' });
  const id = st.activeId; assert.ok(id); assert.strictEqual(st.profiles.length, 1);
  st = profiles.upsert(st, { id, name: 'Renamed' });                       // no key field: key kept
  assert.deepStrictEqual([st.profiles[0].keyPlain, st.profiles[0].name], ['k1', 'Renamed']);
  st = profiles.upsert(st, { id, keyEnc: 'E' });                           // new key replaces the old one entirely
  assert.deepStrictEqual([st.profiles[0].keyPlain, st.profiles[0].keyEnc], [undefined, 'E']);
  st = profiles.upsert(st, { id, keyEnc: '' });                            // empty clears
  assert.strictEqual(profiles.publicView(st).profiles[0].hasKey, false);
});

test('profiles: remove falls back to another profile and may delete the last one', () => {
  let st = profiles.upsert(profiles.upsert(profiles.migrate(null), { name: 'A', endpoint: 'http://a' }), { name: 'B', endpoint: 'http://b' });
  const [a, b] = st.profiles.map((p) => p.id);
  assert.strictEqual(st.activeId, b);
  st = profiles.remove(st, b); assert.strictEqual(st.activeId, a);
  st = profiles.remove(st, a); assert.deepStrictEqual([st.profiles, st.activeId], [[], '']);
});

test('profiles: publicView never exposes keys', () => {
  const st = profiles.upsert(profiles.migrate(null), { name: 'V', endpoint: 'http://v', keyPlain: 'SECRET-KEY' });
  const json = JSON.stringify(profiles.publicView(st));
  assert.ok(!json.includes('SECRET-KEY') && !json.includes('keyPlain'));
  assert.strictEqual(profiles.publicView(st).profiles[0].hasKey, true);
});

// ---- chats index ----
test('chat list reads only the index, rebuilds it when missing, and keeps it in step with save/remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
  const store = makeChats(dir);
  store.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  fs.writeFileSync(path.join(dir, 'a1.json'), 'not json'); // list must not open chat files
  assert.deepStrictEqual(store.list().map((c) => c.id), ['b2', 'a1']);
  fs.rmSync(path.join(dir, '_index.json'));
  assert.deepStrictEqual(store.list().map((c) => c.id), ['b2']); // rebuilt by scanning; the corrupt chat is skipped
  assert.ok(fs.existsSync(path.join(dir, '_index.json')));
  store.remove('b2');
  assert.deepStrictEqual(store.list(), []);
  assert.throws(() => store.load('_index'), /Invalid chat id/);
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  fs.rmSync(dir, { recursive: true });
});

// ---- chatStream: stop, partial replies, bad bodies ----
const cut = (text) => async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
  pull(c) { if (!text) return c.error(new Error('socket hang up')); c.enqueue(new TextEncoder().encode(text)); text = ''; } }) });

test('chatStream keeps the partial reply when the stream breaks late, and throws when nothing arrived', async () => {
  const out = await chatStream('http://x', '', 'm', [], {}, () => {}, cut(frames([{ content: 'Hel' }, { content: 'lo' }]).replace('data: [DONE]\n\n', '')));
  assert.strictEqual(out.content, 'Hello'); assert.match(out.error, /socket hang up/);
  await assert.rejects(chatStream('http://x', '', 'm', [], {}, () => {}, cut('')), /socket hang up/);
});

test('chatStream abort: partial reply is marked stopped, no reply throws Stopped', async () => {
  const ctl = new AbortController();
  const slow = async (url, opts) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frames([{ content: 'part' }]).replace('data: [DONE]\n\n', ''))); opts.signal.addEventListener('abort', () => c.error(new Error('aborted'))); } }) });
  const run = chatStream('http://x', '', 'm', [], {}, () => ctl.abort(), slow, ctl.signal);
  assert.deepStrictEqual(await run, { content: 'part', reasoning: '', stopped: true });
  const pre = new AbortController(); pre.abort();
  const never = async (url, opts) => { throw new Error('fetch failed'); };
  await assert.rejects(chatStream('http://x', '', 'm', [], {}, () => {}, never, pre.signal), /Stopped/);
});

test('a non-JSON reply gets a friendly error', async () => {
  const html = async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' });
  await assert.rejects(listModelsDetailed('http://x', '', html), /didn't return JSON/);
});

// ---- settings store ----
const makeStore = require('./store');
const rot = { available: () => true, enc: (t) => Buffer.from(t).toString('base64'), dec: (b) => Buffer.from(b, 'base64').toString() };
const tmpStore = (crypto = rot) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-')); const file = path.join(dir, 'settings.json'); return { dir, file, store: makeStore({ file, crypto }) }; };

test('store: a damaged settings file is quarantined, not overwritten', () => {
  const { dir, file, store } = tmpStore();
  fs.writeFileSync(file, '{"version":2,"profiles":[{"id":"p1","keyEnc":"abc"');
  assert.deepStrictEqual(store.get().profiles, []);
  assert.match(store.takeNotice(), /damaged/); assert.strictEqual(store.takeNotice(), '');
  assert.strictEqual(fs.readFileSync(file + '.bad', 'utf8'), '{"version":2,"profiles":[{"id":"p1","keyEnc":"abc"');
  fs.writeFileSync(file, 'null'); assert.deepStrictEqual(store.get().profiles, []); // valid JSON that is not an object
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  fs.rmSync(dir, { recursive: true });
});

test('store: saving a profile without `key` keeps the stored key; `key: ""` clears it; errors never wipe it', () => {
  const { dir, store } = tmpStore();
  const st = store.saveProfile({ name: 'P', endpoint: 'http://x/v1/', key: 'sk-1' });
  const id = st.activeId;
  assert.strictEqual(store.key(id), 'sk-1'); assert.strictEqual(st.profiles[0].hasKey, true);
  store.saveProfile({ id, name: 'Renamed', endpoint: 'http://x/v1' });
  assert.strictEqual(store.key(id), 'sk-1');
  assert.throws(() => store.saveProfile({ id, endpoint: 'ftp://x' }), /http/);
  assert.strictEqual(store.key(id), 'sk-1');
  store.saveProfile({ id, name: 'Renamed', endpoint: 'http://x/v1', key: '' });
  assert.strictEqual(store.key(id), '');
  fs.rmSync(dir, { recursive: true });
});

test('store: undecryptable key is a clear error, plaintext keys upgrade, patch never creates a profile', () => {
  const { dir, file, store } = tmpStore();
  assert.throws(() => store.load(), /No profile yet/);
  store.patch({ model: 'm' }); assert.deepStrictEqual(store.get().profiles, []);
  const id = store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' }).activeId;
  assert.strictEqual(store.load().key, 'sk-1');
  const broken = makeStore({ file, crypto: { ...rot, dec: () => { throw new Error('locked'); } } });
  assert.throws(() => broken.load(), /Couldn't read the saved API key/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyEnc !== undefined, true); // still on disk
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.profiles[0] = { ...raw.profiles[0], keyEnc: undefined, keyPlain: 'sk-9' };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.strictEqual(store.key(id), 'sk-9');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyEnc); // upgraded on read
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyPlain, undefined);
  store.patch({ effort: 'high', model: 'gpt' }); const v = store.get();
  assert.strictEqual(v.effort, 'high'); assert.strictEqual(v.profiles[0].model, 'gpt');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes; %APPDATA% is per-user
  fs.rmSync(dir, { recursive: true });
});

test('store: thinkingSwitch flag comes from the one regex in api.js', () => {
  const { dir, store } = tmpStore();
  store.saveProfile({ name: 'D', endpoint: 'https://api.deepseek.com/v1' });
  assert.strictEqual(store.get().profiles[0].thinkingSwitch, true);
  store.saveProfile({ name: 'O', endpoint: 'https://api.openai.com/v1' });
  assert.strictEqual(store.get().profiles[1].thinkingSwitch, false);
  fs.rmSync(dir, { recursive: true });
});

// ---- page helpers ----
const Lib = require('./lib');
test('Lib.requestMessages: two chats never mix, and display-only fields are stripped', () => {
  const a = { messages: [{ role: 'user', content: 'alpha', text: 'alpha', files: [] }, { role: 'assistant', content: 'A!', reasoning: 'secret' }] };
  const b = { messages: [{ role: 'user', content: 'beta' }] };
  assert.deepStrictEqual(Lib.requestMessages(a), [{ role: 'user', content: 'alpha' }, { role: 'assistant', content: 'A!' }]);
  assert.deepStrictEqual(Lib.requestMessages(b), [{ role: 'user', content: 'beta' }]);
});

test('Lib.buildContent inlines text files and turns images into parts', () => {
  assert.strictEqual(Lib.buildContent('hi', []), 'hi');
  assert.strictEqual(Lib.buildContent('', [{ kind: 'text', name: 'a.txt', text: 'x' }]), '[File: a.txt]\n```\nx\n```');
  const parts = Lib.buildContent('', [{ kind: 'image', url: 'data:image/png;base64,AA' }]);
  assert.deepStrictEqual(parts, [{ type: 'text', text: 'See the attached image(s).' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]);
});

test('Lib.matchModels needs every word, in any order, ignoring case', () => {
  const ids = ['openai/gpt-4o', 'anthropic/claude-3', 'meta/llama-3'];
  assert.deepStrictEqual(Lib.matchModels(ids, 'GPT 4o'), ['openai/gpt-4o']);
  assert.deepStrictEqual(Lib.matchModels(ids, '3 claude'), ['anthropic/claude-3']);
  assert.deepStrictEqual(Lib.matchModels(ids, ''), ids);
});

// ---- personas ----
test('Lib.systemPrompt fills names and placeholders; empty persona sends nothing', () => {
  assert.strictEqual(Lib.systemPrompt(undefined), '');
  assert.strictEqual(Lib.systemPrompt({ user: '', bot: '', prompt: '' }), '');
  assert.strictEqual(Lib.systemPrompt({ user: 'Dalton', bot: 'Captain', prompt: 'Talk like {{char}} to {{ User }}.' }),
    "You are Captain. The user's name is Dalton.\n\nTalk like Captain to Dalton.");
  assert.strictEqual(Lib.systemPrompt({ user: '', bot: '', prompt: 'Hi {{user}}, I am {{CHAR}}.' }), 'Hi User, I am Assistant.');
  assert.strictEqual(Lib.systemPrompt({ user: 'D', bot: '', prompt: '' }), "The user's name is D.");
  assert.strictEqual(Lib.systemPrompt({ user: '$&', bot: 'B', prompt: '{{user}}' }), "You are B. The user's name is $&.\n\n$&"); // no regex-replacement surprises
});

test('Lib.requestMessages puts the persona first and still never mixes chats', () => {
  const a = { messages: [{ role: 'user', content: 'alpha' }] }, b = { messages: [{ role: 'user', content: 'beta' }] };
  const p = { user: 'U', bot: 'B', prompt: 'x' };
  assert.deepStrictEqual(Lib.requestMessages(a, p)[0], { role: 'system', content: "You are B. The user's name is U.\n\nx" });
  assert.deepStrictEqual(Lib.requestMessages(a, p).slice(1), [{ role: 'user', content: 'alpha' }]);
  assert.deepStrictEqual(Lib.requestMessages(b, { user: '', bot: '', prompt: '' }), [{ role: 'user', content: 'beta' }]);
});

test('chats index keeps personaId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
  const store = makeChats(dir);
  store.save({ id: 'a1', title: 'A', updated: 1, personaId: 'ps-1', messages: [] });
  assert.strictEqual(store.list()[0].personaId, 'ps-1');
  fs.rmSync(path.join(dir, '_index.json'));
  assert.strictEqual(store.list()[0].personaId, 'ps-1'); // survives an index rebuild
  fs.rmSync(dir, { recursive: true });
});

test('profiles: personas are seeded, kept, and a bad personaId falls back to default', () => {
  assert.deepStrictEqual(profiles.migrate({}).personas.map((p) => p.id), ['default']);
  assert.strictEqual(profiles.migrate({}).personaId, 'default');
  const raw = { version: 2, profiles: [], personas: [{ id: 'ps-1', name: 'P', user: 'U', bot: 'B', prompt: 'x', junk: 1 }, null, { name: 'no id' }], personaId: 'nope' };
  const st = profiles.migrate(raw);
  assert.deepStrictEqual(st.personas.map((p) => p.id), ['default', 'ps-1']);
  assert.deepStrictEqual(st.personas[1], { id: 'ps-1', name: 'P', user: 'U', bot: 'B', prompt: 'x' });
  assert.strictEqual(st.personaId, 'default');
  assert.strictEqual(profiles.migrate({ ...raw, personaId: 'ps-1' }).personaId, 'ps-1');
  assert.strictEqual(profiles.publicView(st).personas.length, 2);
});

test('store: save/select/delete personas; Default cannot be deleted; unknown personaId is ignored', () => {
  const { dir, store } = tmpStore();
  let v = store.savePersona({ name: '', bot: ' Captain ', user: 'Dalton', prompt: 'Arr' });
  const id = v.personaId;
  assert.notStrictEqual(id, 'default');
  assert.deepStrictEqual(v.personas.find((p) => p.id === id), { id, name: 'Captain', user: 'Dalton', bot: 'Captain', prompt: 'Arr' });
  v = store.savePersona({ id, name: 'Pirate', bot: 'Captain', user: 'Dalton', prompt: 'Arr!' });
  assert.strictEqual(v.personas.length, 2); assert.strictEqual(v.personas.find((p) => p.id === id).name, 'Pirate');
  assert.strictEqual(store.patch({ personaId: 'default' }).personaId, 'default');
  assert.strictEqual(store.patch({ personaId: 'nope' }).personaId, 'default');
  assert.throws(() => store.deletePersona('default'), /can't be deleted/);
  store.patch({ personaId: id });
  v = store.deletePersona(id);
  assert.deepStrictEqual(v.personas.map((p) => p.id), ['default']); assert.strictEqual(v.personaId, 'default');
  fs.rmSync(dir, { recursive: true });
});

// ---- rich replies ----
test('Lib.splitRich: raw HTML blocks go to the sandbox, inline tags and fenced code stay Markdown', () => {
  const kinds = (t) => Lib.splitRich(t).map((p) => p.type);
  assert.deepStrictEqual(Lib.splitRich('just **markdown** with <b>inline</b> and <kbd>K</kbd>'), [{ type: 'md', text: 'just **markdown** with <b>inline</b> and <kbd>K</kbd>' }]);
  // a blank line inside the block does not end it
  const a = Lib.splitRich('Intro\n\n<div class="a">\n  <p>one</p>\n\n  <p>two</p>\n</div>\n\nOutro');
  assert.deepStrictEqual(a.map((p) => p.type), ['md', 'html', 'md']);
  assert.ok(a[1].html.startsWith('<div') && a[1].html.endsWith('</div>') && a[1].html.includes('two'));
  // style + markup + script directly after each other are one page; markup inside script text is not tags
  const b = Lib.splitRich('<style>.x{color:red}</style>\n<div class=x>hi</div>\n\n<script>var s = "</div>"; if (1 < 2) {}</script>\ndone');
  assert.deepStrictEqual(b.map((p) => p.type), ['html', 'md']);
  assert.ok(b[0].html.includes('<script>') && b[1].text.trim() === 'done');
  assert.deepStrictEqual(kinds('```html\n<div>shown as code</div>\n```\n'), ['md']);
  assert.deepStrictEqual(kinds('~~~\n<script>x</script>\n~~~\n\n<div>live</div>'), ['md', 'html']);
  assert.deepStrictEqual(kinds('    <div>indented code</div>'), ['md']);
  assert.deepStrictEqual(kinds('text\n<div>never closed\nmore'), ['md', 'html']); // unclosed: runs to the end
  assert.deepStrictEqual(kinds('<svg width=10><circle r=1 /></svg>\n\ntail'), ['html', 'md']);
  assert.deepStrictEqual(kinds('<!-- note -->\n<div>x</div>'), ['md', 'html']);
  assert.deepStrictEqual(Lib.splitRich(''), []);
});

test('Lib.requestMessages adds the rich-reply hint only when asked, after the persona prompt', () => {
  const chat = { messages: [{ role: 'user', content: 'hi' }] };
  assert.deepStrictEqual(Lib.requestMessages(chat, undefined, { rich: false }), [{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(Lib.requestMessages(chat, undefined, { rich: true })[0], { role: 'system', content: Lib.RICH_HINT });
  const sys = Lib.requestMessages(chat, { user: '', bot: 'B', prompt: 'p' }, { rich: true })[0].content;
  assert.ok(sys.startsWith('You are B.') && sys.endsWith(Lib.RICH_HINT));
});

test('rich setting: on by default, kept when saved off, only booleans accepted', () => {
  assert.strictEqual(profiles.migrate({}).rich, true);
  assert.strictEqual(profiles.migrate({ version: 2, profiles: [], rich: false }).rich, false);
  const { dir, store } = tmpStore();
  assert.strictEqual(store.get().rich, true);
  assert.strictEqual(store.patch({ rich: false }).rich, false);
  assert.strictEqual(store.patch({ rich: 'no' }).rich, false); // ignored, not coerced
  assert.strictEqual(store.patch({ rich: true }).rich, true);
  fs.rmSync(dir, { recursive: true });
});

test('migrateLegacy: moves settings and chats once, never overwrites the new folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), from = path.join(root, 'chatbot'), to = path.join(root, 'javc-chatbot');
  assert.deepStrictEqual(makeStore.migrateLegacy(from, to), []); // no legacy folder: nothing happens
  assert.ok(!fs.existsSync(to));
  fs.mkdirSync(path.join(from, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(from, 'settings.json'), '{"old":1}'); fs.writeFileSync(path.join(from, 'chats', 'a.json'), '{}');
  fs.mkdirSync(path.join(to, 'Crashpad'), { recursive: true }); // Electron may create the new folder first
  assert.deepStrictEqual(makeStore.migrateLegacy(from, to), ['settings.json', 'chats']);
  assert.strictEqual(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"old":1}');
  assert.ok(fs.existsSync(path.join(to, 'chats', 'a.json')) && !fs.existsSync(path.join(from, 'settings.json')));
  fs.writeFileSync(path.join(from, 'settings.json'), '{"stale":1}'); // target already set up: leave both sides alone
  assert.deepStrictEqual(makeStore.migrateLegacy(from, to), []);
  assert.strictEqual(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"old":1}');
  assert.ok(fs.existsSync(path.join(from, 'settings.json')));
  fs.rmSync(root, { recursive: true });
});
