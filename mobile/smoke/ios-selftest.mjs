// iOS simulator self-test, bundled into www/selftest.js only by `node mobile/build.mjs --selftest` (never into a release).
// Playwright can't drive an iOS web view, so the app tests itself: it talks to the mock API (mock-api.mjs) on the CI
// runner, then writes the results to selftest.json in its data folder, where mobile/smoke/ios.mjs reads them.
import { registerPlugin } from '@capacitor/core';
import { MODEL, REPLY, RICH_HEIGHT } from './mock-api.mjs';
import { tinyPdf } from './flow.mjs';

const Javc = registerPlugin('Javc'); // the same plugin object mobile/main.js uses
const ENDPOINT = 'http://127.0.0.1:8787/v1', KEY = 'sk-smoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @type {{name: string, ok: boolean, detail: string}[]} */
const checks = [];
/** Records one check; `detail` explains what was seen. */
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail) }); };
/** Runs one part of the test; a throw fails that part and the test goes on. */
async function part(name, fn) {
  try { await Promise.race([fn(), sleep(30_000).then(() => { throw new Error('timed out'); })]); }
  catch (e) { check(name, false, e?.message || e); }
}
const fileExists = async (p) => (await Javc.fsRead({ path: p })).exists;

/** Loads `src` in a sandboxed frame like a rich reply, collects its messages for `ms`, then removes it. */
async function frame(src, ms, until) {
  const f = document.createElement('iframe'), got = [];
  const on = (e) => { if (e.source === f.contentWindow) got.push(e.data); };
  addEventListener('message', on);
  f.setAttribute('sandbox', 'allow-scripts'); f.src = src; document.body.append(f);
  for (let t = 0; t < ms && !(until && got.some(until)); t += 100) await sleep(100);
  let reach = 'blocked'; try { reach = String(f.contentWindow.document); } catch {}
  removeEventListener('message', on); f.remove();
  return { got, reach };
}

async function run() {
  check('iOS and secure context', isSecureContext && !!crypto?.subtle, `${navigator.userAgent} · secure ${isSecureContext}`);

  await part('Keychain encryption', async () => {
    check('Keychain encryption works', (await Javc.cryptoAvailable()).available === true);
  });

  await part('Profile with an encrypted key', async () => {
    await window.api.saveProfile({ name: 'Mock', endpoint: ENDPOINT, key: KEY });
    const text = (await Javc.fsRead({ path: 'settings.json' })).text || '';
    const prof = JSON.parse(text).profiles?.[0] || {};
    check('The API key is stored encrypted', prof.keyEnc && !prof.keyPlain && !text.includes(KEY), Object.keys(prof).join(','));
  });

  await part('Models and a streamed reply', async () => {
    const models = await window.api.listModels();
    check('Models load through the native fetch', models.some((m) => m.id === MODEL), models.map((m) => m.id).join(','));
    await window.api.patchSettings({ model: MODEL });
    let deltas = 0;
    const out = await window.api.chat([{ role: 'user', content: 'Say hello' }], () => { deltas++; }, {});
    check('The reply arrives', out.content.includes(REPLY), out.content.slice(0, 80));
    check('The reply streams in pieces', deltas > 1, `${deltas} pieces`);
    check('Reasoning and token counts arrive', out.reasoning.includes('Thinking') && out.usage?.total_tokens === 60, JSON.stringify(out.usage));
  });

  await part('Chats are saved', async () => {
    const chat = { id: 'selftest-chat', title: 'Self-test', created: 1, updated: 1, personaId: 'default', messages: [{ role: 'user', content: 'hi', text: 'hi' }] };
    await window.api.saveChat(chat);
    const list = await window.api.listChats(), back = await window.api.loadChat(chat.id);
    check('A chat saves, lists and opens again', list.some((c) => c.id === chat.id) && back.messages[0].text === 'hi');
  });

  await part('Rich reply frame', async () => {
    const src = await window.api.createSandbox(`<div style="height:${RICH_HEIGHT}px">Rich</div>`, '#888', 'dark', { css: true, js: true });
    check('Rich replies come from the sandbox scheme', src.startsWith('javc-sandbox://doc/'), src);
    const { got, reach } = await frame(src, 8000, (d) => d?.richHeight >= RICH_HEIGHT);
    const h = Math.max(0, ...got.map((d) => d?.richHeight).filter((v) => typeof v === 'number'));
    check('The frame reports its height', h >= RICH_HEIGHT, `${h}px`);
    check('The app cannot reach into the frame', reach === 'blocked', reach);
  });

  await part('JavaScript off', async () => {
    const src = await window.api.createSandbox('<p>x</p><script>parent.postMessage({ ran: 1 }, "*")</script>', '#888', 'dark', { css: true, js: false });
    const { got } = await frame(src, 2500);
    const sized = got.some((d) => typeof d?.richHeight === 'number'), ran = got.some((d) => d?.ran);
    check('With JavaScript off, the model\'s script is blocked and the frame still sizes itself', sized && !ran, JSON.stringify({ sized, ran }));
  });

  await part('Bridge locked to the app page', async () => {
    // The same raw Capacitor message, once from the app page (it must work, so the probe itself is sound) and once from a frame.
    const msg = (p) => ({ type: 'message', callbackId: 'selftest', pluginId: 'Javc', methodName: 'fsWrite', options: { path: p, text: 'x' } });
    await Javc.fsRemove({ path: 'probe-main.txt' }); await Javc.fsRemove({ path: 'probe-frame.txt' });
    window.webkit.messageHandlers.bridge.postMessage(msg('probe-main.txt'));
    const probe = `<script>let r = "none"; try { webkit.messageHandlers.bridge.postMessage(${JSON.stringify(msg('probe-frame.txt'))}); r = "sent"; } catch (e) { r = "threw: " + e.message; }`
      + 'parent.postMessage({ probe: r, cap: typeof Capacitor }, "*")</script>';
    const { got } = await frame(await window.api.createSandbox(probe, '#888', 'dark', { css: true, js: true }), 5000, (d) => d?.probe);
    await sleep(1500);
    const main = await fileExists('probe-main.txt'), fromFrame = await fileExists('probe-frame.txt'), seen = got.find((d) => d?.probe);
    check('A bridge message from the app page reaches native code', main);
    check('A bridge message from a rich-reply frame is ignored', !fromFrame && seen, JSON.stringify(seen ?? 'the frame never answered'));
  });

  await part('Camera', async () => {
    let r;
    try { await navigator.mediaDevices.getUserMedia({ video: true }); r = 'granted'; } catch (e) { r = e?.name || String(e); }
    check('The camera is not granted to page content', r !== 'granted', r);
  });

  await part('PDF', async () => {
    const text = await window.api.extractPdf(Uint8Array.from(atob(tinyPdf('JAVC PDF OK')), (c) => c.charCodeAt(0)).buffer);
    check('PDF text is extracted', text.includes('JAVC PDF OK'), text.slice(0, 80));
  });

  await part('Message box grows', async () => {
    const box = document.getElementById('input'), before = box.offsetHeight;
    box.value = 'a\nb\nc\nd\ne\nf'; box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = box.offsetHeight; box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
    check('The message box grows with its text', after > before, `${before}px -> ${after}px · field-sizing ${CSS.supports('field-sizing', 'content')}`);
  });
}

addEventListener('load', async () => {
  await sleep(1500); // let the page settle (settings read, first-run dialog)
  try { await run(); } catch (e) { check('Self-test', false, e?.message || e); }
  await Javc.fsWrite({ path: 'selftest.json', text: JSON.stringify({ done: true, checks }, null, 2) });
});
