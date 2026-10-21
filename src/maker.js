// Testnet liquidity: Strike testnet books are stale (quotes ~24% off mark, 5% price bound),
// so a Maker account we control rests one post-only bid and ask around the mark. Disclosed in the demo.
import { call } from './strike.js';
import { rules, mark, floorTo, roundTo } from './market.js';

export function quotes(m, r, { spread = 0.002, notional = 400 } = {}) {
  const size = floorTo(notional / m, r.limitStep);
  return [
    { side: 'buy', type: 'limit', post_only: true, size, price: roundTo(m * (1 - spread), r.tick) },
    { side: 'sell', type: 'limit', post_only: true, size, price: roundTo(m * (1 + spread), r.tick) },
  ];
}

export async function runMaker(key, symbol, { everyMs = 4000, moveBps = 5, log = console.log } = {}) {
  const r = await rules(symbol);
  let last = 0;
  for (;;) {
    try {
      const m = await mark(symbol);
      if (Math.abs(m - last) / m * 1e4 >= moveBps) {
        // orders/replace cancels every resting order on the symbol, then places these (one engine command).
        await call(key, 'POST', '/v2/orders/replace', { symbol, orders: quotes(m, r) });
        await new Promise((res) => setTimeout(res, 1500));
        // Writes are async: confirm both quotes rest (a post-only cross rejects one and skips the rest).
        const resting = (await call(key, 'GET', `/v2/openOrders?symbol=${symbol}`)).count ?? 0;
        if (resting >= 2) { last = m; log(`maker ${symbol} mark ${m}: 2 quotes resting ±0.2%`); }
        else log(`maker ${symbol}: only ${resting} quote(s) resting; will retry`);
      }
    } catch (e) { log(`maker error: ${e.message}`); }
    await new Promise((res) => setTimeout(res, everyMs));
  }
}
