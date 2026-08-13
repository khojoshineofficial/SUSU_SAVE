'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/utils/money');

test('toMinor converts major units without floating-point drift', () => {
  assert.equal(money.toMinor(20), 2000);
  assert.equal(money.toMinor('20.29'), 2029);
  assert.equal(money.toMinor(0.1 + 0.2), 30); // 0.30000000000000004
  assert.equal(money.toMinor('1,250.75'), 125075);
});

test('toMajor is the inverse of toMinor', () => {
  [0, 1, 999, 2029, 1234567].forEach((minor) => {
    assert.equal(money.toMinor(money.toMajor(minor)), minor);
  });
});

test('money helpers reject non-integer minor units', () => {
  assert.throws(() => money.add(100.5, 100), TypeError);
  assert.throws(() => money.subtract(10, 1.2), TypeError);
});

test('percentOf rounds to whole minor units', () => {
  assert.equal(money.percentOf(100000, 1), 1000); // 1% of GH₵1000 = GH₵10
  assert.equal(money.percentOf(2029, 1.5), 30); // 30.435 → 30
  assert.equal(money.percentOf(0, 5), 0);
});

test('repeated percentage fees never leak fractions of a pesewa', () => {
  let total = 0;
  for (let i = 0; i < 1000; i += 1) total = money.add(total, money.percentOf(3333, 1));
  assert.ok(Number.isInteger(total));
  assert.equal(total, 33000);
});

test('format renders Ghanaian currency consistently', () => {
  assert.equal(money.format(854000), 'GH₵8,540.00');
  assert.equal(money.format(0), 'GH₵0.00');
  assert.equal(money.format(-2000), '-GH₵20.00');
});
