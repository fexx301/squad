// HTTP server: wallet connect page + its JSON endpoints. Bound to localhost for the prototype.
import http from 'node:http';
import fs from 'node:fs';
import { createLink, start, finish } from './connect.js';

const PORT = Number(process.env.PORT ?? 8787);
export const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const connectUrl = (memberId, label) => `${baseUrl}/connect?t=${createLink(memberId, label)}`;

async function readJson(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('body too large'); }
  return JSON.parse(s || '{}');
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function serve({ onConnected = () => {} } = {}) {
  const page = fs.readFileSync(new URL('../public/connect.html', import.meta.url));
  const bech32js = fs.readFileSync(new URL('../public/bech32.js', import.meta.url));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/connect') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
      if (req.method === 'GET' && url.pathname === '/bech32.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bech32js); }
      if (req.method === 'POST' && url.pathname === '/api/connect/start') { const b = await readJson(req); return send(res, 200, await start(b.t, b.address)); }
      if (req.method === 'POST' && url.pathname === '/api/connect/finish') {
        const b = await readJson(req); const done = await finish(b.t, b.signature); onConnected(done); return send(res, 200, done);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  }).listen(PORT, '127.0.0.1', () => console.log(`connect server on ${baseUrl}`));
}
