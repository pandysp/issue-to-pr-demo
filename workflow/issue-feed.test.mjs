// pi 018634af · 2026-11-20T15:55+01:00. Model GitHub's forward-only issue connection, not a local clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchNewIssues } from './issue-feed.mjs';

function issue(number, state = 'OPEN') {
  return { number, state, title: `Order ${number}`, createdAt: '2026-11-20T12:00:00Z' };
}
function connection(records) {
  return ({ last, first, after }) => {
    const offset = after ? records.findIndex((row) => `cursor:${row.number}` === after) + 1 : 0;
    const nodes = last ? records.slice(-last) : records.slice(offset, offset + first);
    return { nodes, pageInfo: {
      endCursor: nodes.length ? `cursor:${nodes.at(-1).number}` : null,
      hasNextPage: !last && offset + nodes.length < records.length,
    } };
  };
}

test('from an empty fork, an idle poll does not lose the first ticket or replay it', () => {
  const records = [];
  const poll = watchNewIssues(connection(records));
  assert.deepEqual(poll(), []);
  records.push(issue(1));
  assert.deepEqual(poll().map((row) => row.number), [1]);
  assert.deepEqual(poll(), []);
});

test('an incomplete poll does not move the saved cursor', () => {
  const records = [issue(1)];
  const page = connection(records);
  let interrupt = true;
  const poll = watchNewIssues((args) => {
    if (interrupt && args.after === 'cursor:101') throw new Error('page unavailable');
    return page(args);
  });
  records.push(...Array.from({ length: 101 }, (_, i) => issue(i + 2)));
  assert.throws(poll, /page unavailable/);
  interrupt = false;
  assert.deepEqual(poll(), records.slice(1));
});

test('skip old tickets, including same-second ones; deliver a multi-page burst once in order', () => {
  const records = [issue(1), issue(2, 'CLOSED')];
  const poll = watchNewIssues(connection(records));
  records.push(...Array.from({ length: 205 }, (_, i) => issue(i + 3)));
  records[100].state = 'CLOSED';
  const wanted = records.slice(2).filter((row) => row.state === 'OPEN');
  assert.deepEqual(poll(), wanted);
  assert.deepEqual(poll(), []);
  records.push(issue(208));
  assert.deepEqual(poll(), [issue(208)]);
});
