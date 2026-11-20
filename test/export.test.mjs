import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeField, toCsv, PUBLIC_COLUMNS } from '../src/export.mjs';

test('the header lists the public columns', () => {
  assert.equal(toCsv([]).split('\n')[0], PUBLIC_COLUMNS.join(','));
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
