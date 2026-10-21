// Order placement and confirmation. Writes are async on Strike: 201 means "accepted", so we poll the order.
import crypto from 'node:crypto';
import { call } from './strike.js';

const WORKING = new Set(['pending', 'open', 'untriggered']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function place(key, order, { feeBps } = {}) {
  const client_order_id = order.client_order_id ?? `sq-${crypto.randomUUID()}`;
  await call(key, 'POST', '/v2/order', { ...order, client_order_id }, { builderFeeBps: feeBps });
  return client_order_id;
}

// Resolve to the terminal order (PascalCase engine model), or throw if it never appears (silently dropped).
export async function settle(key, symbol, clientOrderId, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const o = await call(key, 'GET', `/v2/order?symbol=${symbol}&client_order_id=${clientOrderId}`);
      if (!WORKING.has(o.Status)) return o;
    } catch (e) { if (e.status !== 404) throw e; }
    await sleep(500);
  }
  throw new Error(`order ${clientOrderId} not terminal after ${timeoutMs}ms (dropped or still working)`);
}

export const positions = (key) => call(key, 'GET', '/v2/positions');
export async function position(key, symbol) {
  const r = await positions(key);
  return (r.positions ?? []).find((p) => p.symbol === symbol) ?? null;
}
