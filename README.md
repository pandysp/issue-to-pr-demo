# From a GitHub issue to a pull request

Two tickets come in about the same CSV export. One reports a missing order. The other asks to include internal notes. The first ticket has a result you can test. The second needs someone to decide who may see the data.

This demo uses [Flue](https://flueframework.com/) and the Codex CLI to take a different next step for each ticket:

| Real issue | What happened |
| --- | --- |
| [**#3 · CSV export is missing the last order**](https://github.com/pandysp/issue-to-pr-demo/issues/3) | `risk:low` · The agent wrote a regression test and fixed the exporter. Two tests failed on the old code; all four passed with the fix. [Review the patch in PR #5 →](https://github.com/pandysp/issue-to-pr-demo/pull/5/files) |
| [**#4 · Include hidden fields in the CSV export**](https://github.com/pandysp/issue-to-pr-demo/issues/4) | `risk:high` · The agent asked, *“Who may generate and receive a CSV containing those fields?”* It stopped without changing code. [Read the questions →](https://github.com/pandysp/issue-to-pr-demo/issues/4#issuecomment-7040556532) |

You can inspect both runs without installing anything. To run it yourself, [start the listener on your fork](#try-it-on-your-own-fork). To see how the decision is made, [follow one ticket through the code](#how-the-workflow-works).

## Try it on your own fork

You'll need Git, Node.js 24 or newer (checked on 24.0.0 and 26.13.0), the [GitHub CLI](https://cli.github.com/) and the [Codex CLI](https://developers.openai.com/codex/cli/) (tested with 0.171.0) on macOS or Linux. GitHub gives the workflow permission to write to **your fork**. Your ChatGPT account supplies **your Codex allowance**. No API key or GitHub Actions secret is needed. Use a trusted machine: the agents' sandbox does not hide every file your user can read.

### 1. Fork and install

[Fork this repository](https://github.com/pandysp/issue-to-pr-demo/fork) to your **personal account**. In your fork, enable **Settings → General → Features → Issues**. Sign in with `gh auth login` if needed, then run:

```sh
REPO="$(gh api user --jq .login)/issue-to-pr-demo"  # Change the name if you renamed your fork.
gh repo clone "$REPO" issue-to-pr-local
cd issue-to-pr-local/workflow
npm ci
```

### 2. Sign in and listen

Use the same terminal. The talk used `gpt-6.2-sol` at high reasoning effort. If your plan doesn't offer it, run `export DEMO_CODEX_MODEL='your-model-id'` first. Use an ID from `/model` in your Codex CLI that supports high effort.

The first command opens Codex sign-in for this demo. Choose **Sign in with ChatGPT**. The second watches your fork for 20 minutes.

```sh
node listen.mjs --repo "$REPO" --login
node listen.mjs --repo "$REPO" --minutes 20
```

### 3. Open a new issue

Wait for **`listening on OWNER/REPO`**, then open an issue **on that fork** in your browser. Try one ticket at a time. The listener finishes the first before starting the next:

| Title | Body to paste |
| --- | --- |
| **Exporting a single order produces an empty CSV** | I selected order #103. The CSV had a header but no order row. I expect #103 exactly once with the existing columns. |
| **Include internal notes in partner exports** | Support wants to share order context with partners. Could we include the internal notes in the CSV? |

Refresh the issue to see the label, then the questions or the link to a pull request. **A person decides whether to merge.**

> **No label yet?** This is a local listener, not a hosted service. Leave the terminal open. It polls every 15 seconds and only picks up issues opened **after** it starts. Only GitHub users marked `OWNER` or `COLLABORATOR` can trigger a run. If a run fails, the terminal prints the issue number and error. Fix the cause, restart the listener, then open a fresh issue. Stop with `Ctrl-C`.

## How the workflow works

If you only open one file, read [`handleIssue()`](workflow/handle-issue.mjs). The high-risk branch posts questions and returns *before the code that creates a branch*. The low-risk branch must pass a separate check before it can open a PR.

| Follow a ticket | Where to look |
| --- | --- |
| **Notice it.** Watch for new GitHub issues and handle them one at a time. | [`listen.mjs`](workflow/listen.mjs) |
| **Decide.** Check the author, ask the read-only triage agent for a decision, enforce the allowed scope and apply the label. | [`handle-issue.mjs`](workflow/handle-issue.mjs) for the rules · [`agents.mjs`](workflow/agents.mjs) for the prompts |
| **Act.** For high risk, post questions. For low risk, give the coding agent a disposable checkout. Test the patch, copy the changed tests onto the old exporter, and run them again. If they pass there too, they haven't shown the bug. | `postQuestions`, `verifyFix` and `openReviewPR` in [`handle-issue.mjs`](workflow/handle-issue.mjs) |
| **Underneath both agents.** Connect each Flue model call to a sandboxed `codex exec` and record which model and reasoning effort actually ran. | [`codex-provider.mjs`](workflow/codex-provider.mjs) |

The [workflow package](workflow/package.json) pins the runtime and exposes `npm test` (run from `workflow/`). Its [CLI setup test](workflow/setup.test.mjs) walks through sign-in and account checks; its [adapter test](workflow/codex-provider.test.mjs) exercises both agent roles without spending model usage. `npm ci` installs the versions in the [generated lockfile](workflow/package-lock.json).

<details>
<summary><strong>Run the exporter without an agent</strong></summary>

From the repository root, no sign-in or package install is needed for the exporter:

```sh
npm test
node src/cli.mjs data/orders.json
```

The [sample data](data/orders.json) contains three orders. On the demo baseline the CSV ends at #102, even though the original tests pass. [PR #5](https://github.com/pandysp/issue-to-pr-demo/pull/5) adds the missing check and fixes the export loop.

</details>

<details>
<summary><strong>Permissions, test evidence and private state</strong></summary>

- **Access.** GitHub organization membership alone (`MEMBER`) does not start a run. Use a trusted machine and trusted collaborators: sandboxing limits writes and network access but does **not** hide every file your user can read. The listener does not pass its GitHub token to Codex in the worker environment.
- **Changes.** The workflow labels a run low risk only if all proposed files are under `src/` or `test/`. It checks the actual diff again before opening a PR. The patch is visible on GitHub before human review; the agent's free-form implementation summary stays out of the PR.
- **Evidence.** The workflow runs tests itself in a read-only sandbox with networking disabled. The PR includes test counts rather than raw output. Flue creates each triage instance only once so the same issue doesn't start a second run.
- **Private state.** The dedicated Codex login, database, checkouts, log and model receipts live under `~/.local/state/issue-to-pr-demo/<owner>/<repo>/` (lowercase). Keep this directory private and outside the checkout. To move it, pass the same `--state-dir /path/to/state` to every invocation.
- **Setup check.** `node listen.mjs --repo "$REPO" --check` confirms the login method and repository access without starting a listener or consuming model usage. It reports the requested model; the first issue tests whether your account can use it.

</details>

[MIT license](LICENSE)

<!-- pi 018634af · 2026-11-20T15:37+01:00 -->
