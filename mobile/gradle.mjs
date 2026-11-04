// Runs the Android Gradle build and copies the APK to dist/, next to the desktop packages.
// Usage: node mobile/gradle.mjs assembleRelease | assembleDebug   (run `npm run android:sync` first)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const task = process.argv[2] || 'assembleRelease';
const variant = { assembleRelease: 'release', assembleDebug: 'debug' }[task];
if (!variant) { console.error(`Unknown task ${task}; use assembleRelease or assembleDebug`); process.exit(2); }

const win = process.platform === 'win32';
const run = spawnSync(win ? 'gradlew.bat' : './gradlew', [task], { cwd: path.join(root, 'android'), stdio: 'inherit', shell: win });
if (run.status !== 0) process.exit(run.status ?? 1);

const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
const out = path.join(root, 'dist', `JAVC-Chatbot-${version}${variant === 'debug' ? '-debug' : ''}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(apk, out);
console.log('APK:', path.relative(root, out));
