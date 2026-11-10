// Builds www/, the web part of the Android app: the desktop page, plus mobile.js standing in for preload.js.
// Run with `npm run build:mobile`; `npm run android:sync` / `ios:sync` also copy the result into the phone projects.
// `--selftest` adds the iOS simulator self-test (mobile/smoke/ios-selftest.mjs); release builds never contain it.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
// rich replies are served from here: Android's SANDBOX_HOST (JavcPlugin.java) and iOS's sandboxScheme (JavcPlugin.swift)
const SANDBOX = 'https://javc-sandbox.invalid javc-sandbox:';
const selftest = process.argv.includes('--selftest');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

/** Bundles `entry` into www/`file` for the phones' web views (Android WebView 123+, iOS 17.5+). */
const bundle = (entry, file) => build({
  entryPoints: [path.join(root, 'mobile', entry)], outfile: path.join(out, file),
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome123', 'safari17.5'], legalComments: 'eof', logLevel: 'warning',
});
await bundle('main.js', 'mobile.js');
if (selftest) await bundle('smoke/ios-selftest.mjs', 'selftest.js');

/** Copies a file from the repository into www/. */
const copy = (from, to = from) => fs.copyFileSync(path.join(root, from), path.join(out, to));
copy('renderer.js');
copy('lib.js');
copy('node_modules/marked/lib/marked.umd.js', 'vendor/marked.umd.js');
copy('node_modules/pdf-parse/dist/pdf-parse/web/pdf-parse.es.js', 'vendor/pdf-parse.es.js');
copy('node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs', 'vendor/pdf.worker.mjs');

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
/** Replaces one piece of index.html for Android; fails the build if index.html no longer has it, so a change can't slip through. */
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html no longer contains ${JSON.stringify(from)}; update mobile/build.mjs to match`);
  html = html.replace(from, to);
};
swap('frame-src chatbot-sandbox:', `frame-src ${SANDBOX}`);
swap('<script src="node_modules/marked/lib/marked.umd.js"></script>', '<script src="vendor/marked.umd.js"></script>');
swap('<script src="renderer.js"></script>', '<script src="mobile.js"></script>\n<script src="renderer.js"></script>' + (selftest ? '\n<script src="selftest.js"></script>' : ''));
fs.writeFileSync(path.join(out, 'index.html'), html);

console.log('Built', path.relative(root, out) + '/' + (selftest ? ' (with the iOS self-test)' : ''));
