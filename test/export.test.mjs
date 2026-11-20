import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeField, toCsv } from '../src/export.mjs';

const orders = JSON.parse(readFileSync(new URL('../data/orders.json', import.meta.url), 'utf8'));

test('no selected orders produce only the public header', () => {
  assert.equal(toCsv([]), 'id,customer,total,status\n');
});

test('selecting only order 103 exports it exactly once', () => {
  const selected = orders.filter((order) => order.id === 103);
  assert.equal(toCsv(selected), 'id,customer,total,status\n103,Alan Turing,7,refunded\n');
});

test('selecting all orders exports each order exactly once', () => {
  assert.equal(toCsv(orders), [
    'id,customer,total,status',
    '101,Ada Lovelace,42.5,paid',
    '102,Grace Hopper,19.99,paid',
    '103,Alan Turing,7,refunded',
  ].join('\n') + '\n');
});

test('fields with commas or quotes are quoted', () => {
  assert.equal(escapeField('Hopper, Grace'), '"Hopper, Grace"');
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeField(7), '7');
});

test('internal notes are not exported', () => {
  const csv = toCsv([{ id: 1, customer: 'A', total: 1, status: 'paid', internalNote: 'secret' }]);
  assert.ok(!csv.includes('secret'));
});
