// pi 018634af · 2026-11-20T15:55+01:00. Real Git repositories, no GitHub or Codex account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCheckouts } from './checkouts.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('the patch and its baseline start at the triaged commit; unrelated directories survive', (t) => {
  const state = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const remote = join(state, 'upstream');
  mkdirSync(remote);
  git(remote, 'init', '-q', '-b', 'main');
  function commit(value) {
    writeFileSync(join(remote, 'export.txt'), value);
    git(remote, 'add', 'export.txt');
    git(remote, '-c', 'user.name=Tester', '-c', 'user.email=test@example.invalid', 'commit', '-qm', value);
    return git(remote, 'rev-parse', 'HEAD');
  }
  const triaged = commit('triaged version');
  for (const name of ['work', 'base']) {
    mkdirSync(join(state, name));
    writeFileSync(join(state, name, 'keep.txt'), 'unrelated');
  }

  let privateWorkspace;
  {
    using checkout = openCheckouts(state, remote);
    privateWorkspace = checkout.work;
    const later = commit('someone else pushed');
    assert.notEqual(later, triaged);
    checkout.prepareFix('agent/issue-3');
    assert.equal(git(checkout.work, 'rev-parse', 'HEAD'), triaged);
    assert.equal(git(checkout.base, 'rev-parse', 'HEAD'), triaged);
    assert.equal(git(checkout.work, 'remote', 'get-url', 'origin'), remote);
    writeFileSync(join(checkout.work, 'export.txt'), 'agent edit');
    assert.equal(readFileSync(join(checkout.base, 'export.txt'), 'utf8'), 'triaged version');
  }
  assert.equal(existsSync(privateWorkspace), false);
  for (const name of ['work', 'base']) assert.equal(readFileSync(join(state, name, 'keep.txt'), 'utf8'), 'unrelated');
});
