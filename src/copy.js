// Squad core: a lead's trade becomes a card; members copy that one trade at their own size; exits follow the lead
// or wait for the copier's OK. Strike positions are one-way net per market, so a copy is refused when the copier
// already holds that market, and closes are reduce-only for the recorded filled size only.
import crypto from 'node:crypto';
import { keyFromSeed } from './strike.js';
import { place, settle, position, armed, fillPrice } from './orders.js';
import { rules, mark, floorTo, roundTo } from './market.js';
import { get, save } from './store.js';

const CARD_TTL_MS = 15 * 60 * 1000;
const fee = () => Number(process.env.BUILDER_FEE_BPS ?? 10);
const keyOf = (m) => keyFromSeed(m.apiSeed);
const flip = (side) => (side === 'buy' ? 'sell' : 'buy');
const DEFAULT_STOP_PCT = () => Number(process.env.COPY_STOP_PCT ?? 3);

// Stop trigger pct against the copier's entry: below it for longs, above it for shorts.
export const stopPrice = (side, entry, pct, tick) => roundTo(entry * (side === 'buy' ? 1 - pct / 100 : 1 + pct / 100), tick);

// Each copy gets its own reduce-only stop, so an unattended copy is protected even if Squad is offline.
// Strike cancels reduce-only orders when the position closes, so follow/ask closes need no cleanup.
async function protect(copier, t, c) {
  const key = keyOf(copier), r = await rules(t.symbol);
  const pct = copier.stopPct ?? DEFAULT_STOP_PCT();
  const entry = (await fillPrice(key, t.symbol, c.order.orderId)) ?? (await mark(t.symbol));
  const sp = stopPrice(t.side, entry, pct, r.tick);
  const cid = await place(key, { symbol: t.symbol, side: flip(t.side), type: 'stop', stop_price: sp, size: floorTo(Number(c.size), r.step), reduce_only: true }, { feeBps: fee() });
  const o = await armed(key, t.symbol, cid);
  return { cid, pct, entry, price: sp, status: o.Status, reason: o.CloseReason || undefined };
}

function member(id) {
  const m = get().members[String(id)];
  if (!m) throw new Error('not connected yet: use /connect first');
  return m;
}

async function marketOrder(m, symbol, side, size, { reduceOnly = false } = {}) {
  const key = keyOf(m);
  const cid = await place(key, { symbol, side, type: 'market', size, ...(reduceOnly && { reduce_only: true }) }, { feeBps: fee() });
  const o = await settle(key, symbol, cid);
  return { cid, status: o.Status, filled: o.Filled, reason: o.CloseReason, builder: o.Builder ?? null, orderId: o.ID };
}

export async function sizeFor(symbol, usd) {
  const [r, px] = await Promise.all([rules(symbol), mark(symbol)]);
  const size = floorTo(usd / px, r.step);
  if (Number(size) < r.minSize || Number(size) * px < r.minNotional) throw new Error(`$${usd} is below ${symbol}'s minimum ($${r.minNotional})`);
  return { size, px };
}

// Lead opens a position from chat; on a fill we create a trade card others can copy.
export async function openLead(leadId, symbol, side, usd) {
  const lead = member(leadId);
  const { size, px } = await sizeFor(symbol, usd);
  const o = await marketOrder(lead, symbol, side, size);
  if (!(Number(o.filled) > 0)) return { ok: false, order: o };
  const id = crypto.randomUUID().slice(0, 8);
  get().trades[id] = { id, leadId: String(leadId), symbol, side, size: o.filled, markAtOpen: px, openedAt: Date.now(), status: 'open', order: o };
  save();
  return { ok: true, trade: get().trades[id] };
}

// One tap = one copy. The copy record is written before the order so a duplicate tap cannot double-place.
export async function copyTrade(tradeId, copierId, usd, exitMode = process.env.EXIT_DEFAULT ?? 'follow') {
  const t = get().trades[tradeId];
  if (!t) throw new Error('unknown trade');
  if (String(copierId) === t.leadId) throw new Error('that is your own trade');
  if (t.status !== 'open') throw new Error('the lead already closed this trade');
  if (Date.now() - t.openedAt > CARD_TTL_MS) throw new Error('this card is older than 15 minutes; ask the lead for a fresh one');
  const k = `${tradeId}:${copierId}`;
  if (get().copies[k]) throw new Error(`already copied (${get().copies[k].status})`);
  const copier = member(copierId);
  get().copies[k] = { tradeId, copierId: String(copierId), exitMode, status: 'placing', at: Date.now() };
  save();
  const c = get().copies[k];
  try {
    const held = await position(keyOf(copier), t.symbol);
    if (held && Number(held.size) !== 0) throw new Error(`you already hold ${t.symbol}; close it first so the copy can be tracked`);
    const { size } = await sizeFor(t.symbol, usd);
    const o = await marketOrder(copier, t.symbol, t.side, size);
    Object.assign(c, { status: Number(o.filled) > 0 ? 'open' : 'failed', size: o.filled, requested: size, order: o });
    if (c.status === 'open') c.stop = await protect(copier, t, c).catch((e) => ({ error: e.message }));
  } catch (e) {
    Object.assign(c, { status: 'failed', error: e.message });
  }
  save();
  return c;
}

// Close only what the copy filled, capped at the live position, reduce-only so it can never flip or touch more.
export async function closeCopy(k) {
  const c = get().copies[k], t = get().trades[c.tradeId];
  if (c.status !== 'open' && c.status !== 'awaiting') return c;
  const copier = member(c.copierId);
  const held = await position(keyOf(copier), t.symbol);
  const live = held ? Math.abs(Number(held.size)) : 0;
  const qty = Math.min(Number(c.size), live);
  if (qty <= 0) { Object.assign(c, { status: 'closed', closeNote: 'no position left to close' }); save(); return c; }
  c.status = 'closing'; save();
  const r = await rules(t.symbol);
  const o = await marketOrder(copier, t.symbol, flip(t.side), floorTo(qty, r.step), { reduceOnly: true });
  Object.assign(c, { status: Number(o.filled) > 0 ? 'closed' : 'open', close: o });
  save();
  return c;
}

// Lead exits: close the lead, then follow-mode copies close; ask-mode copies wait for the copier's tap.
export async function closeLead(tradeId, leadId) {
  const t = get().trades[tradeId];
  if (!t || t.leadId !== String(leadId)) throw new Error('not your trade');
  if (t.status !== 'open') throw new Error('already closed');
  t.status = 'closing'; save();
  const o = await marketOrder(member(leadId), t.symbol, flip(t.side), t.size, { reduceOnly: true });
  Object.assign(t, { status: 'closed', closedAt: Date.now(), close: o });
  save();
  const results = [];
  for (const [k, c] of Object.entries(get().copies)) {
    if (c.tradeId !== tradeId || c.status !== 'open') continue;
    if (c.exitMode === 'follow') results.push({ k, ...(await closeCopy(k).catch((e) => ({ status: 'close-failed', error: e.message }))) });
    else { c.status = 'awaiting'; save(); results.push({ k, ...c }); }
  }
  return { trade: t, copies: results };
}
