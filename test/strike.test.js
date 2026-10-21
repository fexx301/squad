import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { base58, newKey, keyFromSeed, signHeaders, sha256Hex } from '../src/strike.js';

test('base58 known vectors', () => {
  assert.equal(base58(Buffer.from('Hello World')), 'JxF12TrwUP45BMd');
  assert.equal(base58(Buffer.from([0, 0, 1])), '112');
});

test('empty body hash is sha256 of empty input', () => {
  assert.equal(sha256Hex(undefined), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('key round-trips through seed', () => {
  const k = newKey();
  assert.equal(keyFromSeed(k.seedHex).publicKeyHex, k.publicKeyHex);
  assert.equal(k.publicKeyHex.length, 64);
});

test('signature covers method, path+query, ts, nonce and body hash', () => {
  const k = newKey();
  const body = JSON.stringify({ symbol: 'SOL-USD', side: 'BUY' });
  const h = signHeaders(k, 'post', '/v2/openOrders?symbol=SOL-USD', body, 1700000000, 'n'.repeat(16));
  const msg = `POST:/v2/openOrders?symbol=SOL-USD:1700000000:${'n'.repeat(16)}:${sha256Hex(body)}`;
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.publicKey.toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify(null, Buffer.from(msg), pub, Buffer.from(h['X-API-Wallet-Signature'], 'hex')));
  assert.equal(h['X-API-Wallet-Signature'].length, 128);
});
