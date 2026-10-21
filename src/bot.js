// Telegram layer over the raw Bot API (long polling). Members are keyed by Telegram user id.
import { connectUrl } from './server.js';
import { openLead, copyTrade, closeLead, closeCopy, lossAtStop, copyPnl, recap } from './copy.js';
import { get, save } from './store.js';

const TG = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export async function tg(method, body) {
  const r = await fetch(`${TG()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}
const say = (chat_id, text, buttons) => tg('sendMessage', { chat_id, text, ...(buttons && { reply_markup: { inline_keyboard: buttons } }) });
const who = (u) => (u.username ? `@${u.username}` : u.first_name);
const SYMBOLS = (process.env.MAKER_SYMBOLS ?? 'ETH-USD').split(',').map((s) => s.trim().replace('-USD', '')); // only markets with liquidity
const COPY_SIZES = [25, 50, 100];
const usdOf = (n) => `$${Number(n).toFixed(2)}`;
const qty = (x) => String(Number(x)); // engine sends 18-decimal strings
const money = (x) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const label = (id) => get().members[id]?.label ?? id;
const stopPct = () => Number(process.env.COPY_STOP_PCT ?? 3);

// Strike validates the builder header on submit (400 if over the cap), but filled orders read back without
// their Builder field, so the card states the code the order was sent with.
function card(t, lead) {
  return `${lead} opened ${t.side === 'buy' ? 'LONG' : 'SHORT'} ${t.symbol}\n` +
    `${qty(t.size)} ${t.symbol.replace('-USD', '')} · ~${usdOf(Number(t.size) * t.markAtOpen)} at ${Number(t.markAtOpen).toFixed(2)}\n` +
    `Strike order #${t.order.orderId} · builder ${process.env.BUILDER_CODE} (${process.env.BUILDER_FEE_BPS ?? 10} bps)\n` +
    `Every copy gets a ${stopPct()}% stop: max loss ≈ ${usdOf(25 * stopPct() / 100)} per $25 copied (fees extra; /stop to change yours).\n` +
    `Copy this one trade at your own size. Card valid 15 min.`;
}

function copyLine(c) {
  const name = label(c.copierId);
  if (c.status === 'closed') return c.closeNote ? `${name}: copy was already closed outside Squad` : `${name}: copy closed (${qty(c.close?.filled ?? c.size)})`;
  if (c.status === 'stopped') return `${name}: copy was stopped out${c.stopFillPrice ? ` at ${c.stopFillPrice.toFixed(2)}` : ''}`;
  if (c.status === 'awaiting') return `${name}: waiting for their OK`;
  return `${name}: ${c.status}${c.error ? ` (${c.error})` : ''}`;
}

// Strike's realized P&L, read back from fill history once the fills have landed.
async function postRecap(t) {
  await new Promise((r) => setTimeout(r, 2000));
  const rows = await recap(t.id);
  const parts = rows.map((r) => (r.realized === undefined ? `${r.who} ${r.status === 'awaiting' ? 'still open (asked)' : r.status}` : `${r.who} ${money(r.realized)}${r.status === 'stopped' ? ' (stopped)' : ''}`));
  return say(t.chatId, `Result · ${t.symbol} ${t.side === 'buy' ? 'long' : 'short'} (Strike realized P&L, before fees)\n${parts.join(' · ')}`);
}

// One announcement path for /close and for exits the watcher finds on Strike.
async function announceExit(t, copies) {
  const how = t.closedBy === 'outside' ? 'exited outside Squad (Strike app, own TP/SL or liquidation)' : `closed (${qty(t.close?.filled ?? t.size)} filled)`;
  await say(t.chatId, `${label(t.leadId)} ${how}: ${t.symbol}.${copies.length ? '\n' + copies.map(copyLine).join('\n') : ''}`);
  for (const c of copies.filter((c) => c.status === 'awaiting')) {
    await say(c.copierId, `${label(t.leadId)} is out of ${t.symbol}. Close your copy too?`, [[{ text: 'Close my copy', callback_data: `close:${c.k}` }, { text: 'Keep it', callback_data: `keep:${c.k}` }]])
      .catch(() => say(t.chatId, `${label(c.copierId)}: DM me /start so I can ask you privately.`));
  }
  await postRecap(t);
}

async function announceCopyEnd(t, c) {
  const p = await copyPnl(c.k).catch(() => null);
  return say(t.chatId, `${copyLine(c)} (${label(t.leadId)}'s ${t.symbol} ${t.side === 'buy' ? 'long' : 'short'})${p ? ` · realized ${money(p.realized)} (Strike, before fees)` : ''}`);
}

// Watcher events from main.js. Trades created before chat ids were stored have nowhere to post.
export async function announce(ev) {
  if (!ev.trade.chatId) return;
  if (ev.type === 'leadExited') return announceExit(ev.trade, ev.copies);
  if (ev.type === 'copyEnded') return announceCopyEnd(ev.trade, ev.copy);
}

async function onCommand(msg) {
  const chat = msg.chat.id, user = msg.from, text = msg.text.trim();
  const [cmd, ...args] = text.split(/\s+/);
  const c = cmd.replace(/@\w+$/, '').toLowerCase();
  if (c === '/start') return say(chat, 'Squad lets this group trade Strike perps together.\n/connect (in DM) links your Strike testnet wallet.\nIn the group: /long ETH 50, /short ETH 25, /close, /exits follow|ask, /stop 3 (stop-loss % on your copies).');
  if (c === '/connect') {
    if (msg.chat.type !== 'private') return say(chat, `${who(user)}, DM me /connect so your link stays private.`);
    return say(chat, `Open this on the computer with your Cardano wallet (valid 30 min, one use):\n${connectUrl(user.id, who(user))}`);
  }
  if (c === '/exits') {
    const m = get().members[String(user.id)];
    if (!m) return say(chat, 'Connect first: DM me /connect');
    if (!['follow', 'ask'].includes(args[0])) return say(chat, `Your copies currently ${m.exitMode === 'ask' ? 'ask before closing' : 'close when the lead closes'}. Use /exits follow or /exits ask.`);
    m.exitMode = args[0]; save();
    return say(chat, args[0] === 'follow' ? 'Your copies will close when the lead closes.' : 'You will be asked before your copies close.');
  }
  if (c === '/stop') {
    const m = get().members[String(user.id)];
    if (!m) return say(chat, 'Connect first: DM me /connect');
    const pct = Number(args[0]);
    if (!(pct >= 0.5 && pct <= 10)) return say(chat, `Your copies get a stop ${m.stopPct ?? stopPct()}% from entry. Use /stop 2 (0.5–10).`);
    m.stopPct = pct; save();
    return say(chat, `New copies get a stop ${pct}% from your entry.`);
  }
  if (c === '/long' || c === '/short') {
    const sym = (args[0] ?? '').toUpperCase(), usd = Number(args[1]);
    if (!SYMBOLS.includes(sym) || !(usd > 0)) return say(chat, `Usage: ${c} ETH 50  (markets: ${SYMBOLS.join(', ')}; amount in USD notional)`);
    const r = await openLead(user.id, `${sym}-USD`, c === '/long' ? 'buy' : 'sell', usd);
    if (!r.ok) return say(chat, `${who(user)}: order not filled (${r.order.status}${r.order.reason ? `: ${r.order.reason}` : ''}).`);
    r.trade.chatId = chat; save();
    return say(chat, card(r.trade, who(user)), [COPY_SIZES.map((n) => ({ text: `Copy $${n}`, callback_data: `copy:${r.trade.id}:${n}` }))]);
  }
  if (c === '/close') {
    const mine = Object.values(get().trades).filter((t) => t.leadId === String(user.id) && t.status === 'open').sort((a, b) => b.openedAt - a.openedAt);
    if (!mine.length) return say(chat, 'You have no open Squad trade.');
    const r = await closeLead(mine[0].id, user.id);
    r.trade.chatId ??= chat;
    return announceExit(r.trade, r.copies);
  }
}

async function onCallback(q) {
  const [action, a, b] = q.data.split(':');
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: text.length > 60 });
  try {
    if (action === 'copy') {
      await answer('Copying…');
      const c = await copyTrade(a, q.from.id, Number(b), get().members[String(q.from.id)]?.exitMode);
      const t = get().trades[a];
      return say(q.message.chat.id, c.status === 'open'
        ? `${who(q.from)} copied ${t.symbol} ${t.side === 'buy' ? 'long' : 'short'}: ${qty(c.size)} filled (asked $${b}). Exit: ${c.exitMode === 'ask' ? 'ask me' : 'with the lead'}. ` +
          (c.stop?.status === 'untriggered'
            ? `Stop at ${c.stop.price} (${c.stop.pct}% from entry ${c.stop.entry.toFixed(2)}): max loss ≈ ${usdOf(lossAtStop(c.size, c.stop.entry, c.stop.price))} if it fills at the stop.`
            : `Stop NOT set (${c.stop?.error ?? c.stop?.reason ?? c.stop?.status}).`)
        : `${who(q.from)}: copy failed (${c.error ?? c.order?.reason ?? c.status}).`);
    }
    if (action === 'close' || action === 'keep') {
      const k = `${a}:${b}`, c = get().copies[k];
      if (!c || c.copierId !== String(q.from.id)) return answer('Not your copy.');
      const t = get().trades[c.tradeId];
      if (action === 'keep') {
        c.status = 'kept'; save();
        await answer('Kept. It is yours to manage now; its stop stays on Strike.');
        return t.chatId && say(t.chatId, `${label(c.copierId)} kept their copy of ${label(t.leadId)}'s ${t.symbol} trade open.`);
      }
      const r = await closeCopy(k);
      await answer(r.status === 'closed' || r.status === 'stopped' ? 'Done.' : `Close did not fill (${r.close?.reason ?? r.status}).`);
      if (t.chatId && (r.status === 'closed' || r.status === 'stopped')) { await new Promise((res) => setTimeout(res, 2000)); return announceCopyEnd(t, { k, ...r }); }
    }
  } catch (e) {
    // A callback can be answered only once; the copy path already answered "Copying…", so refusals go to the chat.
    if (action === 'copy') return say(q.message.chat.id, `${who(q.from)}: copy refused (${e.message}).`).catch(() => {});
    return answer(e.message).catch(() => {});
  }
}

export async function poll() {
  // The offset is persisted so a restart (crash, reboot, deploy) never re-handles a /long or a Copy tap.
  let offset = get().tgOffset ?? 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (updates.length) { get().tgOffset = offset = updates.at(-1).update_id + 1; save(); }
      for (const u of updates) {
        if (u.message?.text?.startsWith('/')) onCommand(u.message).catch((e) => say(u.message.chat.id, `Error: ${e.message}`).catch(() => {}));
        else if (u.callback_query) onCallback(u.callback_query);
      }
    } catch (e) { console.error(e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
