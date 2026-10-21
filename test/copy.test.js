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
