// Telegram layer over the raw Bot API (long polling). Members are keyed by Telegram user id.
import { connectUrl } from './server.js';
import { openLead, copyTrade, closeLead, closeCopy } from './copy.js';
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
const SYMBOLS = ['SOL', 'BTC', 'ETH', 'ADA'];
const COPY_SIZES = [25, 50, 100];
const usdOf = (n) => `$${Number(n).toFixed(2)}`;

function card(t, lead) {
  const b = t.order.builder;
  return `${lead} opened ${t.side === 'buy' ? 'LONG' : 'SHORT'} ${t.symbol}\n` +
    `size ${t.size} (~${usdOf(Number(t.size) * t.markAtOpen)} at ${t.markAtOpen})\n` +
    `Strike order #${t.order.orderId}${b ? ` · builder ${b.Code} ${b.FeeBps} bps` : ''}\n` +
    `Copy this one trade at your size. Card valid 15 min.`;
}

async function onCommand(msg) {
  const chat = msg.chat.id, user = msg.from, text = msg.text.trim();
  const [cmd, ...args] = text.split(/\s+/);
  const c = cmd.replace(/@\w+$/, '').toLowerCase();
  if (c === '/start') return say(chat, 'Squad lets this group trade Strike perps together.\n/connect (in DM) links your Strike testnet wallet.\nIn the group: /long SOL 50, /short SOL 50, /close, /exits follow|ask.');
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
  if (c === '/long' || c === '/short') {
    const sym = (args[0] ?? '').toUpperCase(), usd = Number(args[1]);
    if (!SYMBOLS.includes(sym) || !(usd > 0)) return say(chat, `Usage: ${c} SOL 50  (markets: ${SYMBOLS.join(', ')}; amount in USD notional)`);
    const r = await openLead(user.id, `${sym}-USD`, c === '/long' ? 'buy' : 'sell', usd);
    if (!r.ok) return say(chat, `${who(user)}: order not filled (${r.order.status}${r.order.reason ? `: ${r.order.reason}` : ''}).`);
    return say(chat, card(r.trade, who(user)), [COPY_SIZES.map((n) => ({ text: `Copy $${n}`, callback_data: `copy:${r.trade.id}:${n}` }))]);
  }
  if (c === '/close') {
    const mine = Object.values(get().trades).filter((t) => t.leadId === String(user.id) && t.status === 'open').sort((a, b) => b.openedAt - a.openedAt);
    if (!mine.length) return say(chat, 'You have no open Squad trade.');
    const r = await closeLead(mine[0].id, user.id);
    const lines = r.copies.map((c) => {
      const name = get().members[c.copierId]?.label ?? c.copierId;
      if (c.status === 'closed') return `${name}: copy closed (${c.close?.filled ?? c.size})`;
      if (c.status === 'awaiting') return `${name}: waiting for your OK`;
      return `${name}: ${c.status}${c.error ? ` (${c.error})` : ''}`;
    });
    await say(chat, `${who(user)} closed ${r.trade.symbol} (${r.trade.close.filled} filled).${lines.length ? '\n' + lines.join('\n') : ''}`);
    for (const c of r.copies.filter((c) => c.status === 'awaiting')) {
      await say(c.copierId, `${who(user)} closed ${r.trade.symbol}. Close your copy too?`, [[{ text: 'Close my copy', callback_data: `close:${c.k}` }, { text: 'Keep it', callback_data: `keep:${c.k}` }]])
        .catch(() => say(chat, `${get().members[c.copierId]?.label}: DM me /start so I can ask you privately.`));
    }
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
        ? `${who(q.from)} copied ${t.symbol} ${t.side === 'buy' ? 'long' : 'short'}: ${c.size} filled (asked $${b}). Exit: ${c.exitMode === 'ask' ? 'ask me' : 'with the lead'}.`
        : `${who(q.from)}: copy failed (${c.error ?? c.order?.reason ?? c.status}).`);
    }
    if (action === 'close' || action === 'keep') {
      const k = `${a}:${b}`, c = get().copies[k];
      if (!c || c.copierId !== String(q.from.id)) return answer('Not your copy.');
      if (action === 'keep') { c.status = 'kept'; save(); return answer('Kept. It is yours to manage now.'); }
      const r = await closeCopy(k);
      return answer(r.status === 'closed' ? 'Copy closed.' : `Close did not fill (${r.close?.reason ?? r.status}).`);
    }
  } catch (e) {
    return answer(e.message).catch(() => {});
  }
}

export async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message?.text?.startsWith('/')) onCommand(u.message).catch((e) => say(u.message.chat.id, `Error: ${e.message}`).catch(() => {}));
        else if (u.callback_query) onCallback(u.callback_query);
      }
    } catch (e) { console.error(e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
