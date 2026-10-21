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
// The page carries a one-time token in its URL: no caching, no referrer, no framing.
const SECURITY = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
const send = (res, code, obj) => { res.writeHead(code, { ...SECURITY, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function serve({ onConnected = () => {} } = {}) {
  const page = fs.readFileSync(new URL('../public/connect.html', import.meta.url));
  // Static files the page needs; anything else is a 404.
  const files = Object.fromEntries([['/bech32.js', 'text/javascript'], ['/squad-logo-white.svg', 'image/svg+xml'], ['/favicon.svg', 'image/svg+xml']]
    .map(([path, type]) => [path, { type, body: fs.readFileSync(new URL(`../public${path}`, import.meta.url)) }]));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/connect') { res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html' }); return res.end(page); }
      const f = req.method === 'GET' && files[url.pathname];
      if (f) { res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); return res.end(f.body); }
      if (req.method === 'POST' && url.pathname === '/api/connect/start') { const b = await readJson(req); return send(res, 200, await start(b.t, b.address)); }
      if (req.method === 'POST' && url.pathname === '/api/connect/finish') {
        const b = await readJson(req); const done = await finish(b.t, b.signature); onConnected(done); return send(res, 200, done);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  }).listen(PORT, '127.0.0.1', () => console.log(`connect server on ${baseUrl}`));
}
