// CI smoke test on an Android emulator (see .github/workflows/build.yml): installs the debug APK, drives the real app
// through its WebView against a local mock API, then checks what landed on the device.
// Usage: node mobile/smoke/android.mjs path/to/app-debug.apk   (needs `npm i --no-save playwright` and adb on PATH)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { _android } from 'playwright';
import { handleApi } from './mock-api.mjs';
import { runFlow } from './flow.mjs';

const PKG = 'io.github.thedwz.javcchatbot';
const OUT = 'dist';
const apk = process.argv[2];
if (!apk || !fs.existsSync(apk)) { console.error('Usage: node mobile/smoke/android.mjs <debug.apk>'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const requests = [];
const server = http.createServer(async (req, res) => { if (!(await handleApi(req, res, requests))) { res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(8787, '0.0.0.0', r)); // the emulator reaches the host as 10.0.2.2

const [device] = await _android.devices();
if (!device) throw new Error('No Android device found');
log('Device', device.model(), 'serial', device.serial());
const sh = async (cmd) => (await device.shell(cmd)).toString();
fs.mkdirSync(OUT, { recursive: true });

let failed = null;
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

  const back = () => sh('input keyevent KEYCODE_BACK'); // a real key event, through Capacitor's App plugin
  await runFlow(page, { endpoint: 'http://10.0.2.2:8787/v1', key: 'sk-smoke', back, log });

  log('The key went to the server and is stored encrypted');
  if (!requests.some((r) => r.path === '/v1/chat/completions' && r.auth === 'Bearer sk-smoke')) throw new Error('Smoke check failed: the chat request carried the API key');
  const settings = JSON.parse(await sh(`run-as ${PKG} cat files/settings.json`));
  const prof = settings.profiles?.[0] || {};
  if (!prof.keyEnc || prof.keyPlain) throw new Error('Smoke check failed: the API key is Keystore-encrypted, not plain (' + JSON.stringify(Object.keys(prof)) + ')');
  if (!(await sh(`run-as ${PKG} ls files/chats`)).includes('_index.json')) throw new Error('Smoke check failed: chats are saved in private storage');

  await device.screenshot({ path: path.join(OUT, 'android-smoke.png') });

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
  await device.close();
  server.close();
}
if (failed) { console.error(failed); process.exit(1); }
log('Android smoke test passed');
