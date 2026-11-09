// A tiny OpenAI-compatible server for the smoke test: one model, and a streamed reply with reasoning, Markdown and a rich HTML block.
export const MODEL = 'mock-model';
export const REPLY = 'Hello from the mock API!';
export const RICH_HEIGHT = 160;

const frame = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Answers /v1/models and /v1/chat/completions (streamed) and returns true; anything else is left to the caller.
 * @param {object[]} requests Each request is recorded here ({method, path, auth, body}) so the test can check what was sent.
 */
export async function handleApi(req, res, requests) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/v1/')) return false;
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', body });
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
  } else if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const parts = [
      { reasoning_content: 'Thinking about ' }, { reasoning_content: 'the answer…' },
      { content: `${REPLY} Here is **bold** text, ` }, { content: 'streamed in pieces.\n\n' },
      { content: `<div id="probe" style="height:${RICH_HEIGHT}px;border-radius:12px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;display:grid;place-items:center">Rich reply OK</div>\n` },
    ];
    for (const d of parts) { res.write(frame(d)); await sleep(150); }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  }
  return true;
}
