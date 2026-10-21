import test from 'node:test';
import assert from 'node:assert/strict';
import { quotes } from '../src/maker.js';
import { floorTo, roundTo } from '../src/market.js';

test('rounding respects step and tick', () => {
  assert.equal(floorTo(3.689, '0.01'), '3.68');
  assert.equal(floorTo(0.30000000000000004, '0.1'), '0.3');
  assert.equal(roundTo(108.4597, '0.01'), '108.46');
});

test('maker quotes straddle the mark within the 5% bound', () => {
  const r = { tick: '0.01', limitStep: '0.01' };
  const [bid, ask] = quotes(108.46, r);
  assert.equal(bid.side, 'buy'); assert.equal(ask.side, 'sell');
  assert.ok(Number(bid.price) < 108.46 && Number(ask.price) > 108.46);
  assert.ok(Math.abs(Number(ask.price) / 108.46 - 1) < 0.05);
  assert.equal(bid.size, '3.68'); // $400 / 108.46 floored to 0.01
  assert.ok(bid.post_only && ask.post_only);
});
