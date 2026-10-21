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
  const resting = async () => (await call(key, 'GET', `/v2/openOrders?symbol=${symbol}`)).count ?? 0;
  let last = 0, reported = 0;
  for (;;) {
    try {
      const m = await mark(symbol);
      // Re-quote when the mark moves or a fill took a quote: judges trade for days, so no side may stay empty.
      if ((await resting()) < 2 || Math.abs(m - last) / m * 1e4 >= moveBps) {
        // orders/replace cancels every resting order on the symbol, then places these (one engine command).
        await call(key, 'POST', '/v2/orders/replace', { symbol, orders: quotes(m, r) });
        await new Promise((res) => setTimeout(res, 1500));
        // Writes are async: confirm both quotes rest (a post-only cross rejects one and skips the rest).
        const now = await resting();
        if (now >= 2) { last = m; log(`maker ${symbol} mark ${m}: 2 quotes resting ±0.2%`); }
        else log(`maker ${symbol}: only ${now} quote(s) resting; will retry`);
      }
      if (Date.now() - reported > 10 * 60 * 1000) { // inventory and margin, for watching the judging window
        const [pos, bal] = await Promise.all([call(key, 'GET', '/v2/positions'), call(key, 'GET', '/v2/balances')]);
        const p = (pos.positions ?? []).find((x) => x.symbol === symbol);
        log(`maker ${symbol} inventory ${p ? Number(p.size) : 0}, wallet ${Number(bal[0]?.walletBalance).toFixed(2)}, available ${Number(bal[0]?.availableBalance ?? bal[0]?.crossWalletBalance).toFixed(2)}`);
        reported = Date.now();
      }
    } catch (e) { log(`maker error: ${e.message}`); }
    await new Promise((res) => setTimeout(res, everyMs));
  }
}
