// The smoke test's walk through the app on a phone-sized screen: create a profile, pick a model, use the back button,
// stream a reply with a rich block, read a PDF. `page` is a Playwright page; `back` presses the platform's back button.
import { MODEL, REPLY, RICH_HEIGHT } from './mock-api.mjs';

const check = (ok, what) => { if (!ok) throw new Error('Smoke check failed: ' + what); };

// A one-page PDF with a line of text, built by hand so the test needs no files.
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

  log('Chat is saved');
  await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1, null, { timeout: 10_000 });

  log('Reading a PDF on the device');
  const text = await page.evaluate(async (b64) => window.api.extractPdf(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer), tinyPdf('JAVC PDF OK'));
  check(text.includes('JAVC PDF OK'), `PDF text extracted (got ${JSON.stringify(text.slice(0, 80))})`);
}
