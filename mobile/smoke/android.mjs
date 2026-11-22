// CI smoke test on an Android emulator (see .github/workflows/build.yml): installs the debug APK, drives the real app
// through its WebView against a local mock API, then checks what landed on the device.
// Usage: node mobile/smoke/android.mjs path/to/app-debug.apk   (needs `npm i --no-save playwright` and adb on PATH)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { _android } from 'playwright';
import { handleApi, REPLY, RICH_HEIGHT } from './mock-api.mjs';
import { runFlow } from './flow.mjs';

const PKG = 'io.github.thedwz.javcchatbot';
const OUT = 'dist';
const apk = process.argv[2];
if (!apk || !fs.existsSync(apk)) { console.error('Usage: node mobile/smoke/android.mjs <debug.apk>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const requests = [], moved = [];
let hops = false; // when set, the chat POST goes 307 (same origin), then 308 to another origin (the second server)
const server = http.createServer(async (req, res) => {
  if (hops && req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const first = !req.url.includes('hop=1');
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization || '', body });
    res.writeHead(first ? 307 : 308, { location: first ? '/v1/chat/completions?hop=1' : 'http://10.0.2.2:8788/v1/chat/completions' });
    return res.end();
  }
  if (!(await handleApi(req, res, requests))) { res.writeHead(404); res.end(); }
});
const other = http.createServer(async (req, res) => { if (!(await handleApi(req, res, moved))) { res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(8787, '0.0.0.0', r)); // the emulator reaches the host as 10.0.2.2
await new Promise((r) => other.listen(8788, '0.0.0.0', r));

const [device] = await _android.devices();
if (!device) throw new Error('No Android device found');
log('Device', device.model(), 'serial', device.serial());
/** Runs an adb shell command on the device and returns its output. */
const sh = async (cmd) => (await device.shell(cmd)).toString();
fs.mkdirSync(OUT, { recursive: true });

let failed = null, rotation = null; // the device's [auto-rotate, rotation] while the landscape checks run
const restoreRotation = async () => { await sh(`settings put system user_rotation ${rotation[1]}`); await sh(`settings put system accelerometer_rotation ${rotation[0]}`); };
try {
  log('Installing', path.basename(apk));
  await device.installApk(fs.readFileSync(apk));
  log('WebView', (await sh('dumpsys webviewupdate')).match(/Current WebView package.*\)/)?.[0] || 'unknown');
  await sh('logcat -c');
  await sh(`am start -W -n ${PKG}/.MainActivity`);
  const webview = await device.webView({ pkg: PKG }, { timeout: 120_000 });
  const page = await webview.page();
  // Debug builds log every plugin call as a console group; keep only real messages.
  page.on('console', (m) => { if (!['startGroupCollapsed', 'startGroup', 'endGroup', 'dir'].includes(m.type())) log(`[page ${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => log('[page error]', e.message));

  /** Whether the on-screen keyboard is showing (mIsInputViewShown stays true after it closes, so it isn't used). */
  const keyboardUp = async () => /\bmInputShown=true\b/.test(await sh('dumpsys input_method'));
  /**
   * A real Back key event, which reaches the page through Capacitor's App plugin. While the on-screen keyboard is up,
   * Android gives Back to the keyboard first (that's normal), so let it close before pressing.
   */
  const back = async () => {
    await page.evaluate(() => { const a = document.activeElement; if (a?.matches?.('input, textarea')) a.blur(); });
    let waited = 0;
    while (waited < 5000 && (await keyboardUp())) { await sleep(250); waited += 250; }
    if (waited) log(`(waited ${waited} ms for the keyboard to close)`);
    await sleep(500);
    await sh('input keyevent KEYCODE_BACK');
  };
  await runFlow(page, { endpoint: 'http://10.0.2.2:8787/v1', key: 'sk-smoke', back, log });

  log('The key went to the server and is stored encrypted');
  if (!requests.some((r) => r.path === '/v1/chat/completions' && r.auth === 'Bearer sk-smoke')) throw new Error('Smoke check failed: the chat request carried the API key');
  const settings = JSON.parse(await sh(`run-as ${PKG} cat files/settings.json`));
  const prof = settings.profiles?.[0] || {};
  if (!prof.keyEnc || prof.keyPlain) throw new Error('Smoke check failed: the API key is Keystore-encrypted, not plain (' + JSON.stringify(Object.keys(prof)) + ')');
  if (!(await sh(`run-as ${PKG} ls files/chats`)).includes('_index.json')) throw new Error('Smoke check failed: chats are saved in private storage');

  await device.screenshot({ path: path.join(OUT, 'android-smoke.png') });

  /** A real finger tap on the middle of `sel`; the WebView's place on screen changes with rotation and the keyboard, so it's read each time. */
  const tap = async (sel) => {
    const ui = await sh('uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml'); // Playwright's device.info() needs a driver APK
    const [, x, y] = ui.match(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]/) || [];
    if (x === undefined) throw new Error('Smoke check failed: the WebView is on screen');
    const p = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: (r.x + r.width / 2) * devicePixelRatio, y: (r.y + r.height / 2) * devicePixelRatio }; }, sel);
    await sh(`input tap ${Math.round(+x + p.x)} ${Math.round(+y + p.y)}`);
  };
  const until = async (what, ok, ms = 10_000) => {
    for (let t = 0; t < ms; t += 250) { if (await ok()) return; await sleep(250); }
    throw new Error('Smoke check failed: ' + what);
  };

  log('Landscape with the keyboard up and a file attached: a long draft stays on screen (#32)');
  const setting = async (k, d) => { const v = (await sh(`settings get system ${k}`)).trim(); return /^\d+$/.test(v) ? v : d; }; // an unset one reads "null"
  rotation = [await setting('accelerometer_rotation', '1'), await setting('user_rotation', '0')];
  await sh('settings put system accelerometer_rotation 0');
  await sh('settings put system user_rotation 1');
  await until('the app turns to landscape', () => page.evaluate(() => innerWidth > innerHeight));
  const tall = await page.evaluate(() => innerHeight);
  await page.setInputFiles('#picker', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('a note') }); // the attachments row sits in the footer too
  await page.waitForSelector('#attachments > *');
  await tap('#input');
  await until('the keyboard opens on a tap', keyboardUp);
  await until('the page shrinks above the keyboard', () => page.evaluate((h) => innerHeight < h * 0.75, tall));
  await page.fill('#input', Array.from({ length: 20 }, (_, i) => 'Line ' + (i + 1)).join('\n'));
  await sleep(500);
  const box = await page.evaluate(() => {
    const t = document.querySelector('#input'), r = t.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, head: document.querySelector('header').getBoundingClientRect().bottom, vh: innerHeight, scrolls: t.scrollHeight > t.clientHeight };
  });
  if (box.top < box.head - 1 || box.bottom > box.vh + 1 || !box.scrolls) throw new Error('Smoke check failed: the draft fits between the header and the keyboard and scrolls inside (' + JSON.stringify(box) + ')');

  log('Send from the keyboard; the chat stays at the bottom when the preview grows (#31), through two redirects (#33)');
  hops = true;
  const rows = await page.$$eval('.row.assistant', (r) => r.length);
  await page.fill('#input', 'Say hello sideways');
  await tap('#send');
  await page.waitForFunction((n) => document.querySelectorAll('.row.assistant').length > n && document.querySelector('.row.assistant:last-child .actions'), rows, { timeout: 30_000 });
  await page.waitForFunction((h) => parseFloat(document.querySelector('.row.assistant:last-child .rich iframe')?.style.height) >= h, RICH_HEIGHT, { timeout: 30_000 });
  await sleep(1000);
  const pos = await page.evaluate(() => { const s = document.querySelector('#scroll'); return { scrolls: s.scrollHeight > s.clientHeight, gap: s.scrollHeight - s.scrollTop - s.clientHeight }; });
  if (!pos.scrolls || pos.gap >= 40) throw new Error('Smoke check failed: the chat is still at the bottom after the preview grew (' + JSON.stringify(pos) + ')');
  hops = false;
  const hop = requests.find((r) => r.path.includes('hop=1')), last = moved.find((r) => r.path === '/v1/chat/completions');
  if (hop?.auth !== 'Bearer sk-smoke' || !hop.body.includes('Say hello sideways')) throw new Error('Smoke check failed: a same-origin 307 keeps the key and the body (' + JSON.stringify(hop && { auth: hop.auth, body: hop.body.length }) + ')');
  if (!last || last.method !== 'POST' || last.auth || !last.body.includes('Say hello sideways')) throw new Error('Smoke check failed: a 308 to another origin keeps the POST and body but not the key (' + JSON.stringify(last && { method: last.method, auth: last.auth, body: last.body.length }) + ')');
  if (!(await page.textContent('.row.assistant:last-child .bubble')).includes(REPLY)) throw new Error('Smoke check failed: the redirected reply arrived');

  await restoreRotation();
  rotation = null;
  await until('the app turns back to portrait', () => page.evaluate(() => innerWidth < innerHeight));

  log('Back with nothing open sends the app to the background');
  await back();
  await new Promise((r) => setTimeout(r, 1500));
  const top = await sh('dumpsys activity activities');
  const resumed = top.split('\n').filter((l) => /ResumedActivity/.test(l)).join(' | ');
  if (resumed.includes(PKG)) throw new Error('Smoke check failed: Back with nothing open should send the app to the background (' + resumed.trim() + ')');
} catch (e) {
  failed = e;
  await device.screenshot({ path: path.join(OUT, 'android-smoke-failure.png') }).catch(() => {});
} finally {
  const logcat = await sh('logcat -d -v brief').catch(() => '');
  fs.writeFileSync(path.join(OUT, 'android-smoke-logcat.txt'), logcat);
  if (/FATAL EXCEPTION/.test(logcat) && logcat.includes(PKG)) failed ??= new Error('The app crashed; see android-smoke-logcat.txt');
  if (rotation) await restoreRotation().catch(() => {});
  await device.close();
  server.close();
  other.close();
}
if (failed) { console.error(failed); process.exit(1); }
log('Android smoke test passed');
