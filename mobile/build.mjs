// Builds www/, the web part of the Android app: the desktop page, plus mobile.js standing in for preload.js.
// Run with `npm run build:mobile`; `npm run android:sync` also copies the result into the Android project.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const SANDBOX = 'https://javc-sandbox.invalid'; // rich replies are served from here; must match SANDBOX_HOST in JavcPlugin.java

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'mobile', 'main.js')],
  outfile: path.join(out, 'mobile.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome123', legalComments: 'eof', logLevel: 'warning',
});

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
swap('<script src="renderer.js"></script>', '<script src="mobile.js"></script>\n<script src="renderer.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);

console.log('Built', path.relative(root, out) + '/');
