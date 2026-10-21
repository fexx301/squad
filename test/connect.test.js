import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.SQUAD_DB = path.join(os.tmpdir(), `squad-connect-test-${process.pid}.json`);
const { get } = await import('../src/store.js');
const { start, finish, createLink } = await import('../src/connect.js');

test('prototype keys cannot pass the link check or pollute Object.prototype', async () => {
  for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', { length: 32 }, '0'.repeat(32)]) {
    await assert.rejects(start(t, 'addr_test1qq'), /link expired or already used/); // thrown before any network call
    await assert.rejects(finish(t, 'sig:key'), /link expired or already used/);
  }
  assert.equal(({}).address, undefined);
  assert.equal(({}).nonce, undefined);
  assert.equal(({}).used, undefined);
  assert.equal(get().links.__proto__, undefined);
});

test('a real link still works up to the address check', async () => {
  const t = createLink('42', 'Tester');
  assert.match(t, /^[0-9a-f]{32}$/);
  await assert.rejects(start(t, 'addr1mainnet'), /Cardano testnet/);
});
