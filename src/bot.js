// Telegram layer over the raw Bot API (long polling). Members are keyed by Telegram user id.
import { connectUrl } from './server.js';
import { openLead, copyTrade, closeLead, closeCopy, lossAtStop, copyPnl, recap } from './copy.js';
import { get, save } from './store.js';

const TG = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export async function tg(method, body) {
  // getUpdates long-polls for 25s; anything else that hangs is cut off so one dead socket cannot freeze the bot.
  const r = await fetch(`${TG()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}
const say = (chat_id, text, buttons) => tg('sendMessage', { chat_id, text, ...(buttons && { reply_markup: { inline_keyboard: buttons } }) });
const who = (u) => (u.username ? `@${u.username}` : u.first_name);
const SYMBOLS = (process.env.MAKER_SYMBOLS ?? 'ETH-USD').split(',').map((s) => s.trim().replace('-USD', '')); // only markets with liquidity
const COPY_SIZES = [25, 50, 100];
const MAX_TRADE_USD = () => Number(process.env.MAX_TRADE_USD ?? 500);
const usdOf = (n) => `$${Number(n).toFixed(2)}`;
const qty = (x) => String(Number(x)); // engine sends 18-decimal strings
const money = (x) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const label = (id) => get().members[id]?.label ?? 'a member';
const stopPct = () => Number(process.env.COPY_STOP_PCT ?? 3);
const sideWord = (t) => (t.side === 'buy' ? 'long' : 'short');

// Strike validates the builder header on submit (400 if over the cap), but filled orders read back without
// their Builder field, so the card states the code the order was sent with.
function card(t, lead) {
  return `${lead} opened ${sideWord(t).toUpperCase()} ${t.symbol}\n` +
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

const askToClose = (t, c) => say(c.copierId, `${label(t.leadId)} is out of ${t.symbol}. Close your copy too?`,
  [[{ text: 'Close my copy', callback_data: `close:${c.k}` }, { text: 'Keep it', callback_data: `keep:${c.k}` }]])
  .catch(() => say(t.chatId, `${label(c.copierId)}: DM me /start so I can ask you privately.`));

// Strike's realized P&L, read back from fill history once the fills have landed.
async function postRecap(t) {
  await new Promise((r) => setTimeout(r, 2000));
  const rows = await recap(t.id);
  const parts = rows.map((r) => (r.realized === undefined ? `${r.who} ${r.status === 'awaiting' ? 'still open (asked)' : r.status}` : `${r.who} ${money(r.realized)}${r.status === 'stopped' ? ' (stopped)' : ''}`));
  return say(t.chatId, `Result · ${t.symbol} ${sideWord(t)} (Strike realized P&L, before fees)\n${parts.join(' · ')}`);
}

// One announcement path for /close and for exits the watcher finds on Strike.
async function announceExit(t, copies) {
  const how = t.closedBy === 'outside' ? 'exited outside Squad (Strike app, own TP/SL or liquidation)' : `closed (${qty(t.close?.filled ?? t.size)} filled)`;
  await say(t.chatId, `${label(t.leadId)} ${how}: ${t.symbol}.${copies.length ? '\n' + copies.map(copyLine).join('\n') : ''}`);
  for (const c of copies.filter((c) => c.status === 'awaiting')) await askToClose(t, c);
  await postRecap(t);
}

async function announceCopyEnd(t, c) {
  const p = await copyPnl(c.k).catch(() => null);
  return say(t.chatId, `${copyLine(c)} (${label(t.leadId)}'s ${t.symbol} ${sideWord(t)})${p ? ` · realized ${money(p.realized)} (Strike, before fees)` : ''}`);
}

// Watcher events from main.js. Trades created before chat ids were stored have nowhere to post.
export async function announce(ev) {
  if (ev.type === 'needsReconnect') return say(ev.member.memberId ?? Object.keys(get().members).find((id) => get().members[id] === ev.member),
    'Your Squad trading key stopped working (it was replaced or revoked). DM me /connect to link your wallet again.').catch(() => {});
  if (!ev.trade.chatId) return;
  if (ev.type === 'leadExited') return announceExit(ev.trade, ev.copies);
  if (ev.type === 'copyEnded') return announceCopyEnd(ev.trade, ev.copy);
  if (ev.type === 'lateExit') {
    if (ev.copy.status === 'awaiting') return askToClose(ev.trade, ev.copy);
    return announceCopyEnd(ev.trade, ev.copy);
  }
  if (ev.type === 'stopArmed') return say(ev.trade.chatId, `${label(ev.copy.copierId)}: stop now set at ${ev.copy.stop.price} for their ${ev.trade.symbol} copy (retried).`);
}

const TRADE_COMMANDS = ['/long', '/short', '/close'];

async function onCommand(msg) {
  const chat = msg.chat.id, user = msg.from, text = msg.text.trim();
  const [cmd, ...args] = text.split(/\s+/);
  const c = cmd.replace(/@\w+$/, '').toLowerCase();
  if (c === '/start') return say(chat, 'Squad lets this group trade Strike perps together.\n/connect (in DM) links your Strike testnet wallet.\nIn the group: /long ETH 50, /short ETH 25, /close, /exits follow|ask, /stop 3 (stop-loss % on your copies).');
  if (c === '/connect') {
    if (msg.chat.type !== 'private') return say(chat, `${who(user)}, DM me /connect so your link stays private.`);
    return say(chat, `Open this on the computer with your Cardano wallet (valid 30 min, one use):\n${connectUrl(user.id, who(user))}`);
  }
  if (TRADE_COMMANDS.includes(c) && !['group', 'supergroup'].includes(msg.chat.type)) return say(chat, 'Trade in a group, so your squad sees the card and can copy it.');
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
    if (!SYMBOLS.includes(sym) || !Number.isFinite(usd) || usd <= 0) return say(chat, `Usage: ${c} ETH 50  (markets: ${SYMBOLS.join(', ')}; amount in USD notional)`);
    if (usd > MAX_TRADE_USD()) return say(chat, `${who(user)}: $${usd} is above Squad's $${MAX_TRADE_USD()} per-trade limit.`);
    const r = await openLead(user.id, `${sym}-USD`, c === '/long' ? 'buy' : 'sell', usd, chat);
    if (!r.ok) return say(chat, `${who(user)}: order not filled (${r.order.status}${r.order.reason ? `: ${r.order.reason}` : ''}).`);
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
  const [action, a, b] = String(q.data ?? '').split(':');
  const chat = q.message?.chat?.id ?? q.from.id;
  // Telegram caps the answer at 200 chars and allows one answer per tap.
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190), show_alert: text.length > 60 });
  try {
    if (action === 'copy') {
      if (!COPY_SIZES.includes(Number(b))) return answer('Unknown amount.');
      await answer('Copying…');
      const c = await copyTrade(a, q.from.id, Number(b), get().members[String(q.from.id)]?.exitMode);
      const t = get().trades[a];
      return say(chat, c.status === 'open'
        ? `${who(q.from)} copied ${t.symbol} ${sideWord(t)}: ${qty(c.size)} filled (asked $${b}). Exit: ${c.exitMode === 'ask' ? 'ask me' : 'with the lead'}. ` +
          (c.stop?.status === 'untriggered'
            ? `Stop at ${c.stop.price} (${c.stop.pct}% from entry ${c.stop.entry.toFixed(2)}): max loss ≈ ${usdOf(lossAtStop(c.size, c.stop.entry, c.stop.price))} if it fills at the stop.`
            : `Stop NOT set yet (${c.stop?.error ?? c.stop?.reason ?? c.stop?.status}); Squad keeps retrying.`)
        : `${who(q.from)}: copy failed (${c.error ?? c.order?.reason ?? c.status}).`);
    }
    if (action === 'close' || action === 'keep') {
      const k = `${a}:${b}`, c = get().copies[k];
      if (!c || c.copierId !== String(q.from.id)) return answer('Not your copy.');
      if (c.status !== 'awaiting') return answer(`Already handled (${c.status}).`);
      const t = get().trades[c.tradeId];
      if (q.message) await tg('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      if (action === 'keep') {
        c.status = 'kept'; save();
        await answer('Kept. It is yours to manage now; its stop stays on Strike.');
        return t.chatId && say(t.chatId, `${label(c.copierId)} kept their copy of ${label(t.leadId)}'s ${t.symbol} trade open.`);
      }
      await answer('Closing…');
      const r = await closeCopy(k);
      if (r.status === 'closed' || r.status === 'stopped') { await new Promise((res) => setTimeout(res, 2000)); return t.chatId && announceCopyEnd(t, { k, ...r }); }
      return say(chat, `Close did not fill (${r.close?.reason ?? r.status}). Tap again from a fresh prompt or close it in the Strike app.`);
    }
    return answer('Unknown button.');
  } catch (e) {
    // Copy and close already answered the tap, so their errors go to the chat.
    if (action === 'copy' || action === 'close') return say(chat, `${who(q.from)}: ${action} refused (${e.message}).`).catch(() => {});
    return answer(e.message).catch(() => {});
  }
}

export async function poll() {
  // The offset is saved before handling: after a crash or restart, an update is handled at most once. A repeated
  // /long or Copy tap would place a second real order; a lost one is visible in the chat and can simply be resent.
  let offset = get().tgOffset ?? 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (updates.length) { get().tgOffset = offset = updates.at(-1).update_id + 1; save(); }
      for (const u of updates) {
        if (u.message?.text?.startsWith('/')) onCommand(u.message).catch((e) => say(u.message.chat.id, `Error: ${e.message}`).catch(() => {}));
        else if (u.callback_query) onCallback(u.callback_query).catch((e) => console.error('callback:', e.message));
      }
    } catch (e) { console.error(e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
