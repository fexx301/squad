// Squad core: a lead's trade becomes a card; members copy that one trade at their own size; exits follow the lead
// or wait for the copier's OK. Strike positions are one-way net per market, so a trade or copy is refused when that
// account already holds the market, and closes are reduce-only for the recorded filled size only.
import crypto from 'node:crypto';
import { keyFromSeed } from './strike.js';
import { place, settle, position, armed, fillPrice, getOrder, fillsSince, publicPositions } from './orders.js';
import { rules, mark, floorTo, roundTo } from './market.js';
import { get, save } from './store.js';

const CARD_TTL_MS = 15 * 60 * 1000;
const STOP_RETRY_MS = 30 * 1000;
const fee = () => Number(process.env.BUILDER_FEE_BPS ?? 10);
const keyOf = (m) => keyFromSeed(m.apiSeed);
const flip = (side) => (side === 'buy' ? 'sell' : 'buy');
const DEFAULT_STOP_PCT = () => Number(process.env.COPY_STOP_PCT ?? 3);
const AUTH_DEAD = /authentication failed|wallet expired or revoked/;

// Stop trigger pct against the copier's entry: below it for longs, above it for shorts.
export const stopPrice = (side, entry, pct, tick) => roundTo(entry * (side === 'buy' ? 1 - pct / 100 : 1 + pct / 100), tick);
// A stop only protects if it sits on the losing side of the entry (tick rounding could otherwise land it on the entry).
export const protects = (side, entry, stop) => (side === 'buy' ? Number(stop) < entry : Number(stop) > entry);
// Price loss if the stop fills exactly at its trigger (fees and slippage extra).
export const lossAtStop = (size, entry, stop) => Math.abs(entry - Number(stop)) * Number(size);
// Does a signed one-way position still hold the trade's direction?
export const stillIn = (side, signedSize) => (side === 'buy' ? signedSize > 0 : signedSize < 0);
// Strike's realized P&L excludes fees; we report it as Strike states it.
export const sumFills = (fills) => fills.reduce((a, f) => ({ realized: a.realized + Number(f.realized_pnl), fees: a.fees + Number(f.fee) }), { realized: 0, fees: 0 });
// The size a trade still holds in a live position (0 if flat or flipped).
const heldSize = (side, p) => (p && stillIn(side, Number(p.size)) ? Math.abs(Number(p.size)) : 0);
const holdsAny = (p) => !!p && Number(p.size) !== 0;

// Each copy gets its own reduce-only stop, so an unattended copy is protected even if Squad is offline.
// Strike cancels reduce-only orders when the position closes, so follow/ask closes need no cleanup.
async function protect(copier, t, c) {
  const key = keyOf(copier), r = await rules(t.symbol);
  const pct = copier.stopPct ?? DEFAULT_STOP_PCT();
  const entry = (await fillPrice(key, t.symbol, c.order.orderId)) ?? (await mark(t.symbol));
  const sp = stopPrice(t.side, entry, pct, r.tick);
  if (!protects(t.side, entry, sp)) throw new Error(`stop ${sp} would not protect an entry at ${entry}`);
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
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('amount must be a positive number of USD');
  const [r, px] = await Promise.all([rules(symbol), mark(symbol)]);
  const size = floorTo(usd / px, r.step);
  if (Number(size) < r.minSize || Number(size) * px < r.minNotional) throw new Error(`$${usd} is below ${symbol}'s minimum ($${r.minNotional})`);
  return { size, px };
}

// Lead opens a position from chat; on a fill we create a trade card others can copy. Like a copy, it is refused when
// the lead already holds the market, so the lead's net position is exactly this trade and exit detection is sound.
export async function openLead(leadId, symbol, side, usd, chatId) {
  const lead = member(leadId);
  if (holdsAny(await position(keyOf(lead), symbol))) throw new Error(`you already hold ${symbol}; close it first so copies can follow this trade`);
  const { size, px } = await sizeFor(symbol, usd);
  const o = await marketOrder(lead, symbol, side, size);
  if (!(Number(o.filled) > 0)) return { ok: false, order: o };
  const id = crypto.randomUUID().slice(0, 8);
  const fill = await fillPrice(keyOf(lead), symbol, o.orderId).catch(() => null); // the card shows the real fill when Strike has it
  get().trades[id] = { id, leadId: String(leadId), chatId, symbol, side, size: o.filled, markAtOpen: px, fillPrice: fill, openedAt: Date.now(), status: 'open', order: o };
  save();
  return { ok: true, trade: get().trades[id] };
}

// One tap = one copy. The copy record is written before the order so a duplicate tap cannot double-place;
// a failed attempt may be retried (the hold check below runs before anything is placed).
export async function copyTrade(tradeId, copierId, usd, exitMode = process.env.EXIT_DEFAULT ?? 'follow') {
  const t = get().trades[tradeId];
  if (!t) throw new Error('unknown trade');
  if (String(copierId) === t.leadId) throw new Error('that is your own trade');
  if (t.status !== 'open') throw new Error('the lead already closed this trade');
  if (Date.now() - t.openedAt > CARD_TTL_MS) throw new Error('this card is older than 15 minutes; ask the lead for a fresh one');
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('amount must be a positive number of USD');
  const k = `${tradeId}:${copierId}`;
  const prior = get().copies[k];
  if (prior && prior.status !== 'failed') throw new Error(`already copied (${prior.status})`);
  const copier = member(copierId);
  get().copies[k] = { tradeId, copierId: String(copierId), exitMode, status: 'placing', at: Date.now() };
  save();
  const c = get().copies[k];
  try {
    if (holdsAny(await position(keyOf(copier), t.symbol))) throw new Error(`you already hold ${t.symbol}; close it first so the copy can be tracked`);
    const { size } = await sizeFor(t.symbol, usd);
    const o = await marketOrder(copier, t.symbol, t.side, size);
    Object.assign(c, { status: Number(o.filled) > 0 ? 'open' : 'failed', size: o.filled, requested: size, order: o });
    save(); // record the live position before the stop round-trips, so a crash cannot hide it
    if (c.status === 'open') { c.stop = await protect(copier, t, c).catch((e) => ({ error: e.message })); c.stopTriedAt = Date.now(); }
  } catch (e) {
    Object.assign(c, { status: c.status === 'open' ? 'open' : 'failed', error: e.message });
  }
  save();
  return c;
}

// Close only what the copy filled, capped at the live position, reduce-only so it can never flip or touch more.
// The copy is claimed ('closing') before any await, so a second tap or the watcher cannot close it twice.
export async function closeCopy(k) {
  const c = get().copies[k], t = get().trades[c.tradeId];
  if (c.status !== 'open' && c.status !== 'awaiting') return c;
  const prev = c.status;
  c.status = 'closing'; save();
  try {
    const copier = member(c.copierId), r = await rules(t.symbol);
    const qty = floorTo(Math.min(Number(c.size), heldSize(t.side, await position(keyOf(copier), t.symbol))), r.step);
    if (!(Number(qty) > 0)) return await classifyFlat(c, t, copier);
    const o = await marketOrder(copier, t.symbol, flip(t.side), qty, { reduceOnly: true });
    Object.assign(c, Number(o.filled) > 0 ? { status: 'closed', close: o, endedAt: Date.now() } : { status: prev, close: o });
    save();
    return c;
  } catch (e) {
    c.status = prev; save();
    throw e;
  }
}

// The copy's position is gone and Squad did not close it: its stop fired, or the copier closed it elsewhere.
// A failed lookup is retried later rather than guessed (a 5xx must not turn a stop-out into "closed elsewhere").
async function classifyFlat(c, t, copier) {
  const key = keyOf(copier);
  const s = c.stop?.cid ? await getOrder(key, t.symbol, c.stop.cid).catch((e) => { if (e.status === 404) return null; throw e; }) : null;
  if (s && Number(s.Filled) > 0) Object.assign(c, { status: 'stopped', stopFillPrice: await fillPrice(key, t.symbol, s.ID).catch(() => null) });
  else Object.assign(c, { status: 'closed', closeNote: 'closed outside Squad' });
  c.endedAt = Date.now();
  save();
  return c;
}

// The lead is out: follow-mode copies close now; ask-mode copies wait for the copier's tap.
async function exitCopy(k) {
  const c = get().copies[k];
  if (c.exitMode === 'follow') return { k, ...(await closeCopy(k).catch((e) => ({ ...c, status: 'close-failed', error: e.message }))) };
  c.status = 'awaiting'; save();
  return { k, ...c };
}

async function exitCopies(tradeId) {
  const results = [];
  for (const [k, c] of Object.entries(get().copies)) if (c.tradeId === tradeId && c.status === 'open') results.push(await exitCopy(k));
  return results;
}

// Watch Strike for what only shows up there: a lead exiting outside Squad (Strike app, own TP/SL, liquidation), a
// copy whose stop fired or that was closed elsewhere, a copy that filled after its lead had already exited, and a copy
// whose stop failed to arm. Positions are read publicly, once per account per tick, so a revoked key cannot blind the
// watcher. Each trade and copy is handled on its own, so one failing member never stops the others. Statuses are
// re-checked after awaits because /close and button taps run concurrently.
export async function watchOnce() {
  const events = [], positionsOf = new Map();
  const live = async (m, symbol) => {
    if (!positionsOf.has(m.accountId)) positionsOf.set(m.accountId, publicPositions(m.accountId));
    return (await positionsOf.get(m.accountId)).find((p) => p.symbol === symbol) ?? null;
  };
  const isolated = async (m, fn) => {
    try { await fn(); } catch (e) {
      if (e.status === 401 && AUTH_DEAD.test(e.message)) {
        if (!m.needsReconnect) { m.needsReconnect = true; save(); events.push({ type: 'needsReconnect', member: m }); }
      } else console.error(`watch (${m.label}): ${e.message}`);
    }
  };
  for (const t of Object.values(get().trades)) {
    const lead = get().members[t.leadId];
    if (t.status !== 'open' || !lead) continue;
    await isolated(lead, async () => {
      const p = await live(lead, t.symbol);
      if (t.status !== 'open' || heldSize(t.side, p) > 0) return;
      Object.assign(t, { status: 'closed', closedAt: Date.now(), closedBy: 'outside' });
      save();
      events.push({ type: 'leadExited', trade: t, copies: await exitCopies(t.id) });
    });
  }
  for (const [k, c] of Object.entries(get().copies)) {
    const t = get().trades[c.tradeId], copier = get().members[c.copierId];
    if ((c.status !== 'open' && c.status !== 'awaiting') || !t || !copier) continue;
    await isolated(copier, async () => {
      const p = await live(copier, t.symbol);
      if (c.status !== 'open' && c.status !== 'awaiting') return;
      if (heldSize(t.side, p) === 0) {
        events.push({ type: 'copyEnded', trade: t, copy: { k, ...(await classifyFlat(c, t, copier)) } });
      } else if (c.status === 'open' && t.status === 'closed') {
        events.push({ type: 'lateExit', trade: t, copy: await exitCopy(k) });
      } else if (c.status === 'open' && c.stop?.status !== 'untriggered' && Date.now() - (c.stopTriedAt ?? 0) > STOP_RETRY_MS) {
        c.stopTriedAt = Date.now();
        const s = await protect(copier, t, c).catch((e) => ({ error: e.message }));
        if (s.status === 'untriggered') { c.stop = s; events.push({ type: 'stopArmed', trade: t, copy: { k, ...c } }); }
        else c.stop = { ...c.stop, error: s.error ?? s.reason ?? s.status };
        save();
      }
    });
  }
  return events;
}

// Realized P&L per Strike's fill history on the trade's market: the lead since the trade opened, a copy since it was
// placed. Members can't hold the market when a trade or copy starts, so these fills belong to it unless the member
// trades that market by hand in the meantime.
export async function copyPnl(k) {
  const c = get().copies[k], t = get().trades[c.tradeId], m = get().members[c.copierId];
  return sumFills(await fillsSince(keyOf(m), t.symbol, c.at));
}

export async function recap(tradeId) {
  const t = get().trades[tradeId], lead = get().members[t.leadId];
  const rows = [{ who: lead?.label ?? 'lead', status: t.status, ...sumFills(await fillsSince(keyOf(lead), t.symbol, t.openedAt - 10000)) }];
  for (const [k, c] of Object.entries(get().copies)) {
    if (c.tradeId !== tradeId || c.status === 'failed' || c.status === 'placing') continue;
    const who = get().members[c.copierId]?.label ?? 'member';
    rows.push(['closed', 'stopped'].includes(c.status) ? { who, status: c.status, ...(await copyPnl(k)) } : { who, status: c.status });
  }
  return rows;
}

// Lead exits through Squad: close the lead's own position (capped at what it still holds), then the copies.
export async function closeLead(tradeId, leadId) {
  const t = get().trades[tradeId];
  if (!t || t.leadId !== String(leadId)) throw new Error('not your trade');
  if (t.status !== 'open') throw new Error('already closed');
  t.status = 'closing'; save();
  try {
    const lead = member(leadId), r = await rules(t.symbol);
    const qty = floorTo(Math.min(Number(t.size), heldSize(t.side, await position(keyOf(lead), t.symbol))), r.step);
    if (Number(qty) > 0) {
      const o = await marketOrder(lead, t.symbol, flip(t.side), qty, { reduceOnly: true });
      if (!(Number(o.filled) > 0)) throw new Error(`your close did not fill (${o.reason || o.status}); try again`);
      t.close = o;
    }
    Object.assign(t, { status: 'closed', closedAt: Date.now(), closedBy: Number(qty) > 0 ? 'squad' : 'outside' });
    save();
  } catch (e) {
    t.status = 'open'; save();
    throw e;
  }
  return { trade: t, copies: await exitCopies(tradeId) };
}
