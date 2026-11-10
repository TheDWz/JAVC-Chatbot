// CI smoke test on an iOS simulator (see .github/workflows/build.yml): installs a simulator build made with
// `node mobile/build.mjs --selftest` and `node mobile/ipa.mjs --simulator`, starts it against a local mock API, and waits
// for the app's own self-test (ios-selftest.mjs) to write its results.
// Usage: node mobile/smoke/ios.mjs path/to/App.app   (macOS with Xcode)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { handleApi } from './mock-api.mjs';

const BUNDLE = 'io.github.thedwz.javcchatbot';
const OUT = 'dist';
const app = process.argv[2];
if (!app || !fs.existsSync(app)) { console.error('Usage: node mobile/smoke/ios.mjs <App.app>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();

const requests = [];
const server = http.createServer(async (req, res) => { if (!(await handleApi(req, res, requests))) { res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(8787, '127.0.0.1', r)); // the simulator shares the Mac's network

// the newest iPhone simulator on the newest iOS runtime
const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'));
const runtime = Object.keys(devices).filter((k) => /iOS/.test(k) && devices[k].some((d) => /iPhone/.test(d.name))).sort().at(-1);
if (!runtime) throw new Error('No iPhone simulator found');
const device = devices[runtime].filter((d) => /iPhone/.test(d.name)).at(-1);
log('Simulator', device.name, runtime.split('.').at(-1));

let failed = null;
try {
  if (device.state !== 'Booted') simctl('boot', device.udid);
  simctl('bootstatus', device.udid, '-b');
  simctl('install', device.udid, app);
  const data = simctl('get_app_container', device.udid, BUNDLE, 'data');
  const results = path.join(data, 'Library', 'Application Support', 'javc', 'selftest.json');
  fs.rmSync(results, { force: true });
  simctl('launch', device.udid, BUNDLE);
  log('Waiting for the self-test');
  let report = null;
  for (let t = 0; t < 240 && !report; t++) {
    await sleep(1000);
    try { report = JSON.parse(fs.readFileSync(results, 'utf8')); } catch {}
  }
  if (!report) throw new Error('The self-test wrote no results within 4 minutes');
  for (const c of report.checks) log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? `(${c.detail})` : '');
  const bad = report.checks.filter((c) => !c.ok);
  if (bad.length) throw new Error(`${bad.length} self-test check(s) failed`);
  fs.mkdirSync(OUT, { recursive: true });
  simctl('io', device.udid, 'screenshot', path.join(OUT, 'ios-smoke.png'));
} catch (e) {
  failed = e;
  fs.mkdirSync(OUT, { recursive: true });
  try { simctl('io', device.udid, 'screenshot', path.join(OUT, 'ios-smoke-failure.png')); } catch {}
} finally {
  try { fs.writeFileSync(path.join(OUT, 'ios-smoke-requests.json'), JSON.stringify(requests, null, 2)); } catch {}
  server.close();
}
if (failed) { console.error(failed); process.exit(1); }
log('iOS smoke test passed');
