// pi 018634af · 2026-11-20T15:41+01:00
// Walk both agent roles through the real provider. Only the external Codex binary is a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL, codexCliProvider } from './codex-provider.mjs';

test('triage returns a tool call, implementation returns text, and each records its sandbox', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'provider-test-'));
  const originalPath = process.env.PATH;
  const originalToken = process.env.GH_TOKEN;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.GH_TOKEN = 'test-only';
  installFakeCodex(home);
  process.env.PATH = `${home}:${originalPath}`;

  const receiptsPath = join(home, 'receipts.jsonl');
  const provider = codexCliProvider({ readOnlyCwd: home, workspaceCwd: home, receiptsPath, codexHome: home });
  const [reader, writer] = await provider.getModels();
  const user = { role: 'user', content: 'Check the export', timestamp: 0 };
  const tool = { name: 'record_triage', description: 'Save a decision', parameters: { type: 'object' } };
  const turn = (model, messages) => provider.streamSimple(model, { messages }, { reasoning: 'high' }).result();

  const triage = await turn(reader, [{ role: 'system', content: 'Decide the risk', toolsAdded: [tool] }, user]);
  assert.equal(triage.stopReason, 'toolUse', triage.errorMessage);
  assert.equal(triage.content[0].name, 'record_triage');
  assert.deepEqual(triage.content[0].arguments, { risk: 'low' });

  const implementation = await turn(writer, [user]);
  assert.equal(implementation.stopReason, 'stop', implementation.errorMessage);
  assert.equal(implementation.content[0].text, 'Fixed the export.');

  // Acknowledging a completed tool must not start a third Codex run.
  await turn(reader, [{ role: 'toolResult', toolName: tool.name, content: [] }]);
  const receipts = readFileSync(receiptsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.map(({ model, effort, sandbox }) => [model, effort, sandbox]), [
    [CODEX_MODEL, 'high', 'read-only'], [CODEX_MODEL, 'high', 'workspace-write'],
  ]);
});

function installFakeCodex(home) {
  mkdirSync(join(home, 'sessions'));
  // Match the CLI's three outputs: a final answer file, JSON events on stdout,
  // and a session record containing the model, effort and sandbox that actually ran.
  writeFileSync(join(home, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (process.env.GH_TOKEN) throw new Error('worker inherited GitHub token');
const mode = option('--sandbox');
const effortSetting = args.find((arg) => arg.startsWith('model_reasoning_effort='));
const effort = JSON.parse(effortSetting.split('=')[1]);
const answer = args.includes('--output-schema') ? '{"risk":"low"}' : 'Fixed the export.';
fs.writeFileSync(option('-o'), answer);
const ctx = { model: option('-m'), effort, sandbox_policy: { type: mode } };
fs.writeFileSync(process.env.CODEX_HOME + '/sessions/' + mode + '.jsonl', JSON.stringify({ type: 'turn_context', payload: ctx }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: mode }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }));
`, { mode: 0o700 });
}
