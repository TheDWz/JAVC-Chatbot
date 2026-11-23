// A tiny OpenAI-compatible server for the smoke test: one model, and a streamed reply with reasoning, Markdown and a rich HTML block.
// "Make a <format> file" gets a create_file call instead, and the round with its result gets FILE_REPLY.
export const MODEL = 'mock-model';
export const REPLY = 'Hello from the mock API!';
export const RICH_HEIGHT = 160;
export const FILE_REPLY = 'Your file is attached.';
/** What the model puts in the file it's asked for, by format. */
export const FILE_ARGS = {
  pdf: { name: 'notes', format: 'pdf', content: '# Notes\n\n- one\n- two' },
  xlsx: { name: 'budget', format: 'xlsx', sheets: [{ name: 'Q1', rows: [['Item', 'Cost'], ['Rent', 1200], ['Total', '=SUM(B2:B2)']] }] },
  pptx: { name: 'deck', format: 'pptx', title: 'Plan', slides: [{ title: 'One', bullets: ['a', 'b'] }] },
  csv: { name: 'data', format: 'csv', sheets: [{ rows: [['a', 'b'], [1, 2]] }] },
  md: { name: 'readme', format: 'md', content: '# Hi' },
  txt: { name: 'note', format: 'txt', content: 'plain' },
};

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
    const msgs = JSON.parse(body).messages || [], last = msgs.at(-1), text = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).map((p) => p.text || '').join(''));
    const want = /Make an? (\w+) file/.exec(text(last))?.[1];
    if (last?.role === 'tool' || (want && FILE_ARGS[want])) { // a create_file round: call it, then answer once its result is back
      res.write(frame(last?.role === 'tool' ? { content: FILE_REPLY } : { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify(FILE_ARGS[want]) } }] }));
      res.end('data: [DONE]\n\n');
      return true;
    }
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
