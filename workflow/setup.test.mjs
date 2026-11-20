// pi 018634af · 2026-11-20T15:18+01:00. CLI checks; fake only GitHub and Codex, never call a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
test('a fork owner signs in once and checks the chosen target without starting a model or listener', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fork-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); mkdirSync(bin);
  const shim = (name, body) => writeFileSync(join(bin, name), '#!/bin/sh\nset -eu\n' + body, { mode: 0o700 });
  shim('codex', `test "$1" = -c && test "$2" = 'cli_auth_credentials_store="file"' && test "$3" = login || exit 88
[ -z "\${OPENAI_API_KEY:-}" ] && [ -z "\${GH_TOKEN:-}" ] || exit 89
if [ "$#" = 3 ]; then echo 'Logged in using ChatGPT' > "$CODEX_HOME/test-status"; exit; fi
test "$4" = status && test -f "$CODEX_HOME/test-status" || exit 1
cat "$CODEX_HOME/test-status" >&2`);
  shim('gh', `case "$*" in
'api user') echo '{"login":"attendee","id":42}' ;;
'api repos/attendee/export') echo '{"full_name":"attendee/export","has_issues":true,"permissions":{"push":true},"default_branch":"trunk"}' ;;
*) exit 99 ;;
esac`);
  const run = (...args) => spawnSync(process.execPath, ['listen.mjs', ...args], { cwd, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, DEMO_CODEX_MODEL: 'attendee-model', OPENAI_API_KEY: 'test-only', GH_TOKEN: 'test-only' } });
  const args = ['--repo', 'attendee/export'];
  const error = (r, pattern) => { assert.notEqual(r.status, 0); assert.match(r.stderr, pattern); };
  error(run('--check'), /Pass --repo/);
  error(run(...args, '--check'), /ChatGPT sign-in required/);
  const login = run(...args, '--login'); assert.equal(login.status, 0, login.stderr);
  const state = join(home, '.local/state/issue-to-pr-demo/attendee/export');
  const check = run(...args, '--check'); assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /attendee → attendee\/export \(trunk\).*ChatGPT.*attendee-model\/high/);
  assert.equal(existsSync(join(state, 'flue.db')), false);
  writeFileSync(join(state, 'codex-home/test-status'), 'Logged in using an API key');
  error(run(...args, '--check'), /not a subscription login/);
});
