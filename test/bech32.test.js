import test from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '../public/bech32.js';

test('BIP-173 checksum vector', () => assert.equal(bech32('a', []), 'a12uel5l'));

test('CIP-19 testnet base address vector', () => {
  const hex = '00' + '9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e' + '337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251';
  assert.equal(bech32('addr_test', Buffer.from(hex, 'hex')),
    'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae');
});
