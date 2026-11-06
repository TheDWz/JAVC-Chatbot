// The smoke test's walk through the app on a phone-sized screen: create a profile, pick a model, use the back button,
// stream a reply with a rich block, read a PDF. `page` is a Playwright page; `back` presses the platform's back button.
import { MODEL, REPLY, RICH_HEIGHT } from './mock-api.mjs';

/** Fails the smoke test with `what` unless `ok`. */
const check = (ok, what) => { if (!ok) throw new Error('Smoke check failed: ' + what); };

/** A one-page PDF with a line of text, as base64, built by hand so the test needs no files. */
function tinyPdf(text) {
  const content = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

/**
 * Runs the walk-through; throws on the first check that fails.
 * @param {import('playwright').Page} page The app's page.
 * @param {{endpoint: string, key: string, back: () => Promise<void>, log?: Function}} opts The mock API's endpoint and key, and how to press Back.
 */
export async function runFlow(page, { endpoint, key, back, log = console.log }) {
  log('Waiting for the first-run profile dialog');
  await page.waitForSelector('#settings[open]', { timeout: 60_000 });
  await page.fill('#pname', 'Mock');
  await page.fill('#endpoint', endpoint);
  await page.fill('#key', key);
  await page.click('#save');
  await page.waitForFunction(() => !document.querySelector('#settings').open);

  log('Fetching models and picking one');
  await page.waitForSelector(`#model option[value="${MODEL}"]`, { state: 'attached', timeout: 30_000 });
  await page.click('#modelbtn');
  await page.click(`.mopt:has-text("${MODEL}")`);
  check((await page.textContent('#modellabel')) === MODEL, 'model is selected');

  log('Back button closes the options panel');
  await page.click('#reasoning');
  await page.waitForSelector('#side.open');
  await back();
  await page.waitForSelector('#side:not(.open)', { timeout: 10_000 });

  log('Header fits the screen');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `no sideways scrolling (page is ${overflow}px too wide)`);

  log('Streaming a reply');
  await page.fill('#input', 'Say hello');
  await page.click('#send');
  await page.waitForSelector('.row.assistant .actions', { timeout: 30_000 }); // added when the reply is complete
  const reply = await page.textContent('.row.assistant .bubble');
  check(reply.includes(REPLY), `reply text arrived (got ${JSON.stringify(reply.slice(0, 80))})`);
  check(await page.$('.row.assistant .bubble strong'), 'Markdown is rendered');
  check((await page.textContent('.row.assistant .think-body')).includes('Thinking about the answer'), 'reasoning arrived');

  log('Rich block renders in the sandbox and reports its height');
  await page.waitForFunction((h) => { const f = document.querySelector('.rich iframe'); return f && parseFloat(f.style.height) >= h; }, RICH_HEIGHT, { timeout: 30_000 });
  const src = await page.getAttribute('.rich iframe', 'src');
  check(/^(https:\/\/javc-sandbox\.invalid|chatbot-sandbox:)\/(\/)?doc\//.test(src), `frame comes from the sandbox host (${src})`);
  const reach = await page.evaluate(() => { try { return String(document.querySelector('.rich iframe').contentWindow.document); } catch { return 'blocked'; } });
  check(reach === 'blocked', 'the app cannot reach into the frame, so the frame cannot reach the app');

  log('With JavaScript off, a frame blocks the model\'s scripts but still sizes itself');
  const jsOff = await page.evaluate(async () => {
    const src = await window.api.createSandbox('<p>x</p><script>parent.postMessage({ ran: 1 }, "*")</script>', '#888', 'dark', { css: true, js: false });
    const f = document.createElement('iframe'), got = { ran: false, sized: false };
    const on = (e) => { if (e.source !== f.contentWindow) return; if (e.data?.ran) got.ran = true; if (typeof e.data?.richHeight === 'number') got.sized = true; };
    f.setAttribute('sandbox', 'allow-scripts'); addEventListener('message', on); f.src = src; document.body.append(f);
    await new Promise((r) => setTimeout(r, 2500));
    removeEventListener('message', on); f.remove(); return got;
  });
  check(jsOff.sized && !jsOff.ran, `the frame's own resize script ran and the model's did not (${JSON.stringify(jsOff)})`);

  log('A frame cannot reach the native bridge');
  const bridge = await page.evaluate(async () => {
    // Runs in a rich-reply frame, as model-written code would. If the bridge were ever exposed to frames (for example
    // through Capacitor's addJavascriptInterface fallback), `androidBridge` would be defined here.
    const probe = '<script>let parentCap; try { parentCap = typeof parent.Capacitor; } catch { parentCap = "blocked"; }'
      + 'let call = "none"; try { if (window.androidBridge) { androidBridge.postMessage(JSON.stringify({ type: "message", callbackId: "x", pluginId: "Javc", methodName: "fsList", options: { path: "" } })); call = "sent"; } } catch (e) { call = "threw"; }'
      + 'parent.postMessage({ probe: { bridge: typeof androidBridge, cap: typeof Capacitor, parentCap, call } }, "*")</script>';
    const src = await window.api.createSandbox(probe, '#888', 'dark', { css: true, js: true });
    const f = document.createElement('iframe');
    const got = await new Promise((ok) => {
      const on = (e) => { if (e.source === f.contentWindow && e.data?.probe) { removeEventListener('message', on); ok(e.data.probe); } };
      addEventListener('message', on); setTimeout(() => ok(null), 5000);
      f.setAttribute('sandbox', 'allow-scripts'); f.src = src; document.body.append(f);
    });
    f.remove(); return got;
  });
  check(bridge && bridge.bridge === 'undefined' && bridge.cap === 'undefined' && bridge.parentCap === 'blocked' && bridge.call === 'none',
    `no bridge, no Capacitor and no way into the app from a frame (${JSON.stringify(bridge)})`);

  log('Chat is saved and opens again');
  await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1, null, { timeout: 10_000 });
  const saved = await page.evaluate(async () => (await window.api.loadChat((await window.api.listChats())[0].id)).messages.length);
  check(saved >= 2, `the saved chat loads with its messages (got ${saved})`);

  log('Regenerate adds a version of the reply, and the arrows switch between them');
  const vcount = (row) => page.textContent(`.row.${row} .vcount`);
  await page.click('.row.assistant .mini:has-text("Regenerate")');
  await page.waitForFunction(() => document.querySelector('.row.assistant .vcount')?.textContent === '2/2', null, { timeout: 30_000 });
  await page.click('.row.assistant [title="Previous version"]');
  await page.waitForFunction(() => document.querySelector('.row.assistant .vcount')?.textContent === '1/2', null, { timeout: 10_000 });

  log('Edit adds a version of the user message and keeps the reply');
  await page.click('.row.user .mini:has-text("Edit")');
  await page.fill('.row.user .edit textarea', 'Say hello again');
  await page.click('.row.user .edit .btn.primary');
  await page.waitForFunction(() => document.querySelector('.row.user .vcount')?.textContent === '2/2', null, { timeout: 10_000 });
  check((await page.textContent('.row.user .bubble')) === 'Say hello again', 'the edited text is shown');
  check((await vcount('assistant')) === '1/2', 'the reply kept the version it was switched to');
  const stored = await page.evaluate(async () => { // saves are async, so poll until both versions are on disk
    for (let i = 0; i < 50; i++) {
      const [u, a] = (await window.api.loadChat((await window.api.listChats())[0].id)).messages;
      if (u.versions?.length === 2 && a.versions?.length === 2) return { text: u.text, versions: u.versions, replyV: a.v };
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check(stored?.text === 'Say hello again' && JSON.stringify(stored.versions) === '[{"text":"Say hello"},{"text":"Say hello again"}]' && stored.replyV === 0,
    `both versions are saved, the user's as text only (got ${JSON.stringify(stored)})`);

  log('Reading a PDF on the device');
  const text = await page.evaluate(async (b64) => window.api.extractPdf(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer), tinyPdf('JAVC PDF OK'));
  check(text.includes('JAVC PDF OK'), `PDF text extracted (got ${JSON.stringify(text.slice(0, 80))})`);
}
