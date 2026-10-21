// Squad: one process runs the connect server, the Telegram bot and (optionally) the testnet Maker.
try { process.loadEnvFile(); } catch {}
const { serve, connectUrl } = await import('./server.js');
const { poll, tg } = await import('./bot.js');
const { get } = await import('./store.js');
const { keyFromSeed } = await import('./strike.js');
const { runMaker } = await import('./maker.js');

for (const k of ['TELEGRAM_BOT_TOKEN', 'BUILDER_CODE']) if (!process.env[k]) { console.error(`Set ${k} in .env`); process.exit(1); }

const startMaker = () => runMaker(keyFromSeed(get().members.maker.apiSeed), process.env.MAKER_SYMBOL ?? 'SOL-USD');
serve({ onConnected: (d) => {
  console.log('connected:', d);
  if (d.memberId === 'maker') return startMaker();
  tg('sendMessage', { chat_id: d.memberId, text: `Connected. Strike testnet account ${d.accountId}.` }).catch(() => {});
} });
if (get().members.maker) startMaker();
else console.log(`No Maker connected. Connect the Maker wallet here: ${connectUrl('maker', 'Maker')}`);
console.log('bot polling…');
poll();
