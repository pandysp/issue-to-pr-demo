// One newly opened issue → admit → Flue Triage agent → label → question or tested pull request.
// Trusted code here talks to GitHub (gh CLI), checks the diff and runs the tests. The model never
// gets a GitHub token: it only decides (Triage) and edits one throwaway checkout (Implement).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentInstanceExistsError, init } from '@flue/runtime';
import { Implement, Triage } from './agents.mjs';
import { CODEX_MODEL } from './codex-provider.mjs';

const ADMITTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ALLOWED_PATHS = /^(src|test)\//;
const EFFORT = 'high';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gh = (...args) => sh('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args));

function testRun(cwd) {
  try { return { passed: true, output: sh('node', ['--test', 'test/'], { cwd }) }; }
  catch (e) { return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}
const testSummary = (output) => output.split('\n').map((l) => l.trim())
  .filter((l) => /^(not ok \d|ok \d|ℹ (tests|pass|fail) )/.test(l)).join('\n');

function receiptsSince(path, offset) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').slice(offset).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// No fallback: every model call of this issue must have run gpt-6.2-sol at high effort.
function assertReceipts(receipts, what) {
  if (!receipts.length) throw new Error(`${what}: no Codex receipt recorded`);
  for (const r of receipts) {
    if (r.model !== CODEX_MODEL || r.effort !== EFFORT) throw new Error(`${what}: Codex ran ${r.model}/${r.effort}, expected ${CODEX_MODEL}/${EFFORT}`);
  }
}

async function ask(agent, id, message) {
  const handle = init(agent, { id, uid: null }); // create-only: a re-delivered issue cannot start a second run
  const receipt = await handle.dispatch({ message });
  return handle.read(receipt);
}

/**
 * @param {object} o
 * @param {string} o.repo        owner/name
 * @param {number} o.number      issue number
 * @param {object} o.dirs        { main, work, base, receipts }
 * @param {(s: string) => void} o.log
 */
export async function handleIssue({ repo, number, dirs, log }) {
  const issue = ghJson('api', `repos/${repo}/issues/${number}`);
  if (issue.pull_request) return { status: 'skipped', reason: 'pull request' };
  if (!ADMITTED.has(issue.author_association)) {
    log(`#${number}: opened by someone who is not the owner or a collaborator; not sent to a model`);
    return { status: 'skipped', reason: 'author not admitted' };
  }
  if (issue.labels.some((l) => l.name.startsWith('risk:'))) return { status: 'skipped', reason: 'already triaged' };

  // Triage (read-only) on an up-to-date checkout of main.
  sh('git', ['-C', dirs.main, 'pull', '-q', '--ff-only']);
  const offset = existsSync(dirs.receipts) ? readFileSync(dirs.receipts, 'utf8').length : 0;
  let reply;
  try {
    reply = await ask(Triage, `issue-${number}-triage`, {
      kind: 'signal', type: 'github.issues.opened', body: issue.body ?? '',
      attributes: { repo, issueNumber: String(number), title: issue.title, authorAssociation: issue.author_association },
    });
  } catch (e) {
    if (e instanceof AgentInstanceExistsError) return { status: 'skipped', reason: 'triage already started' };
    throw e;
  }
  const t = reply.data.triage?.at(-1);
  if (!t) throw new Error(`#${number}: triage finished without recording a decision`);
  const triageReceipts = receiptsSince(dirs.receipts, offset);
  assertReceipts(triageReceipts, 'triage');
  // Deterministic guard on top of the model: low risk only for changes inside src/ and test/.
  const risk = t.risk === 'low' && t.files.length > 0 && t.files.every((f) => ALLOWED_PATHS.test(f)) ? 'low' : 'high';
  log(`#${number}: ${risk} risk (model said ${t.risk}; ${CODEX_MODEL}, effort ${EFFORT}, thread ${triageReceipts.at(-1).threadId})`);

  gh('label', 'create', `risk:${risk}`, '--repo', repo, '--force',
    '--color', risk === 'low' ? '2d6a4f' : 'c53600',
    '--description', risk === 'low' ? 'Triaged low risk: the workflow fixes it' : 'Triaged high risk: a person decides first');
  gh('issue', 'edit', String(number), '--repo', repo, '--add-label', `risk:${risk}`);
  const footer = `\n\n<sub>Flue workflow · ${CODEX_MODEL}, reasoning effort ${EFFORT}, through the Codex CLI.</sub>`;

  if (risk === 'high') {
    const questions = t.questions.length ? t.questions : ['What exactly should change, and who may see the result?'];
    gh('issue', 'comment', String(number), '--repo', repo, '--body',
      `**High risk. Questions before any code changes:**\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n${t.reason}\n\nNo branch or pull request was created.${footer}`);
    return { status: 'complete', risk, questions, receipts: triageReceipts };
  }

  // Implement (workspace-write) in a fresh throwaway checkout.
  const branch = `agent/issue-${number}`;
  if (ghJson('pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'url').length) {
    return { status: 'skipped', reason: 'pull request already exists' };
  }
  for (const dir of [dirs.work, dirs.base]) {
    rmSync(dir, { recursive: true, force: true });
    sh('git', ['clone', '-q', `https://github.com/${repo}.git`, dir]);
  }
  sh('git', ['checkout', '-q', '-b', branch], { cwd: dirs.work });
  const implOffset = readFileSync(dirs.receipts, 'utf8').length;
  const impl = await ask(Implement, `issue-${number}-implement`, [
    `Issue #${number}: ${issue.title}`, issue.body ?? '', '',
    `Goal: ${t.goal}`, `Done when: ${t.acceptance}`,
  ].join('\n'));
  const implReceipts = receiptsSince(dirs.receipts, implOffset);
  assertReceipts(implReceipts, 'implement');

  // Check the change ourselves; nothing the model says counts as proof.
  const changed = sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dirs.work })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
  if (!changed.length) throw new Error(`#${number}: the coding step changed nothing`);
  const outside = changed.filter((f) => !ALLOWED_PATHS.test(f));
  if (outside.length) throw new Error(`#${number}: changes outside src/ and test/: ${outside.join(', ')}`);
  const after = testRun(dirs.work);
  if (!after.passed) throw new Error(`#${number}: tests fail after the change\n${testSummary(after.output)}`);
  for (const f of changed.filter((f) => f.startsWith('test/'))) cpSync(join(dirs.work, f), join(dirs.base, f));
  const before = testRun(dirs.base);
  if (before.passed) throw new Error(`#${number}: the new tests also pass on the old code, so they do not show the bug`);
  writeFileSync(join(dirs.work, '..', `issue-${number}-tests.txt`), `BEFORE\n${before.output}\nAFTER\n${after.output}`);

  const id = gh('api', 'user', '--jq', '.id').trim();
  const author = ['-c', 'user.name=pandysp', '-c', `user.email=${id}+pandysp@users.noreply.github.com`];
  sh('git', ['add', '--', ...changed], { cwd: dirs.work });
  sh('git', [...author, 'commit', '-q', '-m', `Fix: ${issue.title} (#${number})`], { cwd: dirs.work });
  // Push with gh's credential in this trusted process only; the model never sees it.
  sh('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-q', '-u', 'origin', branch], { cwd: dirs.work });
  const body = [
    `Fixes #${number}.`, '', `**Goal:** ${t.goal}`, `**Done when:** ${t.acceptance}`, '',
    `**Changed:** ${changed.map((f) => `\`${f}\``).join(', ')}`, '',
    `**What the coding step reported:** ${impl.text.trim()}`, '',
    '**Tests before the fix** (the new tests on the old code):', '```', testSummary(before.output), '```',
    '**Tests after the fix:**', '```', testSummary(after.output), '```',
    'Ready for review. Nothing is merged automatically.', footer,
  ].join('\n');
  const pr = gh('pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
    '--title', `Fix: ${issue.title} (#${number})`, '--body', body).trim();
  gh('issue', 'comment', String(number), '--repo', repo, '--body',
    `**Low risk.** Fixed and tested in ${pr}. It waits for a person to review it.${footer}`);
  return { status: 'complete', risk, pr, changed, receipts: [...triageReceipts, ...implReceipts] };
}
