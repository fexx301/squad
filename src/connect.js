// Builder Connect for Cardano CIP-30 wallets: one-time link -> challenge -> wallet signData -> API wallet.
import crypto from 'node:crypto';
import { newKey, requestSignature, verifySignature } from './strike.js';
import { get, save } from './store.js';

const LINK_TTL_MS = 30 * 60 * 1000;

export function createLink(memberId, label) {
  const token = crypto.randomBytes(16).toString('hex');
  get().links[token] = { memberId: String(memberId), label, createdAt: Date.now() };
  save();
  return token;
}

const TOKEN = /^[0-9a-f]{32}$/; // createLink issues 16 random bytes as hex

function liveLink(token) {
  const l = typeof token === 'string' && TOKEN.test(token) ? get().links[token] : undefined;
  if (!l || l.used || Date.now() - l.createdAt > LINK_TTL_MS) throw new Error('link expired or already used');
  return l;
}

export async function start(token, address) {
  const link = liveLink(token);
  if (!/^addr_test1[0-9a-z]+$/.test(address)) throw new Error('expected a Cardano testnet (addr_test1…) address');
  const apiKey = newKey();
  const ch = await requestSignature({ address, chain: 'cardano', code: process.env.BUILDER_CODE, feeBps: Number(process.env.BUILDER_FEE_BPS ?? 10), apiKey });
  Object.assign(link, { address, apiSeed: apiKey.seedHex, nonce: ch.nonce });
  save();
  return { message: ch.message_to_sign };
}

export async function finish(token, walletSignature) {
  const link = liveLink(token);
  if (!link.nonce) throw new Error('start the connection first');
  const v = await verifySignature({ nonce: link.nonce, walletSignature });
  link.used = true;
  // Reconnecting keeps the member's settings (/exits, /stop); the new key replaces the old one, which Strike revokes.
  get().members[link.memberId] = {
    ...get().members[link.memberId], needsReconnect: false,
    label: link.label, address: link.address, accountId: v.account_id, apiSeed: link.apiSeed,
    feeBps: v.fee_share_bps, expiresAt: v.api_wallet_expired_at, connectedAt: Date.now(),
  };
  save();
  return { memberId: link.memberId, accountId: v.account_id, label: link.label };
}
