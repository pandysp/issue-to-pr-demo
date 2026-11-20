// Follow one ticket: listen.mjs calls handleIssue() once it spots a new issue.
// Start at that function below. Helpers are grouped by when the workflow needs them.
// pi 018634af · 2026-11-20T15:31+01:00 · Opus 5.5 review
// This process uses gh to write to GitHub. Codex does not inherit its GitHub credentials
// in the environment; sandboxing does not hide every readable file on the host.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInstanceExistsError, init } from '@flue/runtime';
import { Implement, Triage } from './agents.mjs';
import { CODEX_MODEL } from './codex-provider.mjs';

const ADMITTED = new Set(['OWNER', 'COLLABORATOR']);
const ALLOWED_PATHS = /^(src|test)\//;
const EFFORT = 'high';

const footer = `\n\n<sub>Flue workflow · ${CODEX_MODEL}, reasoning effort ${EFFORT}, through the Codex CLI.</sub>`;

/**
 * @param {object} o
 * @param {string} o.repo        owner/name
 * @param {{login:string,id:number}} o.author authenticated GitHub account
 * @param {string} o.baseBranch default branch of the target repository
 * @param {number} o.number      issue number
 * @param {object} o.dirs        { state, main, work, base, receipts, codexHome }
 * @param {(s: string) => void} o.log
 */
export async function handleIssue({ repo, number, dirs, log, author, baseBranch }) {
  // 1. Decide who may spend this account's Codex allowance. No model has run yet.
  const issue = ghJson('api', `repos/${repo}/issues/${number}`);
  if (issue.pull_request) return { status: 'skipped', reason: 'pull request' };
  if (!ADMITTED.has(issue.author_association)) {
    log(`#${number}: opened by someone who is not the owner or a collaborator; not sent to a model`);
    return { status: 'skipped', reason: 'author not admitted' };
  }
  if (issue.labels.some((l) => l.name.startsWith('risk:'))) return { status: 'skipped', reason: 'already triaged' };

  // 2. Ask for a decision, not a patch. Triage can read the project but can't edit it.
  sh('git', ['-C', dirs.main, 'pull', '-q', '--ff-only']);
  let triage;
  try {
    triage = await runAgent(Triage, 'triage', number, issueOpenedSignal(repo, issue), dirs.receipts);
  } catch (error) {
    if (error instanceof AgentInstanceExistsError) return { status: 'skipped', reason: 'triage already started' };
    throw error;
  }
  const decision = triage.reply.data.triage?.at(-1);
  if (!decision) throw new Error(`#${number}: triage finished without recording a decision`);

  // 3. The model recommends; the workflow enforces scope and applies the GitHub label.
  const withinScope = decision.files.length > 0 && decision.files.every((path) => ALLOWED_PATHS.test(path));
  const risk = decision.risk === 'low' && withinScope ? 'low' : 'high';
  log(`#${number}: ${risk} risk (model said ${decision.risk}; ${CODEX_MODEL}, effort ${EFFORT}, thread ${triage.receipts.at(-1).threadId})`);
  labelIssue(repo, number, risk);

  // 4a. A person needs to decide. The early return matters: no branch or implementation.
  if (risk === 'high') {
    const questions = postQuestions(repo, number, decision);
    return { status: 'complete', risk, questions, receipts: triage.receipts };
  }

  // 4b. A clear defect: let the coding agent work in a disposable checkout.
  const branch = `agent/issue-${number}`;
  const existingPRs = ghJson('pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'url');
  if (existingPRs.length) return { status: 'skipped', reason: 'pull request already exists' };
  prepareCheckouts(repo, dirs, branch);
  const implementation = await runAgent(Implement, 'implement', number, fixRequest(number, issue, decision), dirs.receipts);

  // 5. An agent saying “fixed” is not enough. Verify its diff and test results before pushing.
  const evidence = verifyFix(dirs, number);
  const pr = openReviewPR({
    repo, number, issue, branch, baseBranch, author, dirs, decision,
    evidence,
  });
  return { status: 'complete', risk, pr, changed: evidence.changed, receipts: [...triage.receipts, ...implementation.receipts] };
}

function issueOpenedSignal(repo, issue) {
  return {
    kind: 'signal', type: 'github.issues.opened', body: issue.body ?? '',
    attributes: { repo, issueNumber: String(issue.number), title: issue.title, authorAssociation: issue.author_association },
  };
}

function labelIssue(repo, number, risk) {
  gh('label', 'create', `risk:${risk}`, '--repo', repo, '--force',
    '--color', risk === 'low' ? '2d6a4f' : 'c53600',
    '--description', risk === 'low' ? 'Triaged low risk: the workflow fixes it' : 'Triaged high risk: a person decides first');
  gh('issue', 'edit', String(number), '--repo', repo, '--add-label', `risk:${risk}`);
}

function postQuestions(repo, number, decision) {
  const questions = decision.questions.length ? decision.questions : ['What exactly should change, and who may see the result?'];
  gh('issue', 'comment', String(number), '--repo', repo, '--body',
    `**High risk. Questions before any code changes:**\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n${decision.reason}\n\nNo branch or pull request was created.${footer}`);
  return questions;
}

function prepareCheckouts(repo, dirs, branch) {
  // work gets the patch; base keeps the original exporter for the comparison.
  for (const dir of [dirs.work, dirs.base]) {
    rmSync(dir, { recursive: true, force: true });
    sh('git', ['clone', '-q', `https://github.com/${repo}.git`, dir]);
  }
  sh('git', ['checkout', '-q', '-b', branch], { cwd: dirs.work });
}

function fixRequest(number, issue, decision) {
  return [
    `Issue #${number}: ${issue.title}`, issue.body ?? '', '',
    `Goal: ${decision.goal}`, `Done when: ${decision.acceptance}`,
  ].join('\n');
}

function verifyFix(dirs, number) {
  const changed = sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dirs.work })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
  if (!changed.length) throw new Error(`#${number}: the coding step changed nothing`);
  const outside = changed.filter((f) => !ALLOWED_PATHS.test(f));
  if (outside.length) throw new Error(`#${number}: changes outside src/ and test/: ${outside.join(', ')}`);
  const after = testRun(dirs.work, dirs.codexHome);
  if (!after.passed) throw new Error(`#${number}: tests fail after the change (${countLine(after.counts)})`);

  // A green test on the fix is only half the evidence. Copy just the tests into
  // the untouched checkout: if they pass there too, they didn't catch the bug.
  for (const testPath of changed.filter((path) => path.startsWith('test/'))) {
    cpSync(join(dirs.work, testPath), join(dirs.base, testPath));
  }
  const before = testRun(dirs.base, dirs.codexHome);
  if (before.passed) throw new Error(`#${number}: the new tests also pass on the old code, so they do not show the bug`);
  writeFileSync(join(dirs.state, `issue-${number}-tests.txt`), `BEFORE\n${before.output}\nAFTER\n${after.output}`);
  return { changed, before, after };
}

// Only trusted workflow code can publish. The final action is a PR, never a merge.
function openReviewPR({ repo, number, issue, branch, baseBranch, author, dirs, decision, evidence }) {
  const { changed, before, after } = evidence;
  const gitIdentity = ['-c', `user.name=${author.login}`, '-c', `user.email=${author.id}+${author.login}@users.noreply.github.com`];
  sh('git', ['add', '--', ...changed], { cwd: dirs.work });
  sh('git', [...gitIdentity, 'commit', '-q', '-m', `Fix: ${issue.title} (#${number})`], { cwd: dirs.work });
  // Supply the credential helper to this push, not to the coding agent’s environment.
  sh('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-q', '-u', 'origin', branch], { cwd: dirs.work });
  const body = [
    `Fixes #${number}.`, '', `**Goal:** ${decision.goal}`, `**Done when:** ${decision.acceptance}`, '',
    `**Changed:** ${changed.map((f) => `\`${f}\``).join(', ')}`, '',
    `**Tests before the fix** (the new tests on the old code): ${countLine(before.counts)}`,
    `**Tests after the fix:** ${countLine(after.counts)}`,
    '(Run by the workflow itself in a sandbox without network, not reported by the agent.)',
    'Ready for review. Nothing is merged automatically.', footer,
  ].join('\n');
  const pr = gh('pr', 'create', '--repo', repo, '--base', baseBranch, '--head', branch,
    '--title', `Fix: ${issue.title} (#${number})`, '--body', body).trim();
  gh('issue', 'comment', String(number), '--repo', repo, '--body',
    `**Low risk.** Fixed and tested in ${pr}. It waits for a person to review it.${footer}`);
  return pr;
}

// Execution details: local commands, sandboxed tests and per-agent model receipts.
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gh = (...args) => sh('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args));

// The tests contain model-written code, so they run inside Codex's read-only sandbox:
// no network, no writes, a throwaway HOME and no inherited environment.
function testRun(cwd, codexHome) {
  const env = { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'tests-')), CODEX_HOME: codexHome, LANG: 'en_US.UTF-8' };
  // Match `npm test`: discover tests recursively from test/, not from workflow/.
  const testDir = join(cwd, 'test');
  const args = ['sandbox', '-P', ':read-only', '-C', testDir, '--', 'node', '--test'];
  let output;
  try {
    output = sh('codex', args, { cwd: testDir, env });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // A sandbox or command failure is not a reproduced bug. Require a test-runner failure count.
    if (error.status !== 1) throw error;
    const counts = testCounts(output);
    if (!(counts.fail > 0)) throw error;
    return { passed: false, output, counts };
  } finally {
    rmSync(env.HOME, { recursive: true, force: true });
  }
  const counts = testCounts(output);
  if (!(counts.pass > 0)) throw new Error('No passing tests reported by the test runner');
  return { passed: true, output, counts };
}
// Only counts leave the machine; test output itself is model-influenced and is not posted.
function testCounts(output) {
  const n = (k) => Number(output.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
}
const countLine = (c) => `${c.tests} tests: ${c.pass} pass, ${c.fail} fail`;

function receiptsSince(path, offset) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').slice(offset).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// No fallback: every call must match the requested model and effort.
function assertReceipts(receipts, what) {
  if (!receipts.length) throw new Error(`${what}: no Codex receipt recorded`);
  for (const r of receipts) {
    if (r.model !== CODEX_MODEL || r.effort !== EFFORT) throw new Error(`${what}: Codex ran ${r.model}/${r.effort}, expected ${CODEX_MODEL}/${EFFORT}`);
  }
}

// Record only this call's receipts, not receipts left by earlier issues.
async function runAgent(agent, stage, number, message, receiptFile) {
  const offset = existsSync(receiptFile) ? readFileSync(receiptFile, 'utf8').length : 0;
  const id = `issue-${number}-${stage}`;
  const handle = init(agent, { id, uid: null }); // create-only: a re-delivered issue cannot start a second run
  const receipt = await handle.dispatch({ message });
  const reply = await handle.read(receipt);
  const receipts = receiptsSince(receiptFile, offset);
  assertReceipts(receipts, stage);
  return { reply, receipts };
}
