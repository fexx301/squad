// Squad: one process runs the connect server, the Telegram bot and (optionally) the testnet Maker.
try { process.loadEnvFile(); } catch {}
const { serve, connectUrl } = await import('./server.js');
const { poll, tg } = await import('./bot.js');
const { get } = await import('./store.js');
const { keyFromSeed } = await import('./strike.js');
const { runMaker } = await import('./maker.js');

process.env.MAKER_SYMBOLS ??= 'ETH-USD'; // testnet ADA has order_min_price 10 (mark ~0.23), so ADA orders are rejected
process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message ?? e)); // log, don't exit mid-order
for (const k of ['TELEGRAM_BOT_TOKEN', 'BUILDER_CODE']) if (!process.env[k]) { console.error(`Set ${k} in .env`); process.exit(1); }

// Testnet books where stale quotes sit below the mark (SOL, BTC) would cross our post-only bid, so quote ETH/ADA.
// Started once: a second loop on the same account would cancel the first one's quotes on every cycle.
let makerStarted = false;
const startMaker = () => {
  if (makerStarted) return console.log('maker already running; restart Squad to use a reconnected Maker key');
  makerStarted = true;
  process.env.MAKER_SYMBOLS.split(',').forEach((s) => runMaker(keyFromSeed(get().members.maker.apiSeed), s.trim()));
};
serve({ onConnected: (d) => {
  console.log('connected:', d);
  if (d.memberId === 'maker') return startMaker();
  tg('sendMessage', { chat_id: d.memberId, text: `Connected. Strike testnet account ${d.accountId}.` }).catch(() => {});
} });
if (get().members.maker) startMaker();
else console.log(`No Maker connected. Connect the Maker wallet here: ${connectUrl('maker', 'Maker')}`);
// Watch Strike for exits made outside Squad and for fired copy stops, and announce them in the trade's group.
const { watchOnce } = await import('./copy.js');
const { announce } = await import('./bot.js');
(async () => {
  for (;;) {
    try { for (const ev of await watchOnce()) await announce(ev).catch((e) => console.error('announce:', e.message)); }
    catch (e) { console.error('watch:', e.message); }
    await new Promise((r) => setTimeout(r, Number(process.env.WATCH_MS ?? 5000)));
  }
})();
console.log('bot polling…');
poll();
