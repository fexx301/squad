// Squad core: a lead's trade becomes a card; members copy that one trade at their own size; exits follow the lead
// or wait for the copier's OK. Strike positions are one-way net per market, so a copy is refused when the copier
// already holds that market, and closes are reduce-only for the recorded filled size only.
import crypto from 'node:crypto';
import { keyFromSeed } from './strike.js';
import { place, settle, position, armed, fillPrice, getOrder, fillsSince } from './orders.js';
import { rules, mark, floorTo, roundTo } from './market.js';
import { get, save } from './store.js';

const CARD_TTL_MS = 15 * 60 * 1000;
const fee = () => Number(process.env.BUILDER_FEE_BPS ?? 10);
const keyOf = (m) => keyFromSeed(m.apiSeed);
const flip = (side) => (side === 'buy' ? 'sell' : 'buy');
const DEFAULT_STOP_PCT = () => Number(process.env.COPY_STOP_PCT ?? 3);

// Stop trigger pct against the copier's entry: below it for longs, above it for shorts.
export const stopPrice = (side, entry, pct, tick) => roundTo(entry * (side === 'buy' ? 1 - pct / 100 : 1 + pct / 100), tick);
// Price loss if the stop fills exactly at its trigger (fees and slippage extra).
export const lossAtStop = (size, entry, stop) => Math.abs(entry - Number(stop)) * Number(size);
// Does a signed one-way position still hold the trade's direction?
export const stillIn = (side, signedSize) => (side === 'buy' ? signedSize > 0 : signedSize < 0);
// Strike's realized P&L excludes fees; we report it as Strike states it.
export const sumFills = (fills) => fills.reduce((a, f) => ({ realized: a.realized + Number(f.realized_pnl), fees: a.fees + Number(f.fee) }), { realized: 0, fees: 0 });

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
  if (qty <= 0) return classifyFlat(c, t, copier);
  c.status = 'closing'; save();
  const r = await rules(t.symbol);
  const o = await marketOrder(copier, t.symbol, flip(t.side), floorTo(qty, r.step), { reduceOnly: true });
  Object.assign(c, Number(o.filled) > 0 ? { status: 'closed', close: o, endedAt: Date.now() } : { status: 'open', close: o });
  save();
  return c;
}

// The copy's position is gone and Squad did not close it: its stop fired, or the copier closed it elsewhere.
async function classifyFlat(c, t, copier) {
  const key = keyOf(copier);
  const s = c.stop?.cid ? await getOrder(key, t.symbol, c.stop.cid).catch(() => null) : null;
  if (s && Number(s.Filled) > 0) Object.assign(c, { status: 'stopped', stopFillPrice: await fillPrice(key, t.symbol, s.ID).catch(() => null) });
  else Object.assign(c, { status: 'closed', closeNote: 'closed outside Squad' });
  c.endedAt = Date.now();
  save();
  return c;
}

// The lead is out: follow-mode copies close now; ask-mode copies wait for the copier's tap.
async function exitCopies(tradeId) {
  const results = [];
  for (const [k, c] of Object.entries(get().copies)) {
    if (c.tradeId !== tradeId || c.status !== 'open') continue;
    if (c.exitMode === 'follow') results.push({ k, ...(await closeCopy(k).catch((e) => ({ ...c, status: 'close-failed', error: e.message }))) });
    else { c.status = 'awaiting'; save(); results.push({ k, ...c }); }
  }
  return results;
}

// Exits made outside Squad (Strike app, the lead's own TP/SL, liquidation) and fired copy stops only show up on
// Strike, so we poll positions. A lead that no longer holds the trade's direction has exited (partial cuts are not
// mirrored). Statuses are re-checked after each await because /close and button taps run concurrently.
export async function watchOnce() {
  const events = [];
  for (const t of Object.values(get().trades)) {
    const lead = get().members[t.leadId];
    if (t.status !== 'open' || !lead) continue;
    const p = await position(keyOf(lead), t.symbol);
    if (t.status !== 'open' || stillIn(t.side, Number(p?.size ?? 0))) continue;
    Object.assign(t, { status: 'closed', closedAt: Date.now(), closedBy: 'outside' });
    save();
    events.push({ type: 'leadExited', trade: t, copies: await exitCopies(t.id) });
  }
  for (const [k, c] of Object.entries(get().copies)) {
    const t = get().trades[c.tradeId], copier = get().members[c.copierId];
    if ((c.status !== 'open' && c.status !== 'awaiting') || !t || !copier) continue;
    const p = await position(keyOf(copier), t.symbol);
    if (Number(p?.size ?? 0) !== 0 || (c.status !== 'open' && c.status !== 'awaiting')) continue;
    events.push({ type: 'copyEnded', trade: t, copy: { k, ...(await classifyFlat(c, t, copier)) } });
  }
  return events;
}

// Realized P&L per Strike's fill history: the lead since the trade opened, a copy since it was placed.
export async function copyPnl(k) {
  const c = get().copies[k], t = get().trades[c.tradeId], m = get().members[c.copierId];
  return sumFills(await fillsSince(keyOf(m), t.symbol, c.at));
}

export async function recap(tradeId) {
  const t = get().trades[tradeId], lead = get().members[t.leadId];
  const rows = [{ who: lead?.label ?? t.leadId, status: t.status, ...sumFills(await fillsSince(keyOf(lead), t.symbol, t.openedAt - 10000)) }];
  for (const [k, c] of Object.entries(get().copies)) {
    if (c.tradeId !== tradeId || c.status === 'failed' || c.status === 'placing') continue;
    const who = get().members[c.copierId]?.label ?? c.copierId;
    rows.push(['closed', 'stopped'].includes(c.status) ? { who, status: c.status, ...(await copyPnl(k)) } : { who, status: c.status });
  }
  return rows;
}

// Lead exits: close the lead, then follow-mode copies close; ask-mode copies wait for the copier's tap.
export async function closeLead(tradeId, leadId) {
  const t = get().trades[tradeId];
  if (!t || t.leadId !== String(leadId)) throw new Error('not your trade');
  if (t.status !== 'open') throw new Error('already closed');
  t.status = 'closing'; save();
  const o = await marketOrder(member(leadId), t.symbol, flip(t.side), t.size, { reduceOnly: true }).catch((e) => ({ reason: e.message }));
  if (!(Number(o.filled) > 0)) { t.status = 'open'; save(); throw new Error(`your close did not fill (${o.reason || o.status}); try again`); }
  Object.assign(t, { status: 'closed', closedAt: Date.now(), closedBy: 'squad', close: o });
  save();
  return { trade: t, copies: await exitCopies(tradeId) };
}
