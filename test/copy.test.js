import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.SQUAD_DB = path.join(os.tmpdir(), `squad-test-${process.pid}.json`);
const { get } = await import('../src/store.js');
const { copyTrade } = await import('../src/copy.js');

const trade = (over = {}) => ({ id: 't1', leadId: '1', symbol: 'SOL-USD', side: 'buy', size: '1', openedAt: Date.now(), status: 'open', ...over });

test('copy guards reject before any order is placed', async () => {
  const db = get();
  db.trades.t1 = trade();
  await assert.rejects(copyTrade('nope', '2', 50), /unknown trade/);
  await assert.rejects(copyTrade('t1', '1', 50), /your own trade/);
  db.trades.t1 = trade({ status: 'closed' });
  await assert.rejects(copyTrade('t1', '2', 50), /already closed/);
  db.trades.t1 = trade({ openedAt: Date.now() - 16 * 60 * 1000 });
  await assert.rejects(copyTrade('t1', '2', 50), /older than 15 minutes/);
  db.trades.t1 = trade();
  db.copies['t1:2'] = { status: 'open' };
  await assert.rejects(copyTrade('t1', '2', 50), /already copied/); // duplicate tap places nothing
  await assert.rejects(copyTrade('t1', '3', 50), /not connected/);
  assert.equal(db.copies['t1:3'], undefined); // unconnected member leaves no copy record
});

test('stop sits against the copier: below entry for longs, above for shorts, on tick', async () => {
  const { stopPrice } = await import('../src/copy.js');
  assert.equal(stopPrice('buy', 2498.2, 3, '0.01'), '2423.25');
  assert.equal(stopPrice('sell', 2498.2, 3, '0.01'), '2573.15');
});

test('lead exit detection follows the signed one-way position', async () => {
  const { stillIn } = await import('../src/copy.js');
  assert.equal(stillIn('buy', 0.01), true);
  assert.equal(stillIn('buy', 0), false);      // closed in the Strike app, own TP/SL, liquidation
  assert.equal(stillIn('buy', -0.01), false);  // flipped short
  assert.equal(stillIn('sell', -0.01), true);
  assert.equal(stillIn('sell', 0), false);
});

test('max loss at the stop and Strike P&L summing', async () => {
  const { lossAtStop, sumFills } = await import('../src/copy.js');
  assert.ok(Math.abs(lossAtStop('0.01', 2499.59, '2424.60') - 0.74990) < 1e-9);
  const s = sumFills([{ realized_pnl: '0', fee: '0.0125' }, { realized_pnl: '-0.75', fee: '0.0121' }]);
  assert.ok(Math.abs(s.realized + 0.75) < 1e-9 && Math.abs(s.fees - 0.0246) < 1e-9);
});
