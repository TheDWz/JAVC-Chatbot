// Serves the smoke-test mock API from mock-api.mjs on 127.0.0.1:18765,
// for the app's built-in self-test (JAVC_SELFTEST=1, see ../README.md).
// Anything the mock doesn't handle gets a 404.
import http from 'node:http';
import { handleApi } from './mock-api.mjs';

const requests = [];

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/_requests') { // for the self-test's check of what was actually sent
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requests));
    return;
  }
  try {
    if (await handleApi(req, res, requests)) return;
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    } else {
      res.end();
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(18765, '127.0.0.1', () => {
  console.log('mock API listening on http://127.0.0.1:18765');
});
