// Market rules and decimal rounding for Strike symbols.
import { publicGet } from './strike.js';

const decimals = (step) => (String(step).split('.')[1] ?? '').replace(/0+$/, '').length;
// Floor to a multiple of step, returned as a fixed-decimal string (what the API expects).
export const floorTo = (x, step) => (Math.floor(x / Number(step) + 1e-9) * Number(step)).toFixed(decimals(step));
export const roundTo = (x, step) => (Math.round(x / Number(step)) * Number(step)).toFixed(decimals(step));

export async function rules(symbol) {
  const m = (await publicGet('/v2/markets')).markets[symbol];
  if (!m || m.status !== 'trading') throw new Error(`${symbol} is not trading`);
  return { tick: m.order_tick_price, step: m.order_market_step_size, limitStep: m.order_limit_step_size,
    minSize: Number(m.order_market_min_size), minNotional: Number(m.order_min_notional), bound: Number(m.order_limit_price_bound) };
}

export const mark = async (symbol) => Number((await publicGet(`/price/v2/markPrice?symbol=${symbol}`)).p);
