// Bounded listener for the demo: polls the repository for newly opened issues and hands each one
// to the Flue workflow. It stops by itself after --minutes (or Ctrl-C). It is not a service.
//
//   node listen.mjs --repo pandysp/issue-to-pr-demo --state-dir /path/to/state --minutes 20
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sqlite, start } from '@flue/runtime/node';
import { Implement, Triage } from './agents.mjs';
import { codexCliProvider } from './codex-provider.mjs';
import { handleIssue } from './handle-issue.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'pandysp/issue-to-pr-demo' },
    'state-dir': { type: 'string' },
    minutes: { type: 'string', default: '20' },
    interval: { type: 'string', default: '15' },
  },
});
if (!values['state-dir']) throw new Error('--state-dir is required (a directory outside this repository)');
const state = resolve(values['state-dir']);
const dirs = {
  main: join(state, 'main'), work: join(state, 'work'), base: join(state, 'base'),
  receipts: join(state, 'codex-receipts.jsonl'), codexHome: join(state, 'codex-home'),
};
mkdirSync(state, { recursive: true });
if (!existsSync(dirs.main)) execFileSync('git', ['clone', '-q', `https://github.com/${values.repo}.git`, dirs.main]);
mkdirSync(dirs.work, { recursive: true });
if (!existsSync(dirs.receipts)) writeFileSync(dirs.receipts, '');
// The workers get their own Codex home: a link to the existing ChatGPT login and nothing else,
// so personal Codex instructions, config and MCP servers never reach them. No credential is copied.
mkdirSync(dirs.codexHome, { recursive: true, mode: 0o700 });
if (!existsSync(join(dirs.codexHome, 'auth.json'))) symlinkSync(join(homedir(), '.codex', 'auth.json'), join(dirs.codexHome, 'auth.json'));

const logPath = join(state, 'listener.log');
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(logPath, `${line}\n`); };

// Only the Codex CLI provider is registered, so no API-key provider can be reached.
await using flue = await start({
  agents: [Triage, Implement],
  db: sqlite(join(state, 'flue.db')),
  providers: [codexCliProvider({ readOnlyCwd: dirs.main, workspaceCwd: dirs.work, receiptsPath: dirs.receipts, codexHome: dirs.codexHome })],
});

const startedAt = new Date();
const stopAt = Date.now() + Number(values.minutes) * 60_000;
const seen = new Set();
log(`listening on ${values.repo} for issues opened after ${startedAt.toISOString()}, until ${new Date(stopAt).toISOString()}`);

while (Date.now() < stopAt) {
  const issues = JSON.parse(execFileSync('gh', ['api', `repos/${values.repo}/issues?state=open&sort=created&direction=desc&per_page=20`], { encoding: 'utf8' }));
  const fresh = issues
    .filter((i) => !i.pull_request && new Date(i.created_at) >= startedAt && !seen.has(i.number))
    .sort((a, b) => a.number - b.number);
  for (const issue of fresh) {
    seen.add(issue.number);
    log(`#${issue.number} opened: ${issue.title}`);
    try {
      const result = await handleIssue({ repo: values.repo, number: issue.number, dirs, log });
      writeFileSync(join(state, `issue-${issue.number}-result.json`), JSON.stringify(result, null, 2));
      log(`#${issue.number} ${result.status}${result.pr ? ` → ${result.pr}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
    } catch (e) {
      log(`#${issue.number} FAILED: ${e.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, Number(values.interval) * 1000));
}
log('listener stopped (time limit reached)');
