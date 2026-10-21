// Strike API client: Ed25519 API-wallet signing, Builder Connect, signed requests.
import crypto from 'node:crypto';

export const API = process.env.STRIKE_API ?? 'https://api-v2-testnet.strikefinance.org';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

export function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return keyFromSeed(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('hex'));
}

export function keyFromSeed(seedHex) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { seedHex, publicKeyHex: pub.toString('hex'), publicKey: pub, sign: (msg) => crypto.sign(null, Buffer.from(msg), privateKey) };
}

export const sha256Hex = (s) => crypto.createHash('sha256').update(s ?? '').digest('hex');

// {METHOD}:{PATH}:{TIMESTAMP}:{NONCE}:{BODY_HASH}; PATH includes the raw query string as sent.
export function signHeaders(key, method, pathWithQuery, bodyStr, ts, nonce = crypto.randomUUID()) {
  const msg = `${method.toUpperCase()}:${pathWithQuery}:${ts}:${nonce}:${sha256Hex(bodyStr)}`;
  return {
    'X-API-Wallet-Public-Key': key.publicKeyHex,
    'X-API-Wallet-Signature': key.sign(msg).toString('hex'),
    'X-API-Wallet-Timestamp': String(ts),
    'X-API-Wallet-Nonce': nonce,
  };
}

let skewMs = null, skewAt = 0; // server time minus local time, re-measured every 10 min so clock drift can't expire signatures
const TIMEOUT = () => AbortSignal.timeout(15000); // one hung socket must not stall the watcher or the bot
async function serverSeconds() {
  if (skewMs === null || Date.now() - skewAt > 10 * 60 * 1000) {
    const r = await (await fetch(`${API}/v2/time`, { signal: TIMEOUT() })).json();
    skewMs = Number(r.serverTime) - Date.now(); skewAt = Date.now();
  }
  return Math.floor((Date.now() + skewMs) / 1000) - 1; // server rejects timestamps even 1s ahead
}

export async function call(key, method, path, body, { builderFeeBps } = {}) {
  const bodyStr = body === undefined ? undefined : JSON.stringify(body); // serialize once; hash exactly what is sent
  const headers = signHeaders(key, method, path, bodyStr, await serverSeconds());
  if (bodyStr !== undefined) headers['Content-Type'] = 'application/json';
  if (builderFeeBps !== undefined) headers['X-Builder-Fee-Bps'] = String(builderFeeBps);
  const res = await fetch(API + path, { method, headers, body: bodyStr, signal: TIMEOUT() });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`), { status: res.status, data });
  return data;
}

export async function publicGet(path) {
  const res = await fetch(API + path, { signal: TIMEOUT() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: TIMEOUT() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Builder Connect step 1: the dApp-generated API key is bound to the user's wallet + builder code.
export const requestSignature = ({ address, chain, code, feeBps, apiKey }) =>
  post('/auth/builder/request-signature', { address, chain, code, fee_share_bps: feeBps, public_key: apiKey.publicKeyHex });

// Step 2: the user's wallet signature over message_to_sign (format depends on chain).
export const verifySignature = ({ nonce, walletSignature }) =>
  post('/auth/builder/verify-signature', { nonce, wallet_signature: walletSignature });
