// Gate probe: Builder Connect with a throwaway Solana wallet, then a signed account read.
// Usage: node scripts/probe.js            (needs BUILDER_CODE in .env)
//        node scripts/probe.js --format   (no builder code: checks signing reaches key lookup)
import fs from 'node:fs';
try { process.loadEnvFile(); } catch {}
const { newKey, base58, call, requestSignature, verifySignature } = await import('../src/strike.js');

if (process.argv.includes('--format')) {
  try { await call(newKey(), 'GET', '/v2/account'); console.log('unexpected success'); }
  catch (e) { console.log(e.message); process.exit(/authentication failed/.test(e.message) ? 0 : 1); }
}

const code = process.env.BUILDER_CODE;
if (!code) { console.error('Set BUILDER_CODE in .env'); process.exit(1); }
const wallet = newKey(), apiKey = newKey();
const address = base58(wallet.publicKey);
const ch = await requestSignature({ address, chain: 'solana', code, feeBps: Number(process.env.BUILDER_FEE_BPS ?? 10), apiKey });
const v = await verifySignature({ nonce: ch.nonce, walletSignature: base58(wallet.sign(ch.message_to_sign)) });
console.log('connected:', { account_id: v.account_id, builder_code: v.builder_code, fee_share_bps: v.fee_share_bps, expires: v.api_wallet_expired_at });
const acct = await call(apiKey, 'GET', '/v2/account');
console.log('signed GET /v2/account ok:', Object.keys(acct).slice(0, 12));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(`data/probe-${Date.now()}.json`, JSON.stringify({ address, walletSeed: wallet.seedHex, apiSeed: apiKey.seedHex, ...v }, null, 2));
