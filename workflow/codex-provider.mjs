// A Flue/Pi model provider backed by the official Codex CLI ("codex exec").
// Each model call starts one sandboxed Codex run with the ChatGPT login Codex already has,
// so no API key is used. Codex is a restricted worker: read-only for triage, workspace-write
// (network off) in one throwaway checkout for code changes. The worker gets no GitHub token.
//
// Structured results: when the agent offers exactly one tool, Codex must answer with JSON that
// matches the tool's parameter schema (codex --output-schema), and the adapter returns it as a
// call to that tool. Without tools, Codex's final message is returned as text.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProvider, createAssistantMessageEventStream, getSystemMessageText, contentText,
} from '@earendil-works/pi-ai';

// pi 018634af · 2026-11-20T15:25+01:00
export const CODEX_MODEL = process.env.DEMO_CODEX_MODEL ?? 'gpt-6.2-sol';
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(CODEX_MODEL)) throw new Error('Invalid DEMO_CODEX_MODEL');
export const workerEnv = (codexHome) => ({ PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: codexHome, LANG: 'en_US.UTF-8' });
const API = 'codex-cli-exec';

const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// Tools offered to the agent at this point of the transcript. Flue always adds its `task`
// delegation tool; our agents declare no subagents, so it is inert and left out here.
function activeTools(messages) {
  const tools = new Map();
  for (const m of messages) {
    if (m.role !== 'system') continue;
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
  }
  tools.delete('task');
  return [...tools.values()];
}

// Flatten the transcript into one prompt for a fresh Codex run.
function renderPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') parts.push(getSystemMessageText(m));
    else if (m.role === 'user') parts.push(`USER:\n${contentText(m.content)}`);
    else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text) parts.push(`ASSISTANT:\n${text}`);
    } else if (m.role === 'toolResult') parts.push(`TOOL RESULT (${m.toolName}):\n${contentText(m.content)}`);
  }
  return parts.join('\n\n');
}

// Codex's structured output wants a plain JSON Schema object.
function outputSchema(parameters) {
  const { $schema, ...rest } = parameters;
  return rest;
}

function findSession(codexHome, threadId) {
  const stack = [join(codexHome, 'sessions')];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (name.includes(threadId) && name.endsWith('.jsonl')) return path;
    }
  }
  throw new Error(`Codex session record for thread ${threadId} not found`);
}

// Model and effort as Codex itself recorded them for this run.
function sessionReceipt(codexHome, threadId) {
  const lines = readFileSync(findSession(codexHome, threadId), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ctx = lines.find((l) => l.type === 'turn_context')?.payload;
  if (!ctx) throw new Error(`No turn_context in Codex session ${threadId}`);
  return { threadId, model: ctx.model, effort: ctx.effort, sandbox: ctx.sandbox_policy?.type };
}

function runCodex({ codexHome, prompt, cwd, sandbox, effort, schema, signal }) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-call-'));
  const lastPath = join(dir, 'answer.txt');
  const args = [
    'exec', '-c', 'cli_auth_credentials_store="file"', '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${effort}"`,
    '--sandbox', sandbox, '--skip-git-repo-check', '--json', '-C', cwd, '-o', lastPath,
  ];
  if (schema) {
    const schemaPath = join(dir, 'schema.json');
    writeFileSync(schemaPath, JSON.stringify(schema));
    args.push('--output-schema', schemaPath);
  }
  args.push(prompt);
  return new Promise((resolve, reject) => {
    // Pass an allowlist of environment variables, not the listener’s GitHub credentials.
    const env = workerEnv(codexHome);
    const child = spawn('codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`codex exec exited ${code}: ${err.slice(-1500)}`));
      const threadId = out.match(/"thread_id":"([^"]+)"/)?.[1];
      if (!threadId) return reject(new Error('codex exec printed no thread id'));
      const usage = [...out.matchAll(/"usage":(\{[^}]*\})/g)].map((m) => JSON.parse(m[1])).pop() ?? {};
      resolve({ text: readFileSync(lastPath, 'utf8'), threadId, usage });
    });
  });
}

/**
 * @param {object} o
 * @param {string} o.readOnlyCwd   directory Codex may read during read-only calls
 * @param {string} o.workspaceCwd  the only directory Codex may write to (workspace model)
 * @param {string} o.receiptsPath  JSONL file that records one receipt per Codex call
 * @param {string} o.codexHome     private Codex home used for both interactive login and worker runs
 */
export function codexCliProvider({ readOnlyCwd, workspaceCwd, receiptsPath, codexHome }) {
  const model = (id, name, baseUrl) => ({
    id, name, api: API, provider: 'codex-cli', baseUrl, reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000,
  });
  const sandboxFor = (m) => (m.id === `${CODEX_MODEL}-workspace`
    ? { sandbox: 'workspace-write', cwd: workspaceCwd } : { sandbox: 'read-only', cwd: readOnlyCwd });

  function streamSimple(m, context, options = {}) {
    const stream = createAssistantMessageEventStream();
    const effort = options.reasoning ?? 'medium';
    const partial = {
      role: 'assistant', content: [], api: API, provider: 'codex-cli', model: m.id,
      usage: zeroUsage(), stopReason: 'stop', timestamp: Date.now(), providerThinkingLevel: effort,
    };
    (async () => {
      try {
        const messages = context.messages;
        const tools = activeTools(messages);
        const last = messages[messages.length - 1];
        stream.push({ type: 'start', partial });
        if (last?.role === 'toolResult') {
          // The tool already recorded the answer; finish the turn without another Codex run.
          partial.content.push({ type: 'text', text: 'Recorded.' });
          stream.push({ type: 'done', reason: 'stop', message: partial });
          return;
        }
        if (tools.length > 1) throw new Error(`codex-cli adapter supports at most one tool, got ${tools.map((t) => t.name).join(', ')}`);
        // First translate Flue’s turn into one CLI invocation. Both roles use the same
        // model, but triage reads the base checkout while implementation writes to work.
        const { sandbox, cwd } = sandboxFor(m);
        const tool = tools[0];
        const run = await runCodex({
          codexHome, prompt: renderPrompt(messages), cwd, sandbox, effort,
          schema: tool ? outputSchema(tool.parameters) : null, signal: options.signal,
        });
        const receipt = { at: new Date().toISOString(), ...sessionReceipt(codexHome, run.threadId), flueModel: `codex-cli/${m.id}` };
        appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`);
        partial.responseId = run.threadId;
        partial.responseModel = receipt.model;
        partial.usage = {
          ...zeroUsage(), input: run.usage.input_tokens ?? 0, cacheRead: run.usage.cached_input_tokens ?? 0,
          output: run.usage.output_tokens ?? 0,
          totalTokens: (run.usage.input_tokens ?? 0) + (run.usage.output_tokens ?? 0),
        };
        // Then translate the result back. Triage returns arguments for record_triage;
        // implementation leaves its patch on disk and returns ordinary text.
        if (tool) {
          const call = { type: 'toolCall', id: `call_${run.threadId}`, name: tool.name, arguments: JSON.parse(run.text) };
          partial.content.push(call);
          partial.stopReason = 'toolUse';
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial });
          stream.push({ type: 'done', reason: 'toolUse', message: partial });
        } else {
          partial.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial });
          partial.content[0].text = run.text;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: run.text, partial });
          stream.push({ type: 'text_end', contentIndex: 0, content: run.text, partial });
          stream.push({ type: 'done', reason: 'stop', message: partial });
        }
      } catch (error) {
        partial.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        partial.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: partial.stopReason, error: partial });
      }
    })();
    return stream;
  }

  return createProvider({
    id: 'codex-cli',
    name: 'Codex CLI (ChatGPT subscription)',
    // Codex uses its own ChatGPT login; the provider holds no credential.
    auth: { apiKey: { name: 'Codex CLI login', resolve: async () => ({ auth: {} }) } },
    models: [
      model(CODEX_MODEL, `${CODEX_MODEL} via Codex CLI (read-only)`, 'codex://read-only'),
      model(`${CODEX_MODEL}-workspace`, `${CODEX_MODEL} via Codex CLI (workspace-write)`, 'codex://workspace-write'),
    ],
    api: { stream: streamSimple, streamSimple },
  });
}
