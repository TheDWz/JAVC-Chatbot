// Builds the iOS app with Xcode (macOS only; run `npm run ios:sync` first).
//   node mobile/ipa.mjs              an unsigned dist/JAVC-Chatbot-<version>.ipa, for Sideloadly, AltStore and other signing tools
//   node mobile/ipa.mjs --simulator  a simulator build for the self-test (mobile/smoke/ios.mjs); prints the .app path
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split(/[.-]/).map(Number);
const sim = process.argv.includes('--simulator');
const derived = path.join(root, 'ios', 'build', sim ? 'sim' : 'device');

/** Runs a command, stopping the build if it fails. */
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('xcodebuild', [
  '-project', path.join(root, 'ios', 'App', 'App.xcodeproj'), '-scheme', 'App', '-configuration', sim ? 'Debug' : 'Release',
  '-sdk', sim ? 'iphonesimulator' : 'iphoneos', '-destination', sim ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS',
  '-derivedDataPath', derived,
  `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${major * 10000 + minor * 100 + patch}`, // as Android's versionCode
  // the device build is left unsigned for the user's signing tool; the simulator build is signed ad hoc, which the Keychain needs there
  ...(sim ? ['CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM='] : ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=']),
  'build',
]);

const app = path.join(derived, 'Build', 'Products', `${sim ? 'Debug-iphonesimulator' : 'Release-iphoneos'}`, 'App.app');
if (sim) { console.log('APP:', app); process.exit(0); }

// An .ipa is a zip with the app under Payload/
const stage = path.join(root, 'ios', 'build', 'ipa');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'Payload'), { recursive: true });
run('ditto', [app, path.join(stage, 'Payload', 'App.app')]);
const out = path.join(root, 'dist', `JAVC-Chatbot-${version}.ipa`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
run('zip', ['-qry', out, 'Payload'], { cwd: stage });
console.log('IPA:', path.relative(root, out));
