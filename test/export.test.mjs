import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeField, toCsv } from '../src/export.mjs';

test('an empty selection exports only the public header', () => {
  assert.equal(toCsv([]), 'id,customer,total,status\n');
});

test('exports all three sample orders exactly once in input order', () => {
  const orders = JSON.parse(readFileSync(new URL('../data/orders.json', import.meta.url), 'utf8'));
  assert.equal(toCsv(orders), [
    'id,customer,total,status',
    '101,Ada Lovelace,42.5,paid',
    '102,Grace Hopper,19.99,paid',
    '103,Alan Turing,7,refunded',
    '',
  ].join('\n'));
});

test('fields with commas or quotes are quoted', () => {
  assert.equal(escapeField('Hopper, Grace'), '"Hopper, Grace"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeField(7), '7');
});

test('a single selection exports one row without internal notes', () => {
  const csv = toCsv([{ id: 1, customer: 'A', total: 1, status: 'paid', internalNote: 'secret' }]);
  assert.equal(csv, 'id,customer,total,status\n1,A,1,paid\n');
});
