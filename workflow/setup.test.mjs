// pi 018634af · 2026-11-20T15:40+01:00. CLI checks; fake only GitHub and Codex, never call a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
test('a fork owner signs in and checks their fork without starting a listener', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fork-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = setupCommands(home);
  const repo = ['--repo', 'attendee/export'];
  const state = join(home, '.local/state/issue-to-pr-demo/attendee/export');

  // Before sign-in, neither a missing target nor a missing account can start work.
  expectFailure(run('--check'), /Pass --repo/);
  expectFailure(run(...repo, '--check'), /ChatGPT sign-in required/);

  const login = run(...repo, '--login');
  assert.equal(login.status, 0, login.stderr);
  const check = run(...repo, '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /attendee → attendee\/export \(trunk\).*ChatGPT.*attendee-model\/high/);
  assert.equal(existsSync(join(state, 'flue.db')), false);

  // An API-key login would bill a different account; it must not pass the check.
  writeFileSync(join(state, 'codex-home/test-status'), 'Logged in using an API key');
  expectFailure(run(...repo, '--check'), /not a subscription login/);
});

function expectFailure(result, message) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

// Exercise the real CLI in a fresh home. Only gh and codex are stand-ins;
// commands outside the setup flow must fail rather than reach a real account.
function setupCommands(home) {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  function install(name, body) {
    writeFileSync(join(bin, name), '#!/bin/sh\nset -eu\n' + body, { mode: 0o700 });
  }
  install('codex', `test "$1" = -c && test "$2" = 'cli_auth_credentials_store="file"' && test "$3" = login || exit 88
[ -z "\${OPENAI_API_KEY:-}" ] && [ -z "\${GH_TOKEN:-}" ] || exit 89
if [ "$#" = 3 ]; then echo 'Logged in using ChatGPT' > "$CODEX_HOME/test-status"; exit; fi
test "$4" = status && test -f "$CODEX_HOME/test-status" || exit 1
cat "$CODEX_HOME/test-status" >&2`);
  install('gh', `case "$*" in
'api user') echo '{"login":"attendee","id":42}' ;;
'api repos/attendee/export') echo '{"full_name":"attendee/export","has_issues":true,"permissions":{"push":true},"default_branch":"trunk"}' ;;
*) exit 99 ;;
esac`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, DEMO_CODEX_MODEL: 'attendee-model',
    // Sentinels: the fake Codex above rejects these if the listener passes them through.
    OPENAI_API_KEY: 'test-only', GH_TOKEN: 'test-only',
  };
  return (...args) => spawnSync(process.execPath, ['listen.mjs', ...args], { cwd, encoding: 'utf8', env });
}
