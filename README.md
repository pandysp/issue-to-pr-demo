# issue-to-pr-demo

A tiny CSV order exporter and a [Flue](https://flueframework.com) workflow that reacts to new GitHub issues.

When an issue is opened, the workflow sorts it by risk:

- **Low risk** (a clear bug in the exporter): an agent writes a test that shows the bug, fixes the code, and the workflow opens a pull request that is ready for review. Nothing is merged automatically.
- **High risk** (anything ambiguous, or a change to which data is exported): the workflow asks concrete questions on the issue and stops. No branch, no code, no pull request.

See both outcomes on the [original demo's Issues page](https://github.com/pandysp/issue-to-pr-demo/issues), or [try it on your own fork](#try-it-on-your-own-fork).

## The exporter

`src/export.mjs` turns selected orders into CSV. Only the public columns (`id`, `customer`, `total`, `status`) are exported. Internal notes stay out.

```sh
npm test                               # run the tests
node src/cli.mjs data/orders.json      # export the three sample orders
```

## How the workflow works

```
new issue
  → admission: only the repository owner and collaborators reach a model
  → Triage agent (read-only) records a risk decision
  → label risk:low or risk:high
  → low:  Implement agent works in a throwaway checkout
          → the workflow checks the change and runs the tests before and after
          → pull request, ready for review
  → high: questions on the issue, then stop
```

**Follow one ticket through the code:**

1. [`listen.mjs`](workflow/listen.mjs) watches GitHub. When a new issue appears, it calls `handleIssue` with the issue number.
2. [`handle-issue.mjs`](workflow/handle-issue.mjs) is the main story. Read `handleIssue` top to bottom: check the author, request a decision, apply the label, then either post questions and stop or request a fix, check it and open a PR. A person decides whether to merge.
3. [`agents.mjs`](workflow/agents.mjs) shows what the model is asked to do at those two calls. `Triage` returns a structured decision; `Implement` edits a disposable checkout. Neither posts to GitHub.
4. [`codex-provider.mjs`](workflow/codex-provider.mjs) is the adapter, not another workflow step. Read it if you want to see how a Flue model call becomes a sandboxed Codex CLI run using the attendee’s ChatGPT login.

### What the agents can and cannot do

- Neither agent has a Flue sandbox, so Flue gives them no file or shell tools.
- Each model call is one `codex exec` run in Codex's own sandbox:
  - Triage runs `read-only`.
  - Implement runs `workspace-write` in one throwaway checkout. Network access is off.
- The listener reads GitHub issues. The handler writes labels, comments and pull requests. Neither passes its GitHub token to Codex in the worker environment.
- Codex signs in locally in a dedicated Codex home outside the checkout. You don't need to copy a token, export an API key, or put a secret in GitHub. Keep the state directory private: it contains the local sign-in and run records.
- The workflow accepts a change only if it touches nothing outside `src/` and `test/`. The new tests must fail on the old code and pass on the new code. Otherwise no pull request is opened.
- The workflow runs those tests itself, in Codex's read-only sandbox (`codex sandbox -P :read-only`): no network, no writes, a throwaway home directory. Only the counts go into the pull request.
- Known limit: Codex's sandboxes block network and writes, but not reads. That is why only the owner and collaborators can start a run, and why the workflow posts nothing to GitHub except the triage text, the counts and the reviewed diff.
- Issues from people who are not the owner or a collaborator are ignored, so strangers cannot start model runs.
- A re-delivered issue does not start a second run: each issue gets one Flue agent instance, created only once.

## Try it on your own fork

<!-- pi 018634af · 2026-11-20T15:17+01:00 -->
**You supply two logins.** GitHub gives the listener permission to write to *your fork*. Choosing **Sign in with ChatGPT** in the Codex CLI uses the Codex allowance of *your ChatGPT account*. It doesn't use the original author's subscription. This workflow doesn't use API-key billing or GitHub Actions.

Use a local macOS or Linux shell with Git, [GitHub CLI](https://cli.github.com/), [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) and Node.js (tested with 26.13.0). Your ChatGPT account must include Codex and support the selected model at high reasoning effort. Use a trusted machine and trusted collaborators: the sandbox limits writes and networking, but does not isolate all reads.

1. Fork this repository on GitHub and enable **Settings → General → Features → Issues** on the fork. Run `gh auth login` if not already signed in. Clone **your fork**, not the original:

   ```sh
   REPO="$(gh api user --jq .login)/issue-to-pr-demo"  # edit if you renamed the fork or used an organization
   gh repo clone "$REPO" issue-to-pr-local
   cd issue-to-pr-local/workflow
   npm ci
   ```

2. Sign in once for this demo. The command opens the official Codex login flow. Choose **Sign in with ChatGPT** and finish in your browser. It checks the login method and exits; it does not start a listener. Use the same terminal for the remaining commands.

   ```sh
   node listen.mjs --repo "$REPO" --login
   ```

   The login is stored under `~/.local/state/issue-to-pr-demo/<owner>/<repo>/codex-home` (lowercase owner/repo), separate from your everyday Codex setup. Never upload this directory, paste its contents, or put it in a fork or CI secret.

3. Check the target, then start listening. The talk used `gpt-6.2-sol`. If your account doesn't offer it, set `DEMO_CODEX_MODEL` to a model shown by `/model` in your Codex CLI that supports high reasoning effort.

   ```sh
   # export DEMO_CODEX_MODEL='your-model-id'
   node listen.mjs --repo "$REPO" --check
   node listen.mjs --repo "$REPO" --minutes 20
   ```

   `--check` reports the GitHub account, fork, default branch, ChatGPT login method and requested model. It doesn't call a model or verify model availability. The first issue makes the first model call; the workflow checks which model and effort actually ran. There is no fallback.

4. Wait for **`listening on OWNER/REPO`**, then open a new issue on that fork as its owner or a collaborator. Try **“Include internal notes in the CSV export.”** Expect a risk label and questions about who may see those notes. For the low-risk path, try **“CSV export is missing the last selected order.”** A successful fix opens a PR; nothing is merged automatically.

Keep the terminal running. The listener polls every 15 seconds; it ignores older tickets. Ctrl-C stops it, or it stops polling after the time window. Its private state directory holds checkouts, the Flue database, the listener log and `codex-receipts.jsonl` (thread ID, model, effort, sandbox). To use a different private directory outside the checkout, pass the same `--state-dir /path/to/state` to every command.
