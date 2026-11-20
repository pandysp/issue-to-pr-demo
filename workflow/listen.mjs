// Entry point: watch one repository for new issues during a bounded demo window.
// Run from workflow/: node listen.mjs --repo OWNER/REPO --minutes 20
// pi 018634af · 2026-11-20T15:31+01:00
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { sqlite, start } from '@flue/runtime/node';
import { Implement, Triage } from './agents.mjs';
import { CODEX_MODEL, codexCliProvider, workerEnv } from './codex-provider.mjs';
import { handleIssue } from './handle-issue.mjs';

const { values: options } = parseArgs({ options: {
  repo: { type: 'string' },
  login: { type: 'boolean' },
  check: { type: 'boolean' },
  'state-dir': { type: 'string' },
  minutes: { type: 'string', default: '20' },
  interval: { type: 'string', default: '15' },
} });

const minutes = Number(options.minutes);
const pollSeconds = Number(options.interval);
if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
  throw new Error('--minutes and --interval must be positive, finite numbers.');
}

// Two identities, two jobs: ChatGPT pays for model work; GitHub authorizes repository changes.
const repo = options.repo;
const dirs = preparePrivateState(repo, options['state-dir']);
checkChatGPTLogin(repo, dirs.codexHome, options.login);
if (options.login && !options.check) process.exit(0);

const author = github('user');
const repository = github(`repos/${repo}`);
checkRepository(repo, repository, author, dirs);
console.log(`GitHub: ${author.login} → ${repository.full_name} (${repository.default_branch}); Codex: ChatGPT, requested model ${CODEX_MODEL}/high`);
if (options.check) process.exit(0); // No model call, database or listener needed for a setup check.

// Both agents use the same model. Only Implement gets a writable checkout.
if (!existsSync(dirs.main)) execFileSync('git', ['clone', '-q', `https://github.com/${repo}.git`, dirs.main]);
mkdirSync(dirs.work, { recursive: true });
if (!existsSync(dirs.receipts)) writeFileSync(dirs.receipts, '');
await using flue = await start({
  agents: [Triage, Implement],
  db: sqlite(join(dirs.state, 'flue.db')),
  providers: [codexCliProvider({
    readOnlyCwd: dirs.main, workspaceCwd: dirs.work,
    receiptsPath: dirs.receipts, codexHome: dirs.codexHome,
  })],
});

const startedAt = new Date();
const stopAt = new Date(startedAt.getTime() + minutes * 60_000);
const seen = new Set();
log(`listening on ${repo} for issues opened after ${startedAt.toISOString()}, until ${stopAt.toISOString()}`);
while (Date.now() < stopAt.getTime()) {
  // Process oldest first and one at a time: two fixes must not share the working checkout.
  for (const issue of newIssues(repo, startedAt, seen)) {
    seen.add(issue.number);
    log(`#${issue.number} opened: ${issue.title}`);
    try {
      // Follow handleIssue() in handle-issue.mjs for the label → question or PR decision.
      const result = await handleIssue({ repo, number: issue.number, author, baseBranch: repository.default_branch, dirs, log });
      writeFileSync(join(dirs.state, `issue-${issue.number}-result.json`), JSON.stringify(result, null, 2));
      const detail = result.pr ? ` → ${result.pr}` : result.reason ? ` (${result.reason})` : '';
      log(`#${issue.number} ${result.status}${detail}`);
    } catch (error) {
      // Surface the failed ticket, then keep the demo available for other tickets.
      log(`#${issue.number} FAILED: ${error.message}`);
    }
  }
  await delay(pollSeconds * 1000);
}
log('listener stopped (time limit reached)');

function newIssues(repo, startedAt, seen) {
  // This GitHub endpoint also returns pull requests. Neither PRs nor old issues start work.
  const issues = github(`repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=20`);
  return issues
    .filter((issue) => !issue.pull_request && new Date(issue.created_at) >= startedAt && !seen.has(issue.number))
    .sort((first, second) => first.number - second.number);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(join(dirs.state, 'listener.log'), `${line}\n`);
}

function github(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
}

function preparePrivateState(repo, requestedDirectory) {
  if (!/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repo ?? '') || ['.', '..'].includes(repo.split('/')[1])) {
    throw new Error('Pass --repo OWNER/REPO for your own GitHub repository.');
  }
  const state = resolve(requestedDirectory ?? join(homedir(), '.local', 'state', 'issue-to-pr-demo', repo.toLowerCase()));
  const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (state === checkout || state.startsWith(checkout + '/')) {
    throw new Error('Keep --state-dir outside the checkout: it contains a private login.');
  }
  const codexHome = join(state, 'codex-home');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return { state, codexHome, main: join(state, 'main'), work: join(state, 'work'),
    base: join(state, 'base'), receipts: join(state, 'codex-receipts.jsonl') };
}

function checkChatGPTLogin(repo, codexHome, interactive) {
  const args = ['-c', 'cli_auth_credentials_store="file"', 'login'];
  const env = workerEnv(codexHome);
  if (interactive) {
    const login = spawnSync('codex', args, { env, stdio: 'inherit' });
    if (login.error) throw login.error;
    if (login.status !== 0) throw new Error('Codex sign-in did not complete.');
  }
  const status = spawnSync('codex', [...args, 'status'], { env, encoding: 'utf8' });
  if (status.error) throw status.error;
  if (status.status !== 0 || !/^Logged in using ChatGPT\s*$/mi.test(status.stdout + status.stderr)) {
    throw new Error(`ChatGPT sign-in required. Run node listen.mjs --repo ${repo} --login with the same state directory. An API key is not a subscription login.`);
  }
}

function checkRepository(repo, repository, author, dirs) {
  if (!repository.has_issues || !repository.permissions?.push) {
    throw new Error(`Enable Issues and grant ${author.login} write access to ${repo}.`);
  }
  if (!existsSync(dirs.main)) return;
  const origin = execFileSync('git', ['-C', dirs.main, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  if (origin.toLowerCase() !== `https://github.com/${repo}.git`.toLowerCase()) {
    throw new Error('This state directory belongs to a different repository.');
  }
}
