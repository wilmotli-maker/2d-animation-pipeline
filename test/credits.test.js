import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactions } from '../src/credits.js';

// Real shape (sanity check 4): `account transactions` prints a fixed-column
// table: DATE(16 chars) MODEL CREDITS ACTION.
const SAMPLE = [
  'DATE              MODEL            CREDITS  ACTION',
  '2026-07-23 00:24  Nano Banana Pro  -2       spend',
  '2026-07-16 21:49  Seedance 2.0     -22.5    spend',
].join('\n');

test('parseTransactions extracts date, model, credits, action rows', () => {
  const rows = parseTransactions(SAMPLE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    date: '2026-07-23 00:24', model: 'Nano Banana Pro', credits: -2, action: 'spend',
  });
  assert.equal(rows[1].model, 'Seedance 2.0');
  assert.equal(rows[1].credits, -22.5);
});

test('parseTransactions ignores the header and blank lines', () => {
  assert.equal(parseTransactions('\n' + SAMPLE + '\n').length, 2);
  assert.equal(parseTransactions('').length, 0);
});
