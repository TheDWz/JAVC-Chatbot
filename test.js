const test = require('node:test');
const assert = require('node:assert');
const { listModelsDetailed, chatStream, thinkSplitter, requestArgs } = require('./api');

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
const { makeDisk, migrateLegacy } = require('./disk');
const { makeChatSeal, PREFIX } = require('./seal');
const b64Keyring = { available: () => true, enc: (t) => Buffer.from(t).toString('base64'), dec: (b) => Buffer.from(b, 'base64').toString() };
/** A chats folder in a temp dir, encrypted as the hosts do it (chatkey.json goes in `<dir>-set`). */
const sealFor = (dir, /** @type {import('./store').KeyCrypto} */ crypto = b64Keyring) => makeChatSeal({ io: makeDisk(dir + '-set'), crypto, chats: makeDisk(dir) });
const tmpChats = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-')); return { dir, store: makeChats(sealFor(dir).io) }; };

test('chat store keeps chats separate, sorted, deletable, and rejects bad ids', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [{ role: 'user', content: 'alpha' }] });
  await store.save({ id: 'b2', title: 'B', updated: 2, messages: [{ role: 'user', content: 'beta' }] });
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['b2', 'a1']);
  assert.deepStrictEqual((await store.load('a1')).messages, [{ role: 'user', content: 'alpha' }]);
  await store.remove('a1');
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['b2']);
  await assert.rejects(store.load('a1'), /no longer exists/);
  await assert.rejects(store.load('../x'), /Invalid chat id/);
  await assert.rejects(store.save({ id: '../../evil' }), /Invalid chat id/);
  fs.rmSync(dir, { recursive: true });
});

// ---- chat encryption (seal.js) ----
const sealDirs = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-')); return { dir, keyFile: path.join(dir + '-set', 'chatkey.json'), done: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '-set', { recursive: true, force: true }); } }; };

test('seal: chats are encrypted on disk, readable by the next launch, and bound to their file name', async () => {
  const { dir, keyFile, done } = sealDirs();
  const store = makeChats(sealFor(dir).io);
  await store.save({ id: 'a1', title: 'Secret title', updated: 1, messages: [{ role: 'user', content: 'my password is hunter2' }] });
  for (const n of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, n), 'utf8');
    assert.ok(raw.startsWith(PREFIX), n); assert.ok(!/hunter2|Secret title/.test(raw), n);
  }
  assert.ok(!/hunter2/.test(fs.readFileSync(keyFile, 'utf8')));
  assert.ok(JSON.parse(fs.readFileSync(keyFile, 'utf8')).keyEnc); // wrapped by the keyring
  const next = makeChats(sealFor(dir).io); // a second launch: same key file
  assert.strictEqual((await next.load('a1')).messages[0].content, 'my password is hunter2');
  assert.deepStrictEqual((await next.list()).map((c) => c.title), ['Secret title']);
  fs.copyFileSync(path.join(dir, 'a1.json'), path.join(dir, 'b2.json')); // a file can't be passed off as another chat
  await assert.rejects(sealFor(dir).io.read('b2.json'), /could not be decrypted/);
  done();
});

test('seal: upgrade encrypts chats saved before encryption, once, and plain files still read meanwhile', async () => {
  const { dir, done } = sealDirs();
  await makeChats(makeDisk(dir)).save({ id: 'old1', title: 'Old', updated: 5, messages: [{ role: 'user', content: 'from before' }] });
  const store = makeChats(sealFor(dir).io);
  assert.strictEqual((await store.load('old1')).messages[0].content, 'from before'); // plain text passes through
  assert.strictEqual(await store.upgrade(), 2); // the chat and the index
  assert.ok(fs.readdirSync(dir).every((n) => fs.readFileSync(path.join(dir, n), 'utf8').startsWith(PREFIX)));
  assert.strictEqual(await store.upgrade(), 0);
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['old1']);
  const disk = makeDisk(dir), reads = []; // later launches stop at the sealed index instead of reading every chat
  const counted = makeChats(makeChatSeal({ io: makeDisk(dir + '-set'), crypto: b64Keyring, chats: { ...disk, read: (n) => { reads.push(n); return disk.read(n); } } }).io);
  assert.strictEqual(await counted.upgrade(), 0); assert.deepStrictEqual(reads, ['_index.json']);
  done();
});

test('seal: a key that cannot be unlocked is an error, and nothing is written or listed as empty', async () => {
  const { dir, keyFile, done } = sealDirs();
  await makeChats(sealFor(dir).io).save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  const keyBefore = fs.readFileSync(keyFile, 'utf8'), files = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  const locked = sealFor(dir, { ...b64Keyring, dec: () => { throw new Error('keyring locked'); } }), store = makeChats(locked.io);
  await assert.rejects(store.list(), /couldn't unlock the chat key \(keyring locked\)/);
  await assert.rejects(store.save({ id: 'b2', title: 'B', updated: 2, messages: [] }), /couldn't unlock/);
  assert.match((await locked.status()).error, /couldn't unlock/);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), keyBefore); // the key file is never replaced
  assert.deepStrictEqual(fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')), files);
  fs.writeFileSync(keyFile, '{"version":1,"keyEnc":'); // damaged: also left alone
  await assert.rejects(makeChats(sealFor(dir).io).list(), /chatkey\.json\) is damaged/);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), '{"version":1,"keyEnc":');
  done();
});

test('seal: with no keyring the key is kept plain, and moved into the keyring once one works', async () => {
  const { dir, keyFile, done } = sealDirs();
  const none = sealFor(dir, { ...b64Keyring, available: () => false });
  await makeChats(none.io).save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  assert.deepStrictEqual(await none.status(), { keyring: false });
  assert.ok(JSON.parse(fs.readFileSync(keyFile, 'utf8')).keyPlain);
  const broken = sealFor(dir, { ...b64Keyring, dec: () => 'not what was stored' }); // a keyring that doesn't read back is not used
  assert.deepStrictEqual(await broken.status(), { keyring: false });
  assert.ok(JSON.parse(fs.readFileSync(keyFile, 'utf8')).keyPlain);
  const later = sealFor(dir, { available: async () => true, enc: async (t) => b64Keyring.enc(t), dec: async (b) => b64Keyring.dec(b) });
  assert.deepStrictEqual(await later.status(), { keyring: true });
  const rec = JSON.parse(fs.readFileSync(keyFile, 'utf8')); assert.ok(rec.keyEnc && !rec.keyPlain);
  assert.deepStrictEqual((await makeChats(later.io).list()).map((c) => c.id), ['a1']); // same key, so the chats still open
  done();
});

test('seal: a lost key file means a new key and a notice, and the old encrypted chats are kept', async () => {
  const { dir, keyFile, done } = sealDirs();
  await makeChats(sealFor(dir).io).save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  fs.rmSync(keyFile);
  const fresh = sealFor(dir), store = makeChats(fresh.io);
  assert.deepStrictEqual(await fresh.status(), { keyring: true });
  assert.deepStrictEqual(await store.list(), []); // unreadable files are set aside, not deleted
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('a1.json.') && n.endsWith('.unreadable')));
  assert.match(fresh.takeNotice(), /^1 saved chat was encrypted with a key this device no longer has\. It is kept on disk[^]*Import\.$/); assert.strictEqual(fresh.takeNotice(), ''); // one notice, not two
  await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['b2']);
  done();
});

test('seal: a chat that cannot be decrypted is set aside once, with one notice, and kept intact', async () => {
  const { dir, done } = sealDirs();
  const seal = sealFor(dir), store = makeChats(seal.io);
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] }); await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  const good = fs.readFileSync(path.join(dir, 'b2.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'b2.json'), good.slice(0, -6) + 'AAAA=='); fs.rmSync(path.join(dir, '_index.json')); // changed, and not in the index
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['a1']);
  const aside = fs.readdirSync(dir).filter((n) => n.endsWith('.unreadable'));
  assert.strictEqual(aside.length, 1); assert.ok(!fs.existsSync(path.join(dir, 'b2.json')));
  assert.match(seal.takeNotice(), /^1 saved chat couldn't be decrypted .* left out of the list\. It is kept on disk/); assert.strictEqual(seal.takeNotice(), '');
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['a1']); assert.strictEqual(seal.takeNotice(), ''); // not retried
  fs.writeFileSync(path.join(dir, 'b2.json'), good); fs.rmSync(path.join(dir, aside[0])); // an intact file with that name opens again
  assert.strictEqual((await store.load('b2')).title, 'B');
  done();
});

test('seal: a chat in the index that cannot be decrypted is set aside when opened, and drops out of the list', async () => {
  const { dir, done } = sealDirs();
  const seal = sealFor(dir), store = makeChats(seal.io);
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] }); await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  const f = path.join(dir, 'b2.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').slice(0, -6) + 'AAAA==');
  await assert.rejects(store.load('b2'), /could not be decrypted/);
  assert.ok(!fs.existsSync(f) && fs.readdirSync(dir).some((n) => n.endsWith('.unreadable')));
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['a1']);
  done();
});

test('seal: a keyring that throws, or one that does not count, leaves the key plain and the chats working', async () => {
  const { dir, keyFile, done } = sealDirs();
  const throwing = sealFor(dir, { available: () => true, enc: () => { throw new Error('locked'); }, dec: () => { throw new Error('locked'); } });
  assert.deepStrictEqual(await throwing.status(), { keyring: false });
  assert.ok(JSON.parse(fs.readFileSync(keyFile, 'utf8')).keyPlain);
  await makeChats(throwing.io).save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  fs.writeFileSync(keyFile, JSON.stringify({ version: 1, keyEnc: b64Keyring.enc(JSON.parse(fs.readFileSync(keyFile, 'utf8')).keyPlain) }));
  const basic = sealFor(dir, { ...b64Keyring, available: () => false }); // the wrapping still opens, but the store isn't a keyring (Linux basic_text)
  assert.deepStrictEqual(await basic.status(), { keyring: false });
  assert.deepStrictEqual((await makeChats(basic.io).list()).map((c) => c.id), ['a1']);
  done();
});

// ---- chat export and import (backup.js) ----
const Backup = require('./backup');
const sample = () => [
  { id: 'c1', title: 'Trip', updated: 10, personaId: 'p1', messages: [{ role: 'user', text: 'Plan it', content: 'Plan it', files: [{ name: 'map.png', kind: 'image' }, { name: 'notes.txt', kind: 'text' }] }, { role: 'assistant', content: 'Day 1: go', reasoning: 'secret thoughts' }] },
  { id: 'c2', title: 'Other', updated: 20, personaId: 'gone', messages: [{ role: 'user', text: 'hi', content: 'hi' }] },
];

test('backup: JSON export round-trips, and import adds new chats and replaces only with newer copies', async () => {
  const f = await Backup.buildExport(sample(), { now: Date.UTC(2026, 10, 10, 12) });
  assert.match(f.name, /^javc-chats-2026-11-1\d\.json$/); assert.strictEqual(f.mime, 'application/json');
  const read = await Backup.readExport(f.text);
  assert.deepStrictEqual(read, { chats: sample(), skipped: 0 });
  const { dir, store } = tmpChats();
  await store.save({ id: 'c1', title: 'Trip (older here)', updated: 5, messages: [] });
  await store.save({ id: 'c3', title: 'Mine', updated: 1, messages: [] });
  const newer = { id: 'c2', title: 'Other, newer', updated: 99, messages: [] };
  await store.save(newer);
  const r = await Backup.mergeInto(store, read);
  assert.deepStrictEqual(r, { added: 0, updated: 1, kept: 1, skipped: 0, ids: ['c1'] });
  assert.strictEqual((await store.load('c1')).title, 'Trip'); // the export's copy was newer
  assert.strictEqual((await store.load('c2')).title, 'Other, newer'); // this device's copy was newer
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['c2', 'c1', 'c3']);
  const twice = await Backup.mergeInto(store, { chats: [{ id: 'n1', title: 'old', updated: 1, messages: [] }, { id: 'n1', title: 'new', updated: 2, messages: [] }], skipped: 0 });
  assert.deepStrictEqual([twice.added, twice.updated], [1, 0]); assert.strictEqual((await store.load('n1')).title, 'new');
  fs.rmSync(dir, { recursive: true });
});

test('backup: a passphrase export is encrypted, needs the passphrase, and rejects a wrong one', async () => {
  const f = await Backup.buildExport(sample(), { format: 'txt', passphrase: 'correct horse' }); // a passphrase means locked JSON, whatever the format
  assert.match(f.name, /-protected\.json$/); assert.strictEqual(f.mime, 'application/json');
  assert.ok(!/Plan it|Trip|Day 1/.test(f.text));
  const box = JSON.parse(f.text); assert.strictEqual(box.kind, 'chats-encrypted'); assert.strictEqual(box.kdf.iterations, 600000);
  await assert.rejects(Backup.readExport(f.text), /protected with a passphrase/);
  await assert.rejects(Backup.readExport(f.text, 'wrong horse'), /Wrong passphrase/);
  assert.deepStrictEqual((await Backup.readExport(f.text, 'correct horse')).chats, sample());
  await assert.rejects(Backup.readExport(JSON.stringify({ ...box, kdf: { ...box.kdf, iterations: 1e9 } }), 'x'), /isn't a JAVC Chatbot chat export/); // no endless hashing
});

test('backup: import rejects other files and drops chats with bad ids or shapes', async () => {
  await assert.rejects(Backup.readExport('not json'), /isn't a JAVC Chatbot chat export/);
  await assert.rejects(Backup.readExport('{"app":"other","kind":"chats","version":1,"chats":[]}'), /isn't a JAVC/);
  await assert.rejects(Backup.readExport('{"app":"javc-chatbot","kind":"chats","version":2,"chats":[]}'), /newer version/);
  await assert.rejects(Backup.readExport('{"app":"javc-chatbot","kind":"chats-encrypted","version":2}', 'pw'), /newer version/);
  const bad = [{ id: '../evil', updated: 1, messages: [] }, { id: 'ok2', updated: 1 }, null, { id: 'm1', updated: 1, messages: [null] },
    { id: 'm2', updated: 1, messages: [{ role: 'user', files: {} }] }, { id: 'm3', updated: 1, title: 5, messages: [] }]; // each would break opening the chat or the text export
  const r = await Backup.readExport(JSON.stringify({ app: 'javc-chatbot', kind: 'chats', version: 1, chats: [sample()[0], ...bad] }));
  assert.deepStrictEqual(r.chats.map((c) => c.id), ['c1']); assert.strictEqual(r.skipped, 6);
});

test('backup: the text export is a readable transcript without reasoning', async () => {
  const f = await Backup.buildExport(sample(), { format: 'txt', names: { p1: { user: 'Dana', bot: 'Captain' } } });
  assert.match(f.name, /\.txt$/); assert.strictEqual(f.mime, 'text/plain');
  assert.match(f.text, /^JAVC Chatbot chats, exported .+ \(2 chats\)/);
  assert.match(f.text, /=== Trip ===\nUpdated .+\n\nDana:\nPlan it\n\[image: map\.png\]\n\[file: notes\.txt\]\n\nCaptain:\nDay 1: go/);
  assert.match(f.text, /=== Other ===\nUpdated .+\n\nYou:\nhi/); // an unknown persona gets the plain names
  assert.ok(!f.text.includes('secret thoughts'));
});

test('backup: collect gathers every readable chat and counts the ones it cannot read', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  fs.writeFileSync(path.join(dir, 'b2.json'), PREFIX + 'AAAA'); // damaged after it was listed
  const r = await Backup.collect(store);
  assert.deepStrictEqual(r.chats.map((c) => c.id), ['a1']); assert.strictEqual(r.missed, 1);
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

test('profiles: editing a profile that is not active keeps the active one', () => {
  let st = profiles.upsert(profiles.upsert(profiles.migrate(null), { name: 'A', endpoint: 'http://a' }), { name: 'B', endpoint: 'http://b' });
  const [a, b] = st.profiles.map((p) => p.id);
  assert.strictEqual(st.activeId, b);                                      // creating B made it active
  st = profiles.upsert(st, { id: a, name: 'A2' });
  assert.deepStrictEqual([st.activeId, st.profiles[0].name], [b, 'A2']);   // editing A did not switch
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
test('chat list reads only the index, rebuilds it when missing, and keeps it in step with save/remove', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  fs.writeFileSync(path.join(dir, 'a1.json'), 'not json'); // list must not open chat files
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['b2', 'a1']);
  fs.rmSync(path.join(dir, '_index.json'));
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['b2']); // rebuilt by scanning; the corrupt chat is skipped
  assert.ok(fs.existsSync(path.join(dir, '_index.json')));
  await store.remove('b2');
  assert.deepStrictEqual(await store.list(), []);
  await assert.rejects(store.load('_index'), /Invalid chat id/);
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  fs.rmSync(dir, { recursive: true });
});

test('chat saves fired together all land in the index', async () => {
  const { dir, store } = tmpChats();
  await Promise.all(['a1', 'b2', 'c3', 'd4'].map((id, i) => store.save({ id, title: id, updated: i, messages: [] })));
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['d4', 'c3', 'b2', 'a1']);
  fs.rmSync(dir, { recursive: true });
});

test('disk: missing files read as null, names cannot leave the folder, writes leave no temp files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-')), d = makeDisk(path.join(dir, 'sub'));
  assert.strictEqual(await d.read('nope.json'), null);
  assert.deepStrictEqual(await d.list(), []); // folder not created yet
  await d.write('a.json', 'x'); assert.strictEqual(await d.read('a.json'), 'x');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'sub', 'a.json')).mode & 0o777, 0o600); // owner-only
  await d.rename('a.json', 'b.json'); assert.deepStrictEqual(await d.list(), ['b.json']);
  await d.remove('b.json'); await d.remove('b.json'); // removing twice is fine
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '']) await assert.rejects(d.read(bad), /Invalid file name/);
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
  const never = async () => { throw new Error('fetch failed'); };
  await assert.rejects(chatStream('http://x', '', 'm', [], {}, () => {}, never, pre.signal), /Stopped/);
});

test('a non-JSON reply gets a friendly error', async () => {
  const html = async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' });
  await assert.rejects(listModelsDetailed('http://x', '', html), /didn't return JSON/);
});

// ---- settings store ----
const makeStore = require('./store');
const rot = { available: () => true, enc: (t) => Buffer.from(t).toString('base64'), dec: (b) => Buffer.from(b, 'base64').toString() };
const tmpStore = (/** @type {import('./store').KeyCrypto} */ crypto = rot) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-')); const file = path.join(dir, 'settings.json'); return { dir, file, store: makeStore({ io: makeDisk(dir), crypto }) }; };

test('store: a damaged settings file is quarantined, not overwritten', async () => {
  const { dir, file, store } = tmpStore();
  fs.writeFileSync(file, '{"version":2,"profiles":[{"id":"p1","keyEnc":"abc"');
  assert.deepStrictEqual((await store.get()).profiles, []);
  assert.match(store.takeNotice(), /damaged/); assert.strictEqual(store.takeNotice(), '');
  assert.strictEqual(fs.readFileSync(file + '.bad', 'utf8'), '{"version":2,"profiles":[{"id":"p1","keyEnc":"abc"');
  // valid JSON that isn't a settings file this version understands: not an object, a broken v2, or a newer version
  for (const [i, text] of ['null', '[]', '{"version":2,"profiles":null}', '{"version":3,"profiles":[]}'].entries()) {
    fs.writeFileSync(file, text);
    assert.deepStrictEqual((await store.get()).profiles, []);
    assert.strictEqual(fs.readFileSync(`${file}.bad-${i + 2}`, 'utf8'), text);
    assert.match(store.takeNotice(), /damaged/);
  }
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  fs.rmSync(dir, { recursive: true });
});

test('store: saving a profile without `key` keeps the stored key; `key: ""` clears it; errors never wipe it', async () => {
  const { dir, store } = tmpStore();
  const st = await store.saveProfile({ name: 'P', endpoint: 'http://x/v1/', key: 'sk-1' });
  const id = st.activeId;
  assert.strictEqual(await store.key(id), 'sk-1'); assert.strictEqual(st.profiles[0].hasKey, true);
  await store.saveProfile({ id, name: 'Renamed', endpoint: 'http://x/v1' });
  assert.strictEqual(await store.key(id), 'sk-1');
  await assert.rejects(store.saveProfile({ id, endpoint: 'ftp://x' }), /http/);
  assert.strictEqual(await store.key(id), 'sk-1');
  await store.saveProfile({ id, name: 'Renamed', endpoint: 'http://x/v1', key: '' });
  assert.strictEqual(await store.key(id), '');
  fs.rmSync(dir, { recursive: true });
});

test('store: undecryptable key is a clear error, plaintext keys upgrade, patch never creates a profile', async () => {
  const { dir, file, store } = tmpStore();
  await assert.rejects(store.load(), /No profile yet/);
  await store.patch({ model: 'm' }); assert.deepStrictEqual((await store.get()).profiles, []);
  const id = (await store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' })).activeId;
  assert.strictEqual((await store.load()).key, 'sk-1');
  const broken = makeStore({ io: makeDisk(dir), crypto: { ...rot, dec: () => { throw new Error('locked'); } } });
  await assert.rejects(broken.load(), /Couldn't read the saved API key/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyEnc !== undefined, true); // still on disk
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.profiles[0] = { ...raw.profiles[0], keyEnc: undefined, keyPlain: 'sk-9' };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.strictEqual(await store.key(id), 'sk-9');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyEnc); // upgraded on read
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyPlain, undefined);
  await store.patch({ effort: 'high', model: 'gpt' }); const v = await store.get();
  assert.strictEqual(v.effort, 'high'); assert.strictEqual(v.profiles[0].model, 'gpt');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes; %APPDATA% is per-user
  fs.rmSync(dir, { recursive: true });
});

test('store: no keyring stores the key in the private file; async crypto works too', async () => {
  const { dir, file, store } = tmpStore({ ...rot, available: () => false });
  await store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyPlain, 'sk-1');
  const later = makeStore({ io: makeDisk(dir), crypto: { available: async () => true, enc: async (t) => rot.enc(t), dec: async (b) => rot.dec(b) } });
  assert.strictEqual((await later.load()).key, 'sk-1'); // and the key is upgraded once a keyring shows up
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles[0].keyEnc, rot.enc('sk-1'));
  fs.rmSync(dir, { recursive: true });
});

test('store: changes fired together are applied one after another, none is lost', async () => {
  const { dir, store } = tmpStore();
  await store.saveProfile({ name: 'P', endpoint: 'http://x' });
  const slow = makeStore({ io: { ...makeDisk(dir), read: async (n) => { await new Promise((r) => setTimeout(r, 5)); return makeDisk(dir).read(n); } }, crypto: rot });
  await Promise.all([slow.patch({ model: 'm1' }), slow.patch({ effort: 'high' }), slow.patch({ render: { html: false } }), slow.patch({ theme: { id: 'ocean' } }), slow.patch({ meta: true })]);
  const v = await store.get();
  assert.deepStrictEqual([v.profiles[0].model, v.effort, v.render.html, v.theme.id, v.profiles[0].meta], ['m1', 'high', false, 'ocean', true]);
  await assert.rejects(slow.activate('nope'), /Unknown profile/); // a failed call doesn't block the next one
  assert.strictEqual((await slow.get()).effort, 'high');
  fs.rmSync(dir, { recursive: true });
});

test('store: thinkingSwitch flag comes from the one regex in api.js', async () => {
  const { dir, store } = tmpStore();
  await store.saveProfile({ name: 'D', endpoint: 'https://api.deepseek.com/v1' });
  assert.strictEqual((await store.get()).profiles[0].thinkingSwitch, true);
  await store.saveProfile({ name: 'O', endpoint: 'https://api.openai.com/v1' });
  assert.strictEqual((await store.get()).profiles[1].thinkingSwitch, false);
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

test('Lib.editUser swaps the typed text and keeps inlined files and images', () => {
  const file = { kind: 'text', name: 'a.txt', text: 'x' }, img = { kind: 'image', url: 'data:image/png;base64,AA' };
  /** @type {[string, {kind: string}[]][]} */
  const cases = [['hi', []], ['hi', [file]], ['', [file]], ['', [img]], ['hi', [img]], ['hi', [file, img]]];
  const sent = (text, atts) => ({ role: 'user', text, content: Lib.buildContent(text, atts), files: atts.map(({ name, kind }) => ({ name, kind })) });
  for (const [from, atts] of cases) {
    for (const to of ['new text', '']) {
      if (!to && !atts.length) continue;
      const m = Lib.editUser(sent(from, atts), to);
      assert.deepStrictEqual(m, sent(to, atts), `${JSON.stringify(from)} -> ${JSON.stringify(to)} with ${atts.map((a) => a.kind)}`);
    }
  }
});

test('Lib.addVersion keeps every version and Lib.showVersion switches between them', () => {
  const a = { role: 'assistant', content: 'one', reasoning: 'r1' };
  const b = Lib.addVersion(a, { content: 'two', reasoning: undefined });
  assert.deepStrictEqual(b, { role: 'assistant', content: 'two', v: 1, versions: [{ content: 'one', reasoning: 'r1' }, { content: 'two' }] });
  assert.deepStrictEqual(a, { role: 'assistant', content: 'one', reasoning: 'r1' }); // the original is untouched, so a failed regenerate can restore it
  const back = Lib.showVersion(b, 0);
  assert.deepStrictEqual({ content: back.content, reasoning: back.reasoning, v: back.v }, { content: 'one', reasoning: 'r1', v: 0 });
  assert.strictEqual(Lib.showVersion(b, 9).v, 1);
  const c = Lib.addVersion(back, { content: 'three' });
  assert.deepStrictEqual([c.versions.length, c.v, c.content], [3, 2, 'three']);
  const u = Lib.addVersion({ role: 'user', text: 'hi', content: 'hi', files: [] }, { text: 'yo' });
  assert.deepStrictEqual(u.versions, [{ text: 'hi' }, { text: 'yo' }]);
  assert.deepStrictEqual(Lib.requestMessages({ messages: [u, c] }, null), [{ role: 'user', content: 'yo' }, { role: 'assistant', content: 'three' }]);
});

test('Lib.addVersion stores a user message\'s attachments once, not in every version', () => {
  const img = { kind: 'image', name: 'a.png', url: 'data:image/png;base64,AA' }, file = { kind: 'text', name: 'a.txt', text: 'x' };
  const sent = (text) => ({ role: 'user', text, content: Lib.buildContent(text, [file, img]), files: [{ name: 'a.txt', kind: 'text' }, { name: 'a.png', kind: 'image' }] });
  const edited = Lib.addVersion(sent('hi'), Lib.editUser(sent('hi'), 'yo'));
  assert.deepStrictEqual(edited.versions, [{ text: 'hi' }, { text: 'yo' }]); // no image data or file text in the versions
  assert.deepStrictEqual(Lib.showVersion(edited, 0), { ...sent('hi'), versions: edited.versions, v: 0 });
  assert.deepStrictEqual(Lib.showVersion(Lib.showVersion(edited, 0), 1), { ...sent('yo'), versions: edited.versions, v: 1 });
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

test('chats index keeps personaId', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, personaId: 'ps-1', messages: [] });
  assert.strictEqual((await store.list())[0].personaId, 'ps-1');
  fs.rmSync(path.join(dir, '_index.json'));
  assert.strictEqual((await store.list())[0].personaId, 'ps-1'); // survives an index rebuild
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

test('store: save/select/delete personas; Default cannot be deleted; unknown personaId is ignored', async () => {
  const { dir, store } = tmpStore();
  let v = await store.savePersona({ name: '', bot: ' Captain ', user: 'Dalton', prompt: 'Arr' });
  const id = v.personaId;
  assert.notStrictEqual(id, 'default');
  assert.deepStrictEqual(v.personas.find((p) => p.id === id), { id, name: 'Captain', user: 'Dalton', bot: 'Captain', prompt: 'Arr' });
  v = await store.savePersona({ id, name: 'Pirate', bot: 'Captain', user: 'Dalton', prompt: 'Arr!' });
  assert.strictEqual(v.personas.length, 2); assert.strictEqual(v.personas.find((p) => p.id === id).name, 'Pirate');
  assert.strictEqual((await store.patch({ personaId: 'default' })).personaId, 'default');
  assert.strictEqual((await store.patch({ personaId: 'nope' })).personaId, 'default');
  await assert.rejects(store.deletePersona('default'), /can't be deleted/);
  await store.patch({ personaId: id });
  v = await store.deletePersona(id);
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

test('Lib.requestMessages adds the display hint only when given render settings, after the persona prompt', () => {
  const chat = { messages: [{ role: 'user', content: 'hi', text: 'x' }] }, all = { markdown: true, html: true, css: true, js: true };
  assert.deepStrictEqual(Lib.requestMessages(chat, undefined, {}), [{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(Lib.requestMessages(chat, undefined, { render: all })[0], { role: 'system', content: Lib.renderHint(all) });
  const sys = /** @type {{content: string}} */ (Lib.requestMessages(chat, { user: '', bot: 'B', prompt: 'p' }, { render: all })[0]).content;
  assert.ok(sys.startsWith('You are B.') && sys.endsWith(Lib.renderHint(all)));
});

test('Lib.renderHint only mentions what is switched on', () => {
  const h = (o) => Lib.renderHint({ markdown: true, html: true, css: true, js: true, ...o });
  assert.match(h({}), /Markdown/); assert.match(h({}), /HTML with CSS and JavaScript/); assert.match(h({}), /CDN/);
  assert.match(h({ js: false }), /HTML with CSS directly/); assert.doesNotMatch(h({ js: false }), /JavaScript|CDN/);
  assert.match(h({ css: false, js: false }), /HTML only \(CSS and JavaScript are switched off\)/);
  assert.doesNotMatch(h({ html: false }), /HTML/); assert.match(h({ html: false }), /Markdown/);
  assert.match(h({ markdown: false }), /plain text, so do not use Markdown/);
  assert.match(h({}), /fenced code block/); assert.doesNotMatch(h({ markdown: false }), /fenced|code block/); // fences would show as literal backticks
  assert.match(h({ markdown: false, html: false }), /plain text\. Do not use Markdown or HTML/);
});

test('render setting: all on by default, old rich:false migrates, only booleans accepted', async () => {
  assert.deepStrictEqual(profiles.migrate({}).render, { markdown: true, html: true, css: true, js: true });
  assert.deepStrictEqual(profiles.migrate({ version: 2, profiles: [], rich: false }).render, { markdown: true, html: false, css: false, js: false });
  assert.deepStrictEqual(profiles.migrate({ version: 2, profiles: [], rich: false, render: { html: true } }).render, { markdown: true, html: true, css: false, js: false });
  const { dir, store } = tmpStore();
  assert.strictEqual((await store.get()).render.html, true);
  assert.strictEqual((await store.patch({ render: { html: false } })).render.html, false);
  assert.strictEqual((await store.patch({ render: { css: 'no', bogus: true } })).render.css, true); // ignored, not coerced
  assert.strictEqual('bogus' in (await store.get()).render, false);
  assert.deepStrictEqual((await store.patch({ render: { markdown: false, html: true } })).render, { markdown: false, html: true, css: true, js: true });
  fs.rmSync(dir, { recursive: true });
});

test('theme setting: solid Indigo by default; presets and valid custom colors accepted, anything else ignored', async () => {
  assert.deepStrictEqual(profiles.migrate({}).theme, { id: 'indigo', gradient: false });
  const { dir, file, store } = tmpStore();
  assert.strictEqual((await store.patch({ theme: { id: 'sunset' } })).theme.id, 'sunset');
  assert.strictEqual((await store.patch({ theme: { id: 'nope' } })).theme.id, 'sunset');
  assert.strictEqual((await store.patch({ theme: { id: 'custom', a1: 'red', a2: '#123456' } })).theme.id, 'sunset');
  assert.strictEqual((await store.patch({ theme: { id: 'custom', a1: '#ABCDEF', a2: '#123456', evil: '<x>' } })).theme.id, 'custom');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).theme, { id: 'custom', a1: '#abcdef', a2: '#123456', gradient: false });
  fs.writeFileSync(file, JSON.stringify({ version: 2, profiles: [], theme: { id: 'custom', a1: 'url(javascript:1)', a2: '#fff' } }));
  assert.deepStrictEqual((await store.get()).theme, { id: 'indigo', gradient: false }); // a damaged theme falls back instead of reaching the CSS
  fs.rmSync(dir, { recursive: true });
});

test('theme gradient: only true turns it on, it survives a preset change, and old Aurora saves move to the default once', async () => {
  const { dir, file, store } = tmpStore();
  assert.deepStrictEqual((await store.patch({ theme: { id: 'ocean', gradient: true } })).theme, { id: 'ocean', gradient: true });
  assert.deepStrictEqual((await store.patch({ theme: { id: 'rose', gradient: true } })).theme, { id: 'rose', gradient: true });
  assert.deepStrictEqual((await store.patch({ theme: { id: 'rose', gradient: 'yes' } })).theme, { id: 'rose', gradient: false });
  fs.writeFileSync(file, JSON.stringify({ version: 2, profiles: [], theme: { id: 'aurora' } })); // saved before the switch existed
  assert.deepStrictEqual((await store.get()).theme, { id: 'indigo', gradient: false });
  assert.deepStrictEqual((await store.patch({ theme: { id: 'aurora', gradient: false } })).theme, { id: 'aurora', gradient: false });
  assert.deepStrictEqual((await store.get()).theme, { id: 'aurora', gradient: false }); // picked again after the move, so it sticks
  fs.rmSync(dir, { recursive: true });
});

test('every preset theme keeps white text at least as readable as the weakest end of Aurora (3.68:1)', () => {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const contrastWhite = (h) => 1.05 / (lum(h) + .05);
  const aurora = Lib.THEMES.find((t) => t.id === 'aurora'), floor = Math.min(contrastWhite(aurora.a1), contrastWhite(aurora.a2));
  for (const t of Lib.THEMES) for (const c of [t.a1, t.a2]) assert.ok(contrastWhite(c) >= floor, `${t.name} ${c} contrast ${contrastWhite(c).toFixed(2)} < ${floor.toFixed(2)}`);
});

test('Lib.richDoc: the color and scheme can never break out of the page head', async () => {
  const { doc, csp } = await Lib.richDoc('<b>hi</b>', 'red;}</style><script>alert(1)</script>', 'evil');
  assert.match(doc, /color:#888/); assert.match(doc, /color-scheme:dark/); assert.ok(!doc.includes('alert(1)'));
  assert.strictEqual(csp, 'sandbox allow-scripts'); // everything on: only the sandbox
  assert.match((await Lib.richDoc('x', 'rgb(1, 2, 3)', 'light')).doc, /color:rgb\(1, 2, 3\).*<body>x<script>/s);
  assert.match((await Lib.richDoc('x', '#fff', 'light')).doc, /content="light"/);
});

test('Lib.richDoc: with CSS or JavaScript off, the CSP allows only the page\'s own style and resize script, by hash', async () => {
  const hash = (s) => `'sha256-${require('node:crypto').createHash('sha256').update(s).digest('base64')}'`;
  const { doc, csp } = await Lib.richDoc('<p>x</p>', '#fff', 'dark', { css: false, js: false });
  const style = /<style>(.*?)<\/style>/.exec(doc)[1], script = /<script>(.*?)<\/script>/s.exec(doc)[1];
  assert.strictEqual(csp, `sandbox allow-scripts; style-src ${hash(style)}; script-src ${hash(script)}; frame-src 'none'; object-src 'none'`);
  assert.strictEqual((await Lib.richDoc('x', '#fff', 'dark', { css: false })).csp, `sandbox allow-scripts; style-src ${hash(style)}`);
  assert.ok(!(await Lib.richDoc('x', '#fff', 'dark', { js: false })).csp.includes('style-src'));
});

test('migrateLegacy: moves settings and chats once, never overwrites the new folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), from = path.join(root, 'chatbot'), to = path.join(root, 'javc-chatbot');
  assert.deepStrictEqual(migrateLegacy(from, to), []); // no legacy folder: nothing happens
  assert.ok(!fs.existsSync(to));
  fs.mkdirSync(path.join(from, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(from, 'settings.json'), '{"old":1}'); fs.writeFileSync(path.join(from, 'chats', 'a.json'), '{}');
  fs.mkdirSync(path.join(to, 'Crashpad'), { recursive: true }); // Electron may create the new folder first
  assert.deepStrictEqual(migrateLegacy(from, to), ['settings.json', 'chats']);
  assert.strictEqual(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"old":1}');
  assert.ok(fs.existsSync(path.join(to, 'chats', 'a.json')) && !fs.existsSync(path.join(from, 'settings.json')));
  fs.writeFileSync(path.join(from, 'settings.json'), '{"stale":1}'); // target already set up: leave both sides alone
  assert.deepStrictEqual(migrateLegacy(from, to), []);
  assert.strictEqual(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"old":1}');
  assert.ok(fs.existsSync(path.join(from, 'settings.json')));
  fs.rmSync(root, { recursive: true });
});

// ---- Android: the native plugin adapters (mobile/native.js), driven by a fake plugin ----
const { makeNativeFetch, makeNativeDisk, makeNativeCrypto } = require('./mobile/native');

// respond(req, send) returns the head ({status, headers}) or throws; send(ev) emits an "http" event for this request.
function fakeHttp(respond) {
  const listeners = [], aborted = [], seen = [];
  /** @type {any} */
  const plugin = {
    addListener: async (name, fn) => { assert.strictEqual(name, 'http'); listeners.push(fn); return { remove() {} }; },
    httpStart: async (req) => { seen.push(req); return respond(req, (ev) => setTimeout(() => listeners.forEach((l) => l({ id: req.id, ...ev })), 0)); },
    httpAbort: async ({ id }) => { aborted.push(id); },
  };
  return { fetch: makeNativeFetch(plugin), aborted, seen };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sendInPieces = (send, text, size = 5) => { const b = Buffer.from(text); for (let i = 0; i < b.length; i += size) send({ type: 'data', data: b.subarray(i, i + size).toString('base64') }); send({ type: 'end' }); };

test('native fetch: chatStream streams through the plugin, even with characters split across chunks', async () => {
  const { fetch, seen } = fakeHttp((req, send) => {
    sendInPieces(send, frames([{ reasoning_content: 'hmm… ' }, { content: 'Grüße ' }, { content: '🙂' }]));
    return { status: 200, headers: { 'content-type': 'text/event-stream' } };
  });
  const deltas = [];
  const out = await chatStream('https://x/v1/', 'k', 'm', [{ role: 'user', content: 'hi' }], {}, (d) => deltas.push(d), fetch);
  assert.deepStrictEqual([out.reasoning, out.content], ['hmm… ', 'Grüße 🙂']);
  assert.ok(deltas.length >= 3);
  assert.strictEqual(seen[0].url, 'https://x/v1/chat/completions'); assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[0].headers.Authorization, 'Bearer k'); assert.strictEqual(JSON.parse(seen[0].body).stream, true);
});

test('native fetch: error bodies, network failures and empty responses behave like fetch', async () => {
  const bad = fakeHttp((req, send) => { send({ type: 'data', data: b64('{"error":"bad key"}') }); send({ type: 'end' }); return { status: 401, headers: {} }; });
  await assert.rejects(listModelsDetailed('http://x', 'k', bad.fetch), /HTTP 401: \{"error":"bad key"\}/);
  assert.strictEqual(bad.seen[0].body, null); assert.strictEqual(bad.seen[0].method, 'GET');
  const down = fakeHttp(() => { throw new Error('Unable to resolve host "x"'); });
  await assert.rejects(down.fetch('http://x'), (e) => e instanceof TypeError && /resolve host/.test(e.message));
  const empty = fakeHttp(() => ({ status: 204, headers: { 'x-a': '1' } }));
  const res = await empty.fetch('http://x'); assert.strictEqual(res.status, 204); assert.strictEqual(res.body, null); assert.strictEqual(res.headers.get('x-a'), '1');
  const broken = fakeHttp((req, send) => { send({ type: 'data', data: b64('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n') }); send({ type: 'error', message: 'connection reset' }); return { status: 200, headers: { 'content-type': 'text/event-stream' } }; });
  const out = await chatStream('http://x', '', 'm', [], {}, () => {}, broken.fetch);
  assert.strictEqual(out.content, 'Hel'); assert.match(out.error, /connection reset/);
});

test('native fetch: Stop works before the server answers and while the reply streams', async () => {
  const early = fakeHttp(() => new Promise(() => {})); // the server never answers
  const ctl = new AbortController();
  const p = chatStream('http://x', '', 'm', [], {}, () => {}, early.fetch, ctl.signal);
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, /Stopped/);
  assert.strictEqual(early.aborted.length, 1);

  let sendLater;
  const late = fakeHttp((req, send) => { send({ type: 'data', data: b64(frames([{ content: 'Partial' }]).replace('data: [DONE]\n\n', '')) }); sendLater = send; return { status: 200, headers: { 'content-type': 'text/event-stream' } }; });
  const ctl2 = new AbortController(), got = [];
  const p2 = chatStream('http://x', '', 'm', [], {}, (d) => { got.push(d); ctl2.abort(); }, late.fetch, ctl2.signal);
  const out = await p2;
  assert.strictEqual(out.content, 'Partial'); assert.strictEqual(out.stopped, true);
  assert.strictEqual(late.aborted.length, 1);
  sendLater({ type: 'data', data: b64('ignored') }); sendLater({ type: 'end' }); // late events for a stopped request are dropped
  await new Promise((r) => setTimeout(r, 5));
  const pre = new AbortController(); pre.abort();
  await assert.rejects(late.fetch('http://x', { signal: pre.signal }), { name: 'AbortError' });
});

// An in-memory stand-in for the plugin's private files and Keystore.
function fakeFiles() {
  const files = new Map(), dirOf = (p) => p.split('/').slice(0, -1).join('/');
  return {
    files,
    fsRead: async ({ path: p }) => (files.has(p) ? { exists: true, text: files.get(p) } : { exists: false }),
    fsWrite: async ({ path: p, text }) => { files.set(p, text); },
    fsRemove: async ({ path: p }) => { files.delete(p); },
    fsList: async ({ path: d }) => ({ names: [...files.keys()].filter((p) => dirOf(p) === d).map((p) => p.split('/').pop()) }),
    fsRename: async ({ from, to }) => { if (!files.has(from)) throw new Error('missing'); files.set(to, files.get(from)); files.delete(from); },
    cryptoAvailable: async () => ({ available: true }),
    encrypt: async ({ text }) => ({ data: 'enc:' + b64(text) }),
    decrypt: async ({ data }) => { if (!data.startsWith('enc:')) throw new Error('bad tag'); return { text: Buffer.from(data.slice(4), 'base64').toString() }; },
  };
}

test('native disk + crypto: settings and chats work the same as on the desktop', async () => {
  const fake = fakeFiles();
  const store = makeStore({ io: makeNativeDisk(fake), crypto: makeNativeCrypto(fake) });
  const id = (await store.saveProfile({ name: 'P', endpoint: 'http://192.168.1.5:11434/v1', key: 'sk-1' })).activeId;
  assert.strictEqual((await store.load()).key, 'sk-1');
  assert.match(JSON.parse(fake.files.get('settings.json')).profiles[0].keyEnc, /^enc:/);
  fake.files.set('settings.json', '{broken'); assert.deepStrictEqual((await store.get()).profiles, []);
  assert.ok(fake.files.has('settings.json.bad')); assert.match(store.takeNotice(), /damaged/);
  assert.notStrictEqual(id, undefined);

  const chats = makeChats(makeNativeDisk(fake, 'chats'));
  await chats.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  await chats.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  assert.deepStrictEqual((await chats.list()).map((c) => c.id), ['b2', 'a1']);
  assert.ok(fake.files.has('chats/a1.json') && fake.files.has('chats/_index.json'));
  fake.files.delete('chats/_index.json');
  assert.deepStrictEqual((await chats.list()).map((c) => c.id), ['b2', 'a1']); // rebuilt from the chat files
  await assert.rejects(makeNativeDisk(fake, 'chats').read('../settings.json'), /Invalid file name/);
});

test('native crypto: a failing Keystore self-test means keys stay in private storage, and is only tried once', async () => {
  const fake = fakeFiles(); let tries = 0;
  fake.cryptoAvailable = async () => { tries++; throw new Error('KeyStoreException'); };
  const store = makeStore({ io: makeNativeDisk(fake), crypto: makeNativeCrypto(fake) });
  await store.saveProfile({ name: 'P', endpoint: 'https://x', key: 'sk-2' });
  await store.get(); await store.load();
  assert.strictEqual(JSON.parse(fake.files.get('settings.json')).profiles[0].keyPlain, 'sk-2');
  assert.strictEqual(tries, 1);
});

// ---- Review fixes: storage that survives interruptions and read errors ----
test('chat list follows the files: a chat missing from the index appears, a deleted file disappears', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  await store.save({ id: 'b2', title: 'B', updated: 2, messages: [] });
  fs.rmSync(path.join(dir, 'b2.json')); // as if the app stopped between deleting the file and updating the index
  fs.writeFileSync(path.join(dir, 'c3.json'), JSON.stringify({ id: 'c3', title: 'C', updated: 3, messages: [] })); // saved, index not yet updated
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['c3', 'a1']);
  assert.deepStrictEqual(JSON.parse(await sealFor(dir).io.read('_index.json')).map((c) => c.id).sort(), ['a1', 'c3']); // repaired on disk (read as a second launch would)
  const before = fs.statSync(path.join(dir, '_index.json')).mtimeMs;
  await store.list(); assert.strictEqual(fs.statSync(path.join(dir, '_index.json')).mtimeMs, before); // nothing changed: not rewritten
  fs.rmSync(dir, { recursive: true });
});

test('store: a read error leaves settings.json alone instead of treating it as damaged', async () => {
  const { dir, file, store } = tmpStore();
  await store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' });
  const flaky = makeStore({ io: { ...makeDisk(dir), read: async () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); } }, crypto: rot });
  await assert.rejects(flaky.get(), /EBUSY/);
  assert.ok(!fs.existsSync(file + '.bad')); assert.strictEqual(flaky.takeNotice(), '');
  assert.strictEqual((await store.load()).key, 'sk-1'); // still there once reading works again
  fs.rmSync(dir, { recursive: true });
});

test('store: a second damaged settings file never overwrites the first backup', async () => {
  const { dir, file, store } = tmpStore();
  fs.writeFileSync(file, '{first'); await store.get();
  fs.writeFileSync(file, '{second'); await store.get();
  assert.strictEqual(fs.readFileSync(file + '.bad', 'utf8'), '{first');
  assert.strictEqual(fs.readFileSync(file + '.bad-2', 'utf8'), '{second');
  assert.match(store.takeNotice(), /settings\.json\.bad-2/);
  fs.rmSync(dir, { recursive: true });
});

test('store: reading without a settings file writes nothing until something is saved', async () => {
  const { dir, file, store } = tmpStore();
  assert.deepStrictEqual((await store.get()).profiles, []);
  assert.ok(!fs.existsSync(file));
  await store.patch({ effort: 'low' });
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true });
});

test('migrateLegacy: an interrupted move is finished on a later launch, merging chats without overwriting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), from = path.join(root, 'chatbot'), to = path.join(root, 'javc-chatbot');
  fs.mkdirSync(path.join(from, 'chats'), { recursive: true }); fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'settings.json'), '{"new":1}'); // settings already moved, then the app stopped
  fs.writeFileSync(path.join(from, 'chats', 'a.json'), '{"a":1}');
  assert.deepStrictEqual(migrateLegacy(from, to), ['chats']); // the chats left behind still move
  assert.strictEqual(fs.readFileSync(path.join(to, 'chats', 'a.json'), 'utf8'), '{"a":1}');
  fs.mkdirSync(path.join(from, 'chats')); // an older copy that shows up again, next to chats the new folder already has
  fs.writeFileSync(path.join(from, 'chats', 'a.json'), '{"old":1}'); fs.writeFileSync(path.join(from, 'chats', 'b.json'), '{"b":1}');
  fs.writeFileSync(path.join(from, 'chats', '_index.json'), '[]');
  assert.deepStrictEqual(migrateLegacy(from, to), [path.join('chats', 'b.json')]);
  assert.strictEqual(fs.readFileSync(path.join(to, 'chats', 'a.json'), 'utf8'), '{"a":1}'); // never overwritten
  assert.ok(!fs.existsSync(path.join(to, 'chats', '_index.json'))); // the old index stays behind; chats.js rebuilds its own
  fs.rmSync(root, { recursive: true });
});

test('native fetch: a 204 response leaves nothing behind and asks the plugin to abort nothing', async () => {
  for (const status of [204, 205, 304]) {
    const h = fakeHttp((req, send) => { send({ type: 'end' }); return { status, headers: {} }; });
    const res = await h.fetch('http://x');
    assert.strictEqual(res.status, status); assert.strictEqual(res.body, null);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(h.aborted, []);
  }
});

test('Lib.fitSize scales the long side down to the limit, keeps the shape, and never enlarges', () => {
  assert.deepStrictEqual(Lib.fitSize(4000, 3000, 2048), { w: 2048, h: 1536, scaled: true });
  assert.deepStrictEqual(Lib.fitSize(3000, 4000, 2048), { w: 1536, h: 2048, scaled: true });
  assert.deepStrictEqual(Lib.fitSize(800, 600, 2048), { w: 800, h: 600, scaled: false });
  assert.deepStrictEqual(Lib.fitSize(2048, 2048, 2048), { w: 2048, h: 2048, scaled: false });
  assert.deepStrictEqual(Lib.fitSize(100000, 10, 2048), { w: 2048, h: 1, scaled: true }); // never 0 px
});

test('chat list skips a chat file whose id does not match its name, and leaves the index alone after that', async () => {
  const { dir, store } = tmpChats();
  await store.save({ id: 'a1', title: 'A', updated: 1, messages: [] });
  fs.writeFileSync(path.join(dir, 'b2.json'), JSON.stringify({ title: 'no id', updated: 2, messages: [] }));
  fs.writeFileSync(path.join(dir, 'c3.json'), JSON.stringify({ id: 'zz', title: 'wrong id', updated: 3, messages: [] }));
  assert.deepStrictEqual((await store.list()).map((c) => c.id), ['a1']);
  const before = fs.readFileSync(path.join(dir, '_index.json'), 'utf8');
  await store.list(); assert.strictEqual(fs.readFileSync(path.join(dir, '_index.json'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true });
});

test('migrateLegacy: an item that cannot move does not hold back the others, and is retried', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), from = path.join(root, 'chatbot'), to = path.join(root, 'javc-chatbot');
  fs.mkdirSync(path.join(from, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(from, 'settings.json'), '{"old":1}'); fs.writeFileSync(path.join(from, 'chats', 'a.json'), '{}');
  const rename = fs.renameSync; // settings.json is locked this time
  fs.renameSync = (/** @type {string} */ a, b) => { if (a.endsWith('settings.json')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return rename(a, b); };
  try { assert.throws(() => migrateLegacy(from, to), (e) => e instanceof AggregateError && /Moved chats/.test(e.message)); }
  finally { fs.renameSync = rename; }
  assert.ok(fs.existsSync(path.join(to, 'chats', 'a.json'))); // the chats still moved
  assert.deepStrictEqual(migrateLegacy(from, to), ['settings.json']); // and settings follow on the next launch
  fs.rmSync(root, { recursive: true });
});

// ---- web search (Linkup) ----
const toolFrames = (pieces) => frames(pieces.map((tool_calls) => ({ tool_calls })));
// Routes by URL: Linkup calls are answered by `linkup`, chat calls pop the next reply from `replies` and are recorded in `chats`.
const searchFetch = (replies, linkup, chats = [], hits = []) => async (url, opts) => {
  if (url.startsWith('https://api.linkup.so')) { hits.push({ url, opts }); return linkup(); }
  chats.push(JSON.parse(opts.body));
  return sse(replies.shift())(url, opts);
};
const linkupOk = (results) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results }) });

test('web search: streamed tool call runs one Linkup search, then the model answers from it', async () => {
  const chats = [], hits = [], deltas = [];
  const replies = [
    toolFrames([[{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '' } }], [{ index: 0, function: { arguments: '{"query":"paris ' } }], [{ index: 0, function: { arguments: 'weather"}' } }]]),
    frames([{ content: 'Sunny.' }]),
  ];
  const results = [{ type: 'text', name: 'Meteo', url: 'https://m.example', content: 'Sunny, 21C', favicon: '' }, { type: 'image', name: 'pic', url: 'https://i.example' }];
  const out = await chatStream('http://x', 'k', 'm', [{ role: 'user', content: 'weather?' }], {}, (d) => deltas.push(d), searchFetch(replies, linkupOk(results), chats, hits), undefined, { key: 'lk-1' });
  assert.deepStrictEqual(out, { content: 'Sunny.', reasoning: 'Searching the web: paris weather\n' });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].url, 'https://api.linkup.so/v1/search');
  assert.strictEqual(hits[0].opts.headers.Authorization, 'Bearer lk-1');
  assert.deepStrictEqual(JSON.parse(hits[0].opts.body), { q: 'paris weather', depth: 'fast', outputType: 'searchResults', maxResults: 5 });
  assert.strictEqual(chats[0].tools[0].function.name, 'web_search'); assert.strictEqual(chats[0].tool_choice, 'auto');
  const [, asst, tool] = chats[1].messages;
  assert.deepStrictEqual(asst.tool_calls[0], { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"paris weather"}' } });
  assert.strictEqual(tool.role, 'tool'); assert.strictEqual(tool.tool_call_id, 'c1');
  assert.match(tool.content, /Meteo\nhttps:\/\/m\.example\nSunny, 21C/); assert.ok(!tool.content.includes('pic')); // image results are left out
  assert.ok(deltas.some((d) => d.reasoning.startsWith('Searching the web')));
});

test('web search: without a search key nothing changes (no tools in the request)', async () => {
  const seen = {};
  await chatStream('http://x', '', 'm', [], {}, () => {}, sse(frames([{ content: 'hi' }]), seen));
  assert.strictEqual('tools' in JSON.parse(seen.opts.body), false);
});

test('web search: after the round cap the model must answer (tool_choice none), and a failed search becomes tool text', async () => {
  const chats = [], call = toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]);
  const replies = [call, call, call, call, call]; // keeps asking forever
  const bad = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const out = await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch(replies, bad, chats), undefined, { key: 'lk' });
  assert.strictEqual(chats.length, 5); // 4 search rounds + the forced final one
  assert.strictEqual(chats[3].tool_choice, 'auto'); assert.strictEqual(chats[4].tool_choice, 'none'); assert.ok(chats[4].tools);
  assert.match(chats[1].messages.at(-1).content, /Search failed: Linkup HTTP 500/);
  assert.strictEqual(out.content, '');
});

test('web search: bad tool arguments are reported to the model and never reach Linkup', async () => {
  const chats = [], hits = [];
  const replies = [toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{oops' } }]]), frames([{ content: 'ok' }])];
  const out = await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch(replies, linkupOk([]), chats, hits), undefined, { key: 'lk' });
  assert.strictEqual(out.content, 'ok');
  assert.strictEqual(chats[1].messages[0].tool_calls[0].id, 'c');
  assert.deepStrictEqual(chats[1].messages[1], { role: 'tool', tool_call_id: 'c', content: 'Error: call web_search with a JSON object like {"query": "..."}.' });
  assert.strictEqual(hits.length, 0);
});

test('web search: Stop while a Linkup request is in flight cancels it and stops the reply', async () => {
  const ctl = new AbortController();
  let listening; const registered = new Promise((ok) => { listening = ok; });
  const f = (url, opts) => (url.startsWith('https://api.linkup.so')
    ? new Promise((_, no) => { opts.signal.addEventListener('abort', () => no(new Error('fetch failed'))); listening(); }) // pending until aborted
    : sse(toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]))(url, opts));
  const run = chatStream('http://x', 'k', 'm', [], {}, () => {}, f, ctl.signal, { key: 'lk' });
  const settled = assert.rejects(run, /Stopped/);
  await registered; // the request is now pending, not merely about to start
  ctl.abort();
  await settled;
});

test('web search: reasoning_content goes back with tool calls only on thinking-mode providers', async () => {
  const call = () => toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]).replace('data: {"choices"', `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'plan the search' } }] })}\n\ndata: {"choices"`);
  for (const [endpoint, expected] of [['https://api.deepseek.com/v1', 'plan the search'], ['https://api.openai.com/v1', undefined]]) {
    const chats = [];
    await chatStream(endpoint, 'k', 'm', [], {}, () => {}, searchFetch([call(), frames([{ content: 'done' }])], linkupOk([]), chats), undefined, { key: 'lk' });
    assert.strictEqual(chats[1].messages[0].reasoning_content, expected, endpoint);
  }
});

test('web search: at most four Linkup requests per reply, even with parallel calls; extra calls get a limit message', async () => {
  const chats = [], hits = [];
  const two = toolFrames([[{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{"query":"one"}' } }, { index: 1, id: 'b', function: { name: 'web_search', arguments: '{"query":"two"}' } }]]);
  const out = await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch([two, two, two, frames([{ content: 'ok' }])], linkupOk([]), chats, hits), undefined, { key: 'lk' });
  assert.strictEqual(out.content, 'ok');
  assert.strictEqual(hits.length, 4); // 3 rounds x 2 calls = 6 requested
  const tools = chats[3].messages.filter((m) => m.role === 'tool');
  assert.strictEqual(tools.length, 6);
  assert.deepStrictEqual(tools.slice(4).map((m) => m.content), ['Search limit reached. Answer with what you already have.', 'Search limit reached. Answer with what you already have.']);
});

test('web search: the "model has no tools" flag is remembered per profile, booleans only', async () => {
  const { dir, store } = tmpStore();
  await store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' });
  assert.strictEqual((await store.get()).profiles[0].noTools, false);
  assert.strictEqual((await store.patch({ model: 'm', noTools: true })).profiles[0].noTools, true);
  assert.strictEqual((await store.patch({ noTools: 'yes' })).profiles[0].noTools, true); // not a boolean: ignored
  assert.strictEqual((await store.patch({ noTools: false })).profiles[0].noTools, false);
  fs.rmSync(dir, { recursive: true });
});

test('web search: a non-streaming reply with message.tool_calls works too', async () => {
  const chats = [], first = JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }] } }] });
  const second = JSON.stringify({ choices: [{ message: { content: 'done' } }] });
  const replies = [first, second];
  const f = async (url, opts) => (url.startsWith('https://api.linkup.so') ? linkupOk([])() : (chats.push(JSON.parse(opts.body)), sse(replies.shift(), {}, 'application/json')(url, opts)));
  assert.strictEqual((await chatStream('http://x', 'k', 'm', [], {}, () => {}, f, undefined, { key: 'lk' })).content, 'done');
  assert.strictEqual(chats[1].messages.at(-1).content, 'No results.');
});

test('web search: models whose list omits `tools` are flagged tools:false', async () => {
  const data = [{ id: 'a', supported_parameters: ['temperature'] }, { id: 'b', supported_parameters: ['tools', 'temperature'] }, { id: 'c' }];
  const [a, b, c] = await listModelsDetailed('http://x', '', fake(200, { data }));
  assert.strictEqual(a.tools, false); assert.strictEqual('tools' in b, false); assert.strictEqual('tools' in c, false);
});

test('web search settings: off by default, key encrypted and never exposed, keep/clear rules, plaintext key upgrades', async () => {
  const { dir, file, store } = tmpStore();
  assert.deepStrictEqual((await store.get()).search, { enabled: false, hasKey: false });
  await store.saveProfile({ name: 'P', endpoint: 'http://x', key: 'sk-1' });
  assert.strictEqual((await store.load({ search: true })).search, null);
  const v = await store.saveSearch({ enabled: true, key: 'lk-1' });
  assert.deepStrictEqual(v.search, { enabled: true, hasKey: true });
  assert.ok(!JSON.stringify(v).includes('lk-1') && !JSON.stringify(await store.get()).includes('lk-1'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('lk-1')); // stored encrypted
  assert.strictEqual(await store.searchKey(), 'lk-1'); assert.strictEqual((await store.load({ search: true })).search.key, 'lk-1');
  assert.strictEqual((await store.load()).search, null); // not asked for: not decrypted
  await store.saveSearch({ enabled: false }); // no `key` field: the stored key stays
  assert.strictEqual(await store.searchKey(), 'lk-1'); assert.strictEqual((await store.load({ search: true })).search, null);
  await store.patch({ effort: 'low', theme: { id: 'rose' } }); assert.strictEqual((await store.get()).search.hasKey, true); // other saves don't drop it
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.search = { enabled: true, keyPlain: 'lk-9' }; fs.writeFileSync(file, JSON.stringify(raw));
  assert.strictEqual(await store.searchKey(), 'lk-9');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).search.keyEnc); assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).search.keyPlain, undefined);
  await store.saveSearch({ key: '' }); assert.strictEqual(await store.searchKey(), ''); assert.strictEqual((await store.get()).search.hasKey, false);
  await store.saveSearch({ enabled: true, key: 'lk-2' });
  const broken = makeStore({ io: makeDisk(dir), crypto: { ...rot, dec: (b) => { if (b === rot.enc('lk-2')) throw new Error('locked'); return rot.dec(b); } } }); // only the search key is unreadable
  await assert.rejects(broken.load({ search: true }), /Couldn't read the saved search key/);
  assert.strictEqual((await broken.load()).key, 'sk-1'); // model refresh and chats without search still work
  fs.rmSync(dir, { recursive: true });
});

// ---- Stats for nerds ----
const usageFrame = (u) => `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
const U = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

test('chatStream asks for usage and keeps it from the stream and from plain JSON', async () => {
  const seen = {};
  const out = await chatStream('http://x', '', 'm', [], {}, () => {}, sse(frames([{ content: 'hi' }]).replace('data: [DONE]', usageFrame(U(10, 5)) + 'data: [DONE]'), seen));
  assert.deepStrictEqual(out, { content: 'hi', reasoning: '', usage: U(10, 5) });
  assert.deepStrictEqual(JSON.parse(seen.opts.body).stream_options, { include_usage: true });
  const json = JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: U(3, 2) });
  assert.deepStrictEqual((await chatStream('http://x', '', 'm', [], {}, () => {}, sse(json, {}, 'application/json'))).usage, U(3, 2));
});

test('chatStream retries without stream_options on a 400/422, even when the error does not name it, and remembers only a retry that works', async () => {
  const bodies = [];
  const strict = async (url, opts) => { // rejects the field with a generic message, as some proxies do
    const b = JSON.parse(opts.body); bodies.push(b);
    return b.stream_options ? { ok: false, status: 422, text: async () => '{"error":"Invalid request body"}' } : sse(frames([{ content: 'ok' }]))(url, opts);
  };
  assert.strictEqual((await chatStream('http://strict', '', 'm', [], {}, () => {}, strict)).content, 'ok');
  await chatStream('http://strict', '', 'm', [], {}, () => {}, strict); // remembered: the next reply asks once, without the field
  assert.deepStrictEqual(bodies.map((b) => 'stream_options' in b), [true, false, false]);
  // A real error fails on the retry too: it is reported, and the endpoint keeps asking for usage
  const sent = [], bad = async (url, opts) => { sent.push('stream_options' in JSON.parse(opts.body)); return fake(400, { error: 'bad level' })(url, opts); };
  await assert.rejects(chatStream('http://bad', '', 'm', [], {}, () => {}, bad), /HTTP 400: .*bad level/);
  await assert.rejects(chatStream('http://bad', '', 'm', [], {}, () => {}, bad), /HTTP 400/);
  assert.deepStrictEqual(sent, [true, false, true, false]);
  const auth = []; // other errors are not retried
  await assert.rejects(chatStream('http://auth', '', 'm', [], {}, () => {}, async (...a) => { auth.push(1); return fake(401, { error: 'bad key' })(...a); }), /HTTP 401/);
  assert.strictEqual(auth.length, 1);
});

test('web search: the search note is marked, so stats can tell it from the model', async () => {
  const call = toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]), deltas = [];
  await chatStream('http://x', 'k', 'm', [], {}, (d) => deltas.push(d), searchFetch([call, frames([{ content: 'done' }])], linkupOk([])), undefined, { key: 'lk' });
  assert.deepStrictEqual(deltas.map((d) => !!d.note), [true, false]);
});

test('web search: usage adds up over rounds, ctx is the last round', async () => {
  const call = toolFrames([[{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]);
  const withUsage = (f, u) => f.replace('data: [DONE]', usageFrame(u) + 'data: [DONE]');
  const out = await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch([withUsage(call, U(10, 2)), withUsage(frames([{ content: 'done' }]), U(30, 5))], linkupOk([])), undefined, { key: 'lk' });
  assert.deepStrictEqual(out.usage, U(40, 7)); assert.strictEqual(out.ctx, 35);
  assert.strictEqual(out.sent, 10); // the first round's prompt: the chat as sent, without the search results added later
});

test('replyStats: timings and tokens from usage, or an estimate without it', () => {
  assert.deepStrictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 400, t2: 2400, usage: U(100, 50), text: 'x' }),
    { model: 'a', ttft: 400, tps: 25, out: 50, total: 150, ctx: 150, prompt: 100 });
  assert.strictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 1, t2: 2, sent: 10, usage: U(40, 7), text: '' }).prompt, 10); // search: the first round's prompt
  assert.deepStrictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 1000, t2: 2000, ctx: 99, usage: U(10, 20), text: '' }).ctx, 99);
  const est = Lib.replyStats({ model: 'a', t0: 0, t1: 100, t2: 1100, text: 'x'.repeat(40) });
  assert.deepStrictEqual([est.out, est.tps, est.total, est.est], [10, 10, null, true]);
  assert.strictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 500, t2: 500, usage: U(1, 1), text: '' }).tps, null); // arrived in one piece
  assert.strictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 0, t2: 500, text: '' }).ttft, null); // no text at all
  const zero = Lib.replyStats({ model: 'a', t0: 0, t1: 0, t2: 500, usage: U(50, 0), text: '' }); // a real count of 0 is not an estimate
  assert.deepStrictEqual([zero.out, zero.est, zero.total], [0, undefined, 50]);
});

test('replyStats: hidden reasoning tokens and web-search waits are left out of the speed', () => {
  const hidden = { ...U(10, 2100), completion_tokens_details: { reasoning_tokens: 2000 } }; // thought for 20 s unseen, then 100 tokens in 2 s
  assert.strictEqual(Lib.replyStats({ model: 'o', t0: 0, t1: 20000, t2: 22000, usage: hidden, text: '', sawReasoning: false }).tps, 50);
  assert.strictEqual(Lib.replyStats({ model: 'o', t0: 0, t1: 1000, t2: 22000, usage: hidden, text: '', sawReasoning: true }).tps, 100); // streamed: it counts
  assert.strictEqual(Lib.replyStats({ model: 'a', t0: 0, t1: 1000, t2: 5000, paused: 3000, usage: U(10, 100), text: '' }).tps, 100); // 3 s waiting on a search
});

test('chatStats: filtered averages, reply numbers, last reply, running token total, context size', () => {
  const st = (model, ttft, tps, total, more) => ({ model, ttft, tps, out: 1, total, ctx: total, ...more });
  let b = { role: 'assistant', content: 'one', stats: st('b', 300, 30, 100) };
  b = Lib.addVersion(b, { content: 'two', stats: st('b', 500, 50, 200) });
  const msgs = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'old reply, saved before stats existed' }, { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', stats: st('a', 100, 10, 50) }, { role: 'user', content: 'q' }, b];
  const chat = { messages: msgs, used: 1234 }; // the running total, which includes replies no longer in the chat
  const all = Lib.chatStats(chat);
  assert.deepStrictEqual([all.models, all.avgTtft, all.avgTps, all.used, all.context, all.last.ttft, all.points.map((p) => p.n), all.est, all.noTotal],
    [['a', 'b'], 300, 30, 1234, 200, 500, [2, 3], false, false]);
  const onlyB = Lib.chatStats(chat, 'b');
  assert.deepStrictEqual([onlyB.avgTtft, onlyB.points.map((p) => p.n), onlyB.last.model, onlyB.used], [500, [3], 'b', 1234]); // numbered as in the chat
  assert.deepStrictEqual(Lib.showVersion(b, 0).stats.ttft, 300); // each version keeps its own stats
  const stopped = Lib.chatStats({ messages: [{ role: 'assistant', stats: st('a', 1, 1, null, { est: true }) }, { role: 'assistant', stats: st('a', 1, 1, null) }] });
  assert.deepStrictEqual([stopped.est, stopped.noTotal, stopped.used], [true, true, 0]);
  const none = Lib.chatStats({ messages: [] });
  assert.deepStrictEqual([none.last, none.avgTtft, none.used], [null, null, 0]);
});

// ---- Summaries ----
test('listModelsDetailed reads the context limit from each provider\'s field, and asks NanoGPT for it', async () => {
  const data = [{ id: 'a', context_length: 1000 }, { id: 'b', top_provider: { context_length: 2000 } }, { id: 'c', model_spec: { availableContextTokens: 3000 } },
    { id: 'd', context_window: 4000 }, { id: 'e', max_context_length: 5000 }, { id: 'f', max_model_len: 6000 }, { id: 'g' }, { id: 'h', context_length: 'big' }];
  const seen = {}, out = await listModelsDetailed('http://x/v1', '', fake(200, { data }, seen));
  assert.deepStrictEqual(out.map((m) => m.ctx), [1000, 2000, 3000, 4000, 5000, 6000, undefined, undefined]);
  assert.ok(!('ctx' in out[6])); assert.strictEqual(seen.url, 'http://x/v1/models');
  await listModelsDetailed('https://nano-gpt.com/api/v1', '', fake(200, { data }, seen));
  assert.strictEqual(seen.url, 'https://nano-gpt.com/api/v1/models?detailed=true');
});

const turn = (n, extra = {}) => [{ role: 'user', content: 'q' + n }, { role: 'assistant', content: 'a' + n, ...extra }];
test('Lib.requestMessages: a summary joins the one system message and replaces what it covers; a stale one is ignored', () => {
  const chat = { messages: [...turn(1), ...turn(2)], summary: { text: 'S', upto: 2, at: 4 } };
  const out = Lib.requestMessages(chat, { bot: 'Bo' });
  assert.deepStrictEqual(out, [{ role: 'system', content: 'You are Bo.\n\nSummary of the earlier conversation:\nS' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
  assert.deepStrictEqual(Lib.requestMessages({ ...chat, messages: chat.messages.slice(0, 1) }, null), [{ role: 'user', content: 'q1' }]); // chat now shorter than upto
});

test('Lib.contextTokens: the latest reply\'s prompt count plus an estimate, never a count from before the summary', () => {
  const big = 'x'.repeat(400); // 100 tokens
  assert.strictEqual(Lib.contextTokens({ messages: [{ role: 'user', content: big }, { role: 'user', content: [{ type: 'text', text: big }, { type: 'image_url', image_url: { url: 'd' } }] }] }), 1200);
  // without a server count the system message counts too: the persona prompt, the render hint and any summary
  const persona = { prompt: big }, sys = /** @type {{content: string}} */ (Lib.requestMessages({ messages: [] }, persona, { render: {} })[0]).content;
  assert.strictEqual(Lib.contextTokens({ messages: [{ role: 'user', content: big }] }, persona, { render: {} }), 100 + Math.ceil(sys.length / 4));
  // the reply's ctx (its total, with reasoning and search results) is not used: its prompt count plus the reply's own text is
  const msgs = [...turn(1, { content: big, stats: { ctx: 50000, prompt: 900 } }), { role: 'user', content: big }];
  assert.strictEqual(Lib.contextTokens({ messages: msgs }), 1100);
  // summarized after reply 1: its count measured the old context, so the summary and the kept messages are estimated instead
  const sumd = { messages: msgs, summary: { text: big, upto: 2, at: 3 } };
  assert.strictEqual(Lib.contextTokens(sumd), Math.ceil(/** @type {{content: string}} */ (Lib.requestMessages(sumd, null)[0]).content.length / 4) + 100);
  const later = [...msgs, { role: 'assistant', content: 'a', stats: { prompt: 300 } }, { role: 'user', content: big }];
  assert.strictEqual(Lib.contextTokens({ messages: later, summary: { text: big, upto: 2, at: 3 } }), 401);
});

test('Lib.summaryCut and summaryDue: end on a user turn, keep the last 4 messages, need something new to fold in', () => {
  const chat = { messages: [...turn(1), ...turn(2), ...turn(3), { role: 'user', content: 'q4' }] }; // 7 messages
  assert.strictEqual(Lib.summaryCut(chat), 2); // index 3 is a reply, so it steps back to the user turn at 2
  assert.strictEqual(Lib.summaryCut({ messages: chat.messages.slice(0, 4) }), -1); // too short to keep 4 and fold anything
  assert.strictEqual(Lib.summaryCut({ ...chat, summary: { text: 's', upto: 2, at: 5 } }), -1); // nothing new since the last summary
  assert.strictEqual(Lib.summaryDue(chat, 100), -1); // far under the limit
  assert.strictEqual(Lib.summaryDue({ messages: [...chat.messages.slice(0, 6), { role: 'user', content: 'x'.repeat(400) }] }, 100), 2); // over 80
});

test('Lib.summaryRequest: folds the previous summary and the new messages, named after the persona, images as [image]', () => {
  const chat = { messages: [...turn(1), { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'd' } }] }, { role: 'assistant', content: 'nice' }, ...turn(3)],
    summary: { text: 'Old', upto: 2, at: 4 } };
  const [sys, user] = Lib.summaryRequest(chat, { user: 'Ann', bot: 'Bo' }, 4);
  assert.strictEqual(sys.role, 'system');
  assert.strictEqual(user.content, 'Summary so far:\nOld\n\nConversation to add:\n\nAnn: look [image]\n\nBo: nice');
  assert.match(Lib.summaryRequest({ messages: turn(1) }, null, 2)[1].content, /^Conversation to add:\n\nUser: q1\n\nAssistant: a1$/);
});

test('store: summary model, context limit and a persona\'s own summary model are validated and saved; ctx belongs to the profile', async () => {
  const { dir, store } = tmpStore();
  let v = await store.get();
  assert.deepStrictEqual([v.summarizer, v.contextLimit], [{ profileId: '', model: '' }, { on: false, tokens: 300000 }]);
  const a = (await store.saveProfile({ name: 'A', endpoint: 'http://a' })).activeId;
  const b = (await store.saveProfile({ name: 'B', endpoint: 'http://b', key: 'kb' })).activeId;
  await store.patch({ summarizer: { profileId: a, model: 'cheap' }, contextLimit: { on: true, tokens: 64000 }, ctx: 128000 });
  await store.patch({ summarizer: 'nope', contextLimit: { on: true, tokens: 10 }, ctx: -1 }); // ignored
  v = await store.get();
  assert.deepStrictEqual([v.summarizer, v.contextLimit, v.profiles.find((p) => p.id === b).ctx, v.profiles.find((p) => p.id === a).ctx], [{ profileId: a, model: 'cheap' }, { on: true, tokens: 64000 }, 128000, 0]);
  await store.patch({ ctx: 0 }); assert.strictEqual((await store.get()).profiles.find((p) => p.id === b).ctx, 0); // unknown again, not the old number
  await store.patch({ summarizer: { profileId: '', model: 'stray' } }); assert.deepStrictEqual((await store.get()).summarizer, { profileId: '', model: '' });
  // load({profileId}) reads that profile; an unknown one falls back to the active profile
  assert.strictEqual((await store.load({ profileId: a })).endpoint, 'http://a');
  assert.strictEqual((await store.load({ profileId: 'gone' })).key, 'kb');
  let st = await store.savePersona({ name: 'P', summarizer: { profileId: a, model: 'm' } });
  const id = st.personaId;
  assert.deepStrictEqual(st.personas.find((p) => p.id === id).summarizer, { profileId: a, model: 'm' });
  st = await store.savePersona({ id, name: 'P' }); // switch turned off
  assert.ok(!('summarizer' in st.personas.find((p) => p.id === id)));
  fs.rmSync(dir, { recursive: true });
});

// ---- requestArgs ----
test('requestArgs: a summary takes its own model, no reasoning and no search; a chat takes the settings', () => {
  const s = { model: 'gpt', endpoint: 'https://openrouter.ai/api/v1', effort: 'high', search: { key: 'k' } };
  assert.deepStrictEqual(requestArgs(s, { summary: { profileId: 'p', model: 'cheap' }, search: true, mcp: true }), { model: 'cheap', extra: {}, search: null, mcp: false });
  assert.strictEqual(requestArgs(s, { summary: { profileId: 'p', model: '' } }).model, 'gpt');
  assert.deepStrictEqual(requestArgs(s, { search: true, mcp: true }), { model: 'gpt', extra: { reasoning: { effort: 'high' } }, search: { key: 'k' }, mcp: true });
  assert.strictEqual(requestArgs(s, {}).search, null);
});

// ---- MCP servers ----
const Mcp = require('./mcp');
const childProcess = require('node:child_process');

test('mcp parseConfig: Claude-style, bare and single-entry pastes; bad entries are named', () => {
  const godot = { command: 'npx', args: ['-y', '@npgamedev/godot-mcp-server'] };
  const want = { godot: { type: 'stdio', command: 'npx', args: ['-y', '@npgamedev/godot-mcp-server'], env: {} } };
  assert.deepStrictEqual(Mcp.parseConfig(JSON.stringify({ mcpServers: { godot } })), want);
  assert.deepStrictEqual(Mcp.parseConfig(JSON.stringify({ godot: { type: 'stdio', ...godot, env: {} } })), want);
  assert.deepStrictEqual(Object.keys(Mcp.parseConfig(JSON.stringify(godot))), ['godot-mcp-server']); // one entry on its own is named after its package
  assert.deepStrictEqual(Mcp.parseConfig(JSON.stringify({ mcpServers: { rh: { type: 'http', url: 'https://x.example/mcp', headers: { A: 'b' } } } })), { rh: { type: 'http', url: 'https://x.example/mcp', headers: { A: 'b' } } });
  assert.deepStrictEqual(Mcp.parseConfig('  '), {});
  assert.throws(() => Mcp.parseConfig('{oops'), /isn't valid JSON/);
  assert.throws(() => Mcp.parseConfig('{"mcpServers": {"a": {"type": "sse", "url": "https://x"}}}'), /Server "a": the old SSE transport/);
  assert.throws(() => Mcp.parseConfig('{"mcpServers": {"b": {"command": "x", "args": [1]}}}'), /Server "b": "args"/);
  assert.throws(() => Mcp.parseConfig('{"mcpServers": {"c": {"command": "x", "env": {"K": 1}}}}'), /Server "c": "env"/);
  assert.throws(() => Mcp.parseConfig('{"mcpServers": {"d": {"url": "ftp://x"}}}'), /Server "d": "url" must start/);
  assert.throws(() => Mcp.parseConfig('{"mcpServers": []}'), /must be an object of servers/);
});

test('mcp toolNames and resultText: safe unique names; results flattened, marked and capped', () => {
  assert.deepStrictEqual(Mcp.toolNames([{ server: 'my server', tool: 'get.scene' }, { server: 'my_server', tool: 'get_scene' }]), ['mcp__my_server__get_scene', 'mcp__my_server__get_scene_2']);
  assert.ok(Mcp.toolNames([{ server: 's', tool: 'x'.repeat(100) }, { server: 's', tool: 'x'.repeat(101) }]).every((n) => n.length <= 64 && /^[\w-]+$/.test(n)));
  assert.strictEqual(Mcp.resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: '…' }, { type: 'resource', resource: { text: 'r' } }] }), 'a\n[image omitted]\nr');
  assert.strictEqual(Mcp.resultText({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
  assert.strictEqual(Mcp.resultText({ content: [{ type: 'text', text: 'nope' }], isError: true }), 'Tool error: nope');
  assert.match(Mcp.resultText({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }), /\[cut off after 20000 characters\]$/);
});

// A tiny MCP server: logs a non-JSON line first, answers in pages, echoes, hangs on "slow" until cancelled, dies on "crash".
const MCP_SERVER = `
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdout.write('starting up...\\n');
let buf = '', cancelled = [];
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) on(JSON.parse(l)); } });
process.stdin.on('end', () => process.exit(0));
function on(m) {
  if (m.method === 'initialize' && process.env.BIG) return process.stdout.write('x'.repeat(33 * 1024 * 1024)); // no line break, ever
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: process.env.PV || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } });
  if (m.method === 'notifications/cancelled') return cancelled.push(m.params.requestId);
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: m.params?.cursor
    ? { tools: [{ name: 'slow', inputSchema: { type: 'object' } }, { name: 'crash', inputSchema: { type: 'object' } }] }
    : { tools: [{ name: 'echo', description: 'Echo', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { t: { type: 'string' } } } }], nextCursor: 'p2' } });
  if (m.method === 'tools/call') {
    if (m.params.name === 'echo') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.t + ' cancelled:' + cancelled.join(',') }] } });
    if (m.params.name === 'crash') { process.stderr.write('Traceback: boom\\n'); process.exit(3); }
    return; // slow: never answers
  }
}`;
const nodeSpawn = (cmd, args, env) => childProcess.spawn(cmd, args, { env: { ...process.env, ...env } });
const testServer = (env = {}) => ({ type: 'stdio', command: process.execPath, args: ['-e', MCP_SERVER], env });

test('mcp hub: a real local server lists its tools over pages, runs them, survives Stop, and reports a crash with its stderr', async () => {
  const hub = Mcp.makeHub({ spawn: nodeSpawn });
  hub.configure({ ed: testServer() });
  try {
    assert.deepStrictEqual(await hub.status(), [{ name: 'ed', type: 'stdio', state: 'ok', tools: 3, error: '', signedIn: false }]);
    const set = await hub.tools();
    assert.deepStrictEqual(set.defs.map((d) => d.function.name), ['mcp__ed__crash', 'mcp__ed__echo', 'mcp__ed__slow']);
    assert.deepStrictEqual(set.defs[1].function.parameters, { type: 'object', properties: { t: { type: 'string' } } }); // $schema dropped
    assert.strictEqual(set.label('mcp__ed__echo'), 'ed › echo');
    assert.strictEqual(await set.run('mcp__ed__echo', { t: 'hi' }), 'echo:hi cancelled:');
    const ctl = new AbortController(), slow = set.run('mcp__ed__slow', {}, ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(slow, /Stopped/);
    assert.match(await set.run('mcp__ed__echo', { t: 'again' }), /^echo:again cancelled:\d+$/); // still running, and it was told
    await assert.rejects(set.run('mcp__ed__crash', {}), /exit code 3[\s\S]*Traceback: boom/);
    assert.strictEqual(await set.run('mcp__ed__echo', { t: 'back' }), 'echo:back cancelled:'); // the next use starts a new process, which heard of no cancel
  } finally { await hub.closeAll(); }
});

test('mcp hub: unknown protocol versions, missing commands and local servers without spawn are reported', async () => {
  const hub = Mcp.makeHub({ spawn: nodeSpawn });
  hub.configure({ odd: testServer({ PV: '1999-01-01' }), gone: { type: 'stdio', command: 'no-such-command-javc', args: [], env: {} } });
  try {
    const [odd, gone] = await hub.status();
    assert.match(odd.error, /speaks MCP 1999-01-01/); assert.match(gone.error, /"no-such-command-javc" wasn't found/);
    const set = await hub.tools();
    assert.deepStrictEqual(set.defs, []); assert.deepStrictEqual(set.failed.map((f) => f.name).sort(), ['gone', 'odd']);
  } finally { await hub.closeAll(); }
  const phone = Mcp.makeHub({});
  phone.configure({ ed: testServer() });
  assert.deepStrictEqual(await phone.status(), [{ name: 'ed', type: 'stdio', state: 'desktop-only', tools: 0, error: '', signedIn: false }]);
  assert.deepStrictEqual((await phone.tools()).defs, []);
});

test('mcp hub: a changed or removed server is stopped', async () => {
  const seen = [];
  const spy = (cmd, args, env) => { const c = nodeSpawn(cmd, args, env); seen.push(c); return c; };
  const h = Mcp.makeHub({ spawn: spy });
  h.configure({ ed: testServer() }); await h.status();
  h.configure({ ed: testServer({ X: '1' }) }); await h.status();
  const exited = (c) => new Promise((/** @type {(v?: unknown) => void} */ r) => (c.exitCode !== null ? r() : c.once('exit', r)));
  await exited(seen[0]);
  assert.strictEqual(seen.length, 2); assert.notStrictEqual(seen[0].exitCode, null);
  h.configure({}); await exited(seen[1]);
});

test('mcp hub: a reply refuses calls to a server changed or removed meanwhile; a server that floods stdout is stopped', async () => {
  const hub = Mcp.makeHub({ spawn: nodeSpawn });
  hub.configure({ ed: testServer() });
  try {
    const set = await hub.tools();
    hub.configure({ ed: testServer({ X: '1' }) });
    await assert.rejects(set.run('mcp__ed__echo', { t: 'x' }), /"ed" was changed or removed/);
    hub.configure({});
    await assert.rejects(set.run('mcp__ed__echo', { t: 'x' }), /"ed" was changed or removed/);
    hub.configure({ big: testServer({ BIG: '1' }) });
    assert.match((await hub.status())[0].error, /larger than 32 MB/);
  } finally { await hub.closeAll(); }
});

test('mcp replyTools: notes for servers that fail and a config that cannot be read; "always" is saved', async () => {
  const notes = [], saved = [];
  const onDelta = (d) => notes.push(d.reasoning);
  const store = (servers) => ({ mcpForReply: async () => ({ servers, allow: {} }), allowMcpTool: async (s, t) => { saved.push(s + '/' + t); } });
  const hub = Mcp.makeHub({ spawn: nodeSpawn });
  const locked = { mcpForReply: async () => { throw new Error("Couldn't read the saved MCP servers"); }, allowMcpTool: async () => {} };
  assert.strictEqual(await Mcp.replyTools(hub, locked, { approve: async () => 'deny', onDelta }), undefined);
  assert.match(notes.pop(), /MCP tools are off for this reply: Couldn't read/);
  const needsAuth = { configure() {}, tools: async () => ({ ...fakeSet(), defs: [], failed: [{ name: 'rh', error: 'x', auth: true }] }) };
  await Mcp.replyTools(/** @type {any} */ (needsAuth), store({}), { approve: async () => 'deny', onDelta });
  assert.match(notes.pop(), /"rh" needs you to sign in \(Settings → Tools\)/);
  try {
    let asked = 0;
    const tools = await Mcp.replyTools(hub, store({ ed: testServer(), gone: { type: 'stdio', command: 'no-such-command-javc', args: [], env: {} } }), { approve: async () => { asked++; return 'always'; }, onDelta });
    assert.match(notes.pop(), /"gone" didn't start/);
    assert.strictEqual(await tools.call('mcp__ed__echo', '{"t":"a"}'), 'echo:a cancelled:');
    assert.strictEqual(await tools.call('mcp__ed__echo', '{"t":"b"}'), 'echo:b cancelled:');
    assert.strictEqual(asked, 1); assert.deepStrictEqual(saved, ['ed/echo']);
  } finally { await hub.closeAll(); }
});

const fakeSet = (ran = []) => ({
  defs: [{ type: 'function', function: { name: 'mcp__ed__echo', description: 'Echo', parameters: { type: 'object' } } }], failed: [],
  has: (n) => n === 'mcp__ed__echo', label: () => 'ed › echo', info: (n) => (n === 'mcp__ed__echo' ? { server: 'ed', tool: 'echo' } : undefined),
  run: async (n, args) => { ran.push(args); return 'echoed ' + args.t; },
});

test('mcp gated: every call is put to the user unless always allowed; bad arguments never run', async () => {
  const ran = [], asked = [];
  const deny = Mcp.gated(fakeSet(ran), { allowed: () => false, approve: async (i) => { asked.push(i); return 'deny'; } });
  assert.strictEqual(await deny.call('mcp__ed__echo', '{"t":"x"}'), Mcp.DECLINED);
  assert.deepStrictEqual(asked, [{ server: 'ed', tool: 'echo', args: { t: 'x' } }]); assert.deepStrictEqual(ran, []);
  assert.match(await deny.call('mcp__ed__echo', '[1]'), /must be a JSON object/);
  assert.match(await deny.call('mcp__nope', '{}'), /no tool called "mcp__nope"/);
  const ok = Mcp.gated(fakeSet(ran), { allowed: (s, t) => s === 'ed' && t === 'echo', approve: async () => { throw new Error('not asked'); } });
  assert.strictEqual(await ok.call('mcp__ed__echo', ''), 'echoed undefined'); // empty arguments are {}
  const ctl = new AbortController(), waiting = Mcp.gated(fakeSet(ran), { allowed: () => false, approve: () => new Promise(() => {}) }).call('mcp__ed__echo', '{}', ctl.signal);
  ctl.abort();
  await assert.rejects(waiting, /Stopped/); // Stop ends a reply even while it waits for an answer
});

test('chatStream with MCP tools: calls run between rounds with a note; search and MCP share a round; rounds are capped', async () => {
  const chats = [], deltas = [];
  const both = toolFrames([[{ index: 0, id: 'a', function: { name: 'mcp__ed__echo', arguments: '{"t":"hi"}' } }, { index: 1, id: 'b', function: { name: 'web_search', arguments: '{"query":"q"}' } }]]);
  const mcp = Mcp.gated(fakeSet(), { allowed: () => true, approve: async () => 'deny' });
  const out = await chatStream('http://x', 'k', 'm', [], {}, (d) => deltas.push(d), searchFetch([both, frames([{ content: 'done' }])], linkupOk([]), chats), undefined, { key: 'lk' }, mcp);
  assert.strictEqual(out.content, 'done');
  assert.deepStrictEqual(chats[0].tools.map((t) => t.function.name), ['web_search', 'mcp__ed__echo']);
  assert.deepStrictEqual(chats[1].messages.slice(-2).map((m) => m.content), ['echoed hi', 'No results.']);
  assert.ok(deltas.some((d) => d.note && d.reasoning === 'Using ed › echo\n'));
  const loop = toolFrames([[{ index: 0, id: 'c', function: { name: 'mcp__ed__echo', arguments: '{}' } }]]), many = [];
  await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch(Array(25).fill(loop), linkupOk([]), many), undefined, undefined, mcp);
  assert.strictEqual(many.length, 21); assert.strictEqual(many[20].tool_choice, 'none'); // 20 tool rounds, then it must answer
  const none = {}; // no servers with tools: a plain request
  await chatStream('http://x', '', 'm', [], {}, () => {}, sse(frames([{ content: 'hi' }]), none), undefined, undefined, Mcp.gated({ ...fakeSet(), defs: [] }, { allowed: () => true, approve: async () => 'once' }));
  assert.strictEqual('tools' in JSON.parse(none.opts.body), false);
});

test('chatStream with MCP tools: a failing tool becomes tool text, and Stop during a tool stops the reply', async () => {
  const chats = [], call = toolFrames([[{ index: 0, id: 'c', function: { name: 'mcp__ed__echo', arguments: '{}' } }]]);
  const failing = Mcp.gated({ ...fakeSet(), run: async () => { throw new Error('editor not open'); } }, { allowed: () => true, approve: async () => 'once' });
  await chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch([call, frames([{ content: 'ok' }])], linkupOk([]), chats), undefined, undefined, failing);
  assert.strictEqual(chats[1].messages.at(-1).content, 'Tool failed: editor not open');
  const ctl = new AbortController();
  const hanging = Mcp.gated({ ...fakeSet(), run: () => new Promise((_, no) => { ctl.signal.addEventListener('abort', () => no(new Error('Stopped'))); setTimeout(() => ctl.abort(), 5); }) }, { allowed: () => true, approve: async () => 'once' });
  await assert.rejects(chatStream('http://x', 'k', 'm', [], {}, () => {}, searchFetch([call], linkupOk([])), ctl.signal, undefined, hanging), /Stopped/);
});

test('mcp settings: off by default, config encrypted and never exposed, bad pastes refused, changed servers lose "Always allow"', async () => {
  const { dir, file, store } = tmpStore();
  assert.deepStrictEqual((await store.get()).mcp, { enabled: false, hasConfig: false, servers: [], allow: {} });
  const cfg = JSON.stringify({ mcpServers: { ed: { command: 'npx', args: ['ed'], env: { TOKEN: 'secret-tok' } }, rh: { url: 'https://x.example/mcp' } } });
  let v = await store.saveMcp({ config: cfg, enabled: true });
  assert.deepStrictEqual(v.mcp, { enabled: true, hasConfig: true, servers: ['ed', 'rh'], allow: {} });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-tok'));
  assert.strictEqual(await store.mcpConfig(), cfg);
  assert.deepStrictEqual(Object.keys(await store.mcpServers()), ['ed', 'rh']);
  await store.allowMcpTool('ed', 'echo'); await store.allowMcpTool('rh', 'quote'); await store.allowMcpTool('ghost', 'x');
  assert.deepStrictEqual((await store.get()).mcp.allow, { ed: ['echo'], rh: ['quote'] });
  await assert.rejects(store.saveMcp({ config: '{"mcpServers": {"x": {"type": "sse", "url": "https://x"}}}' }), /SSE/);
  assert.strictEqual(await store.mcpConfig(), cfg); // nothing saved
  v = await store.saveMcp({ config: JSON.stringify({ mcpServers: { ed: { command: 'npx', args: ['other'] }, rh: { url: 'https://x.example/mcp' } } }) });
  assert.deepStrictEqual(v.mcp.allow, { rh: ['quote'] }); // ed now runs something else
  await store.saveMcp({ enabled: false });
  assert.deepStrictEqual(await store.mcpServers(), {});
  v = await store.saveMcp({ config: '' });
  assert.deepStrictEqual(v.mcp, { enabled: false, hasConfig: false, servers: [], allow: {} });
  fs.rmSync(dir, { recursive: true });
});

test('mcp hub: Stop while a server is still starting ends the wait at once; the server keeps starting for next time', async () => {
  const hub = Mcp.makeHub({ spawn: nodeSpawn });
  hub.configure({ mute: { type: 'stdio', command: process.execPath, args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], env: {} } }); // never answers initialize
  try {
    const ctl = new AbortController(), t0 = Date.now();
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(hub.tools(ctl.signal), /Stopped/);
    assert.ok(Date.now() - t0 < 2000);
  } finally { await hub.closeAll(); }
});

// A fake Streamable HTTP MCP server, as a fetch: sessions, JSON and event-stream answers, a ping from the server, an expiring session.
const mcpHttp = (opts = {}) => {
  const log = [], state = { session: 0, expireNext: false };
  const reply = (status, body, headers = {}) => new Response(body, { status, headers });
  const f = async (url, o) => {
    const h = o.headers || {}; log.push({ method: o.method, headers: h, body: o.body ? JSON.parse(o.body) : null });
    if (opts.auth) return reply(401, 'authentication required', { 'www-authenticate': 'Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource/mcp"' });
    if (o.method === 'DELETE') return reply(200, '');
    const m = o.body ? JSON.parse(o.body) : {};
    if (m.method === 'initialize') {
      if (opts.slowInit) await new Promise((_, no) => o.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))));
      state.session++;
      return reply(200, JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'h', version: '1' } } }), { 'content-type': 'application/json', 'mcp-session-id': 's' + state.session });
    }
    if (!h['Mcp-Session-Id']) return reply(400, 'missing session');
    if (h['Mcp-Session-Id'] !== 's' + state.session) return reply(404, 'session gone'); // ended by the server
    if (o.method === 'GET' && !['resume', 'reset'].includes(opts.drop)) return reply(405, ''); // resuming is handled below
    if (state.expireNext) { state.expireNext = false; return reply(404, 'session gone'); }
    if (o.method !== 'GET' && (m.method === undefined || m.id === undefined)) return reply(202, null);
    if (m.method === 'tools/list') return reply(200, JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'quote', inputSchema: { type: 'object' } }] } }), { 'content-type': 'application/json' });
    const enc = new TextEncoder(), sseRes = (text, close) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); if (close) c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const answer = (id) => `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'resumed' }] } })}\n\n`;
    if (opts.drop === 'silent') return sseRes(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv1', method: 'ping' })}\n\n`, true); // closes, nothing to resume from
    if (opts.drop === 'resume' || opts.drop === 'reset') { // a priming event with an id and retry, then the connection closes (or drops); the answer comes on the GET
      if (o.method === 'GET') { state.resumedFrom = h['Last-Event-ID']; return sseRes('id: e2\n' + answer(state.pendingId), true); }
      state.pendingId = m.id;
      if (opts.drop === 'resume') return sseRes('id: e1\nretry: 5\ndata: \n\n', true);
      let n = 0;
      return new Response(new ReadableStream({ pull(c) { if (n++) c.error(new TypeError('terminated')); else c.enqueue(enc.encode('id: e1\nretry: 5\ndata: \n\n')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (opts.drop === 'flood') { let n = 0; return new Response(new ReadableStream({ pull(c) { if (n++ < 40) c.enqueue(enc.encode('data: ' + 'x'.repeat(1024 * 1024))); else c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }
    // tools/call: an event stream with a ping first, the answer's data over two lines, and a stream left open
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv1', method: 'ping' })}\r\n\r\n`));
      c.enqueue(enc.encode(`data: {"jsonrpc":"2.0","id":${m.id},\ndata: "result":{"content":[{"type":"text","text":"AAPL ${m.params.arguments.n}"}]}}\n\n`));
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { f, log, state };
};
const remote = { rh: { type: 'http', url: 'https://x.example/mcp', headers: { 'X-Key': 'k' } } };

test('mcp http: session and version headers, JSON and event-stream answers, ping answered, an ended session is started again', async () => {
  const { f, log, state } = mcpHttp(), hub = Mcp.makeHub({ fetchFn: f }); // no spawn, as on a phone: url servers still work
  hub.configure(remote);
  assert.deepStrictEqual(await hub.status(), [{ name: 'rh', type: 'http', state: 'ok', tools: 1, error: '', signedIn: false }]);
  const set = await hub.tools();
  assert.strictEqual(await set.run('mcp__rh__quote', { n: 1 }), 'AAPL 1');
  const [init, initialized, list] = log;
  assert.strictEqual(init.body.method, 'initialize'); assert.strictEqual(init.headers['Mcp-Session-Id'], undefined); assert.strictEqual(init.headers['MCP-Protocol-Version'], undefined);
  assert.strictEqual(init.headers.Accept, 'application/json, text/event-stream'); assert.strictEqual(init.headers['X-Key'], 'k');
  assert.strictEqual(initialized.body.method, 'notifications/initialized'); assert.strictEqual(list.body.method, 'tools/list'); // in that order
  assert.strictEqual(list.headers['MCP-Protocol-Version'], '2025-11-25'); assert.strictEqual(list.headers['Mcp-Session-Id'], 's1');
  assert.ok(log.some((e) => e.body?.id === 'srv1' && e.body.result && e.headers['Mcp-Session-Id'] === 's1'), 'the ping was answered');
  state.expireNext = true;
  assert.strictEqual(await set.run('mcp__rh__quote', { n: 2 }), 'AAPL 2');
  assert.strictEqual(state.session, 2);
  await hub.closeAll();
  assert.deepStrictEqual(log.filter((e) => e.method === 'DELETE').map((e) => e.headers['Mcp-Session-Id']), ['s2']);
});

test('mcp http: a server that wants sign-in, one that is down, and one that answers an error are told apart', async () => {
  const hub = Mcp.makeHub({ fetchFn: mcpHttp({ auth: true }).f });
  hub.configure(remote);
  const [s] = await hub.status();
  assert.strictEqual(s.state, 'auth'); assert.match(s.error, /sign in/);
  const down = Mcp.makeHub({ fetchFn: async () => { throw new TypeError('fetch failed'); } });
  down.configure(remote);
  assert.match((await down.status())[0].error, /Couldn't reach x\.example: fetch failed/);
  const broken = Mcp.makeHub({ fetchFn: async () => new Response('oops', { status: 500 }) });
  broken.configure(remote);
  assert.match((await broken.status())[0].error, /x\.example answered HTTP 500: oops/);
});

test('mcp http: a server removed while connecting is stopped; an ended session is started again once for every call that used it', { timeout: 10000 }, async () => {
  const slow = mcpHttp({ slowInit: true }), hub = Mcp.makeHub({ fetchFn: slow.f });
  hub.configure(remote);
  const starting = hub.status();
  await new Promise((r) => setTimeout(r, 10));
  hub.configure({});
  assert.match((await starting)[0].error, /Stopped/);
  assert.deepStrictEqual(slow.log.map((e) => e.body?.method), ['initialize']); // nothing after the cancelled initialize

  const { f, log, state } = mcpHttp(), h2 = Mcp.makeHub({ fetchFn: f });
  h2.configure(remote);
  const set = await h2.tools();
  state.session++; // the server forgets session s1
  assert.deepStrictEqual(await Promise.all([set.run('mcp__rh__quote', { n: 1 }), set.run('mcp__rh__quote', { n: 2 })]), ['AAPL 1', 'AAPL 2']);
  assert.strictEqual(log.filter((e) => e.body?.method === 'initialize').length, 2); // one new session, shared by both calls
  await h2.closeAll();
});

test('mcp http: a dropped stream is resumed too, and one that never ends a line is cut off', async () => {
  const reset = mcpHttp({ drop: 'reset' }), hub = Mcp.makeHub({ fetchFn: reset.f });
  hub.configure(remote);
  assert.strictEqual(await (await hub.tools()).run('mcp__rh__quote', {}), 'resumed');
  assert.strictEqual(reset.state.resumedFrom, 'e1');
  const flood = Mcp.makeHub({ fetchFn: mcpHttp({ drop: 'flood' }).f });
  flood.configure(remote);
  await assert.rejects((await flood.tools()).run('mcp__rh__quote', {}), /larger than 32 MB/);
});

test('mcp http: a stream closed before the answer is resumed from its last event id, or fails instead of hanging', async () => {
  const resume = mcpHttp({ drop: 'resume' }), hub = Mcp.makeHub({ fetchFn: resume.f });
  hub.configure(remote);
  const set = await hub.tools();
  assert.strictEqual(await set.run('mcp__rh__quote', { n: 1 }), 'resumed');
  assert.strictEqual(resume.state.resumedFrom, 'e1');
  const get = resume.log.find((e) => e.method === 'GET');
  assert.strictEqual(get.headers.Accept, 'text/event-stream'); assert.strictEqual(get.headers['Mcp-Session-Id'], 's1');
  const silent = Mcp.makeHub({ fetchFn: mcpHttp({ drop: 'silent' }).f });
  silent.configure(remote);
  await assert.rejects((await silent.tools()).run('mcp__rh__quote', { n: 1 }), /closed the stream without answering/);
});

// ---- MCP sign-in (OAuth) ----
const nodeCrypto = require('node:crypto');
// A fake world: an MCP server that wants a bearer token, its sign-in server (with a path, like Robinhood's), and a browser that approves at once.
const oauthWorld = (o = {}) => {
  const base = 'https://srv.example', as = 'https://auth.example/tenant', seen = { regs: [], tokens: [], auth: null, valid: '' };
  let codeFor = null, issued = 0, back;
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const f = async (url, opt = {}) => {
    const u = new URL(url), h = opt.headers || {};
    if (u.href === base + '/mcp') {
      const authz = Object.entries(h).filter(([k]) => k.toLowerCase() === 'authorization').map(([, v]) => v).join(', '); // as fetch joins them
      if (!seen.valid || authz !== 'Bearer ' + seen.valid) return new Response('no', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read"` } });
      const m = JSON.parse(opt.body);
      if (m.id === undefined) return new Response(null, { status: 202 });
      return json(200, { jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {} }
        : m.method === 'tools/list' ? { tools: [{ name: 'quote', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'quoted with ' + seen.valid }] } });
    }
    if (u.href === base + '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: o.resource || base + '/mcp', authorization_servers: [as], scopes_supported: ['ignored'] });
    if (u.href === 'https://auth.example/.well-known/oauth-authorization-server/tenant') {
      return json(200, { issuer: o.issuer || as, authorization_endpoint: as + '/authorize', token_endpoint: o.httpToken ? 'http://auth.example/token' : as + '/token', ...(!o.noRegistration && { registration_endpoint: as + '/register' }),
        code_challenge_methods_supported: o.noS256 ? ['plain'] : ['S256'], authorization_response_iss_parameter_supported: true });
    }
    if (u.href === as + '/register') { const b = JSON.parse(opt.body); seen.regs.push(b); return json(201, { client_id: 'cid-' + seen.regs.length, ...b }); }
    if (u.href === as + '/token') {
      const b = Object.fromEntries(new URLSearchParams(opt.body)); seen.tokens.push(b);
      if (b.grant_type === 'authorization_code') {
        const challenge = nodeCrypto.createHash('sha256').update(b.code_verifier || '').digest('base64url');
        if (b.code !== 'the-code' || b.client_id !== codeFor.clientId || b.redirect_uri !== codeFor.redirect || b.resource !== (o.resource || base + '/mcp') || challenge !== codeFor.challenge) return json(400, { error: 'invalid_grant', error_description: 'bad exchange' });
      } else {
        if (o.refreshGate) await o.refreshGate;
        if (o.refreshDown) throw new TypeError('fetch failed');
        if (o.refuseRefresh || b.refresh_token !== 'r' + issued || b.resource !== (o.resource || base + '/mcp')) return json(400, { error: 'invalid_grant' });
      }
      issued++; seen.valid = 'a' + issued;
      return json(200, { access_token: 'a' + issued, refresh_token: 'r' + issued, expires_in: o.expiresIn ?? 3600, token_type: 'Bearer' });
    }
    return new Response('not found', { status: 404 });
  };
  const ways = {
    listen: async () => ({ uri: 'http://127.0.0.1:5555/callback', next: new Promise((r) => { back = r; }), close: () => {} }),
    openUrl: (url) => {
      const q = new URL(url).searchParams; seen.auth = Object.fromEntries(q);
      codeFor = { challenge: q.get('code_challenge'), clientId: q.get('client_id'), redirect: q.get('redirect_uri') };
      const r = new URL(q.get('redirect_uri'));
      for (const [k, v] of Object.entries({ code: 'the-code', state: q.get('state'), iss: as, ...o.back })) if (v !== null) r.searchParams.set(k, v);
      back(r.href);
    },
  };
  const mem = {}, auth = { get: async (n) => mem[n] || null, save: async (n, t) => { if (t) mem[n] = t; else delete mem[n]; } };
  const hub = Mcp.makeHub({ fetchFn: f, auth });
  hub.configure({ rh: { type: 'http', url: base + '/mcp', headers: {} } });
  return { hub, ways, seen, mem, base, as, f };
};

test('mcp sign-in: discovery, registration, PKCE and the token exchange; the token is then used for every request', async () => {
  const w = oauthWorld();
  assert.strictEqual((await w.hub.status())[0].state, 'auth');
  await w.hub.signIn('rh', w.ways);
  assert.deepStrictEqual(await w.hub.status(), [{ name: 'rh', type: 'http', state: 'ok', tools: 1, error: '', signedIn: true }]);
  const [reg] = w.seen.regs;
  assert.deepStrictEqual(reg.redirect_uris, ['http://127.0.0.1:5555/callback']);
  assert.strictEqual(reg.token_endpoint_auth_method, 'none'); assert.strictEqual(reg.application_type, 'native');
  assert.deepStrictEqual({ ...w.seen.auth, state: '', code_challenge: '' }, { response_type: 'code', client_id: 'cid-1', redirect_uri: 'http://127.0.0.1:5555/callback',
    code_challenge: '', code_challenge_method: 'S256', state: '', resource: 'https://srv.example/mcp', scope: 'read' }); // the 401's scope wins over scopes_supported
  assert.ok(w.seen.auth.state.length >= 40 && w.seen.auth.code_challenge.length === 43);
  assert.strictEqual(w.mem.rh.accessToken, 'a1'); assert.strictEqual(w.mem.rh.clientId, 'cid-1'); assert.strictEqual(w.mem.rh.url, 'https://srv.example/mcp');
  assert.strictEqual(await (await w.hub.tools()).run('mcp__rh__quote', {}), 'quoted with a1');
  await w.hub.closeAll();
});

test('mcp sign-in: an expired or refused token is refreshed once; a refused refresh means sign in again; sign out forgets it', async () => {
  const w = oauthWorld();
  await w.hub.signIn('rh', w.ways);
  const set = await w.hub.tools();
  w.seen.valid = 'revoked'; // the server stops taking a1: refreshed on the 401, and the call is sent again
  assert.strictEqual(await set.run('mcp__rh__quote', {}), 'quoted with a2');
  Object.assign(w.mem.rh, { expiresAt: Date.now() - 1, refreshAt: Date.now() - 1 }); // expired: refreshed before it's sent
  assert.strictEqual(await set.run('mcp__rh__quote', {}), 'quoted with a3');
  assert.deepStrictEqual(w.seen.tokens.slice(1).map((t) => [t.grant_type, t.refresh_token, t.client_id, t.resource]),
    [['refresh_token', 'r1', 'cid-1', 'https://srv.example/mcp'], ['refresh_token', 'r2', 'cid-1', 'https://srv.example/mcp']]);
  await w.hub.signOut('rh');
  assert.strictEqual(w.mem.rh, undefined); assert.strictEqual((await w.hub.status())[0].state, 'auth');
  const refused = oauthWorld({ refuseRefresh: true });
  await refused.hub.signIn('rh', refused.ways);
  refused.seen.valid = 'revoked'; await refused.hub.reload();
  assert.deepStrictEqual((await refused.hub.status()).map((s) => [s.state, s.signedIn]), [['auth', true]]);
  await w.hub.closeAll(); await refused.hub.closeAll();
});

test('mcp sign-in: answers that do not match, other servers, no PKCE and refusals are all rejected', async () => {
  const cases = [
    [{ back: { state: 'someone-else' } }, /didn't match this sign-in/],
    [{ back: { iss: 'https://evil.example' } }, /different server than expected/],
    [{ back: { code: null, error: 'access_denied', error_description: 'You said no' } }, /Sign-in was refused: You said no/],
    [{ noS256: true }, /doesn't support PKCE/],
    [{ resource: 'https://other.example/mcp' }, /are for https:\/\/other\.example\/mcp, not https:\/\/srv\.example\/mcp/],
    [{ resource: 'https://srv.example/mc' }, /are for https:\/\/srv\.example\/mc,/], // a sibling path, not a parent
    [{ noRegistration: true }, /doesn't let new apps register/],
    [{ httpToken: true }, /token endpoint isn't on https/],
    [{ issuer: 'https://evil.example' }, /details are for https:\/\/evil\.example, not https:\/\/auth\.example\/tenant/], // RFC 8414
  ];
  for (const [opts, err] of cases) {
    const w = oauthWorld(opts);
    await assert.rejects(w.hub.signIn('rh', w.ways), err);
    assert.strictEqual(w.mem.rh, undefined);
  }
  const parent = oauthWorld({ resource: 'https://srv.example/' }); // details for the whole origin cover /mcp, and that resource is what's asked for
  await parent.hub.signIn('rh', parent.ways);
  assert.strictEqual(parent.seen.auth.resource, 'https://srv.example/');
  const slow = oauthWorld(); // the browser never comes back
  await assert.rejects(Mcp.signIn({ url: slow.base + '/mcp', headers: {} }, { fetchFn: slow.f, openUrl: () => {}, listen: slow.ways.listen, timeoutMs: 10 }), /Sign-in timed out/);
});

test('mcp sign-in: the 401 hint is reused, the sign-in replaces a configured Authorization, and token lifetimes are read safely', async () => {
  const w = oauthWorld({ expiresIn: '3600' }); // as text
  w.hub.configure({ rh: { type: 'http', url: w.base + '/mcp', headers: { authorization: 'Bearer stale' } } });
  await w.hub.status(); // its 401 says where the details are
  const before = [];
  const counting = Mcp.makeHub({ fetchFn: async (url, opt) => { before.push(opt?.method + ' ' + url); return w.f(url, opt); }, auth: { get: async () => null, save: async () => {} } });
  counting.configure({ rh: { type: 'http', url: w.base + '/mcp', headers: {} } });
  await counting.status(); before.length = 0;
  await counting.signIn('rh', w.ways);
  assert.ok(!before.includes('POST ' + w.base + '/mcp'), 'sign-in used the 401 it already had instead of asking the server again');
  await counting.closeAll();
  await w.hub.signIn('rh', w.ways);
  assert.strictEqual(await (await w.hub.tools()).run('mcp__rh__quote', {}), 'quoted with ' + w.mem.rh.accessToken); // not "Bearer stale"
  assert.ok(w.mem.rh.expiresAt > Date.now() + 3500e3 && w.mem.rh.refreshAt === w.mem.rh.expiresAt - 60000);
  const short = oauthWorld({ expiresIn: 30 });
  await short.hub.signIn('rh', short.ways);
  assert.strictEqual(short.mem.rh.expiresAt - short.mem.rh.refreshAt, 15000); // refreshed halfway, not on every request
  await w.hub.closeAll(); await short.hub.closeAll();
});

test('mcp sign-in: a refresh that finishes after sign-out is not saved; one that cannot reach the server keeps the current token', { timeout: 10000 }, async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const w = oauthWorld({ refreshGate: gate });
  await w.hub.signIn('rh', w.ways);
  const set = await w.hub.tools();
  w.seen.valid = 'revoked';
  const call = set.run('mcp__rh__quote', {}); // its 401 starts a refresh, held at the gate
  await new Promise((r) => setTimeout(r, 20));
  await w.hub.signOut('rh');
  open();
  await assert.rejects(call, /needs you to sign in/);
  assert.strictEqual(w.mem.rh, undefined); // the late refresh didn't sign back in
  const down = oauthWorld({ refreshDown: true });
  await down.hub.signIn('rh', down.ways);
  Object.assign(down.mem.rh, { refreshAt: Date.now() - 1 }); // due for a refresh, but the token still works
  assert.strictEqual(await (await down.hub.tools()).run('mcp__rh__quote', {}), 'quoted with a1');
  down.seen.valid = 'revoked';
  await down.hub.reload();
  assert.match((await down.hub.status())[0].error, /Couldn't reach auth\.example/); // a network error, not "sign in again"
  await w.hub.closeAll(); await down.hub.closeAll();
});

test('mcp sign-in settings: tokens are encrypted, kept per server, and dropped when that server changes or is removed', async () => {
  const { dir, file, store } = tmpStore();
  await store.saveMcp({ enabled: true, config: JSON.stringify({ mcpServers: { rh: { url: 'https://x.example/mcp' }, gh: { url: 'https://g.example/mcp' } } }) });
  const t = { url: 'https://x.example/mcp', accessToken: 'secret-access', refreshToken: 'secret-refresh' };
  await store.saveMcpTokens('rh', t); await store.saveMcpTokens('gh', { ...t, url: 'https://g.example/mcp' }); await store.saveMcpTokens('ghost', t);
  assert.deepStrictEqual(await store.mcpTokens('rh'), t); assert.strictEqual(await store.mcpTokens('ghost'), null);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-'));
  assert.ok(!JSON.stringify(await store.get()).includes('secret-'));
  await store.saveMcp({ config: JSON.stringify({ mcpServers: { rh: { url: 'https://y.example/mcp' }, gh: { url: 'https://g.example/mcp' } } }) });
  assert.strictEqual(await store.mcpTokens('rh'), null); assert.ok(await store.mcpTokens('gh')); // rh now points elsewhere
  await store.saveMcpTokens('gh', null); assert.strictEqual(await store.mcpTokens('gh'), null);
  fs.rmSync(dir, { recursive: true });
});
