# issue-to-pr-demo

A tiny CSV order exporter and a [Flue](https://flueframework.com) workflow that reacts to new GitHub issues.

When an issue is opened, the workflow sorts it by risk:

- **Low risk** (a clear bug in the exporter): an agent writes a test that shows the bug, fixes the code, and the workflow opens a pull request that is ready for review. Nothing is merged automatically.
- **High risk** (anything ambiguous, or a change to which data is exported): the workflow asks concrete questions on the issue and stops. No branch, no code, no pull request.

See both outcomes on the [Issues page](https://github.com/pandysp/issue-to-pr-demo/issues?q=is%3Aissue).

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

Code in `workflow/`:

| File | What it does |
|---|---|
| `agents.mjs` | The two Flue agents. `Triage` decides the risk through one typed tool. `Implement` writes the test and the fix. |
| `codex-provider.mjs` | A Flue model provider that runs the official [Codex CLI](https://developers.openai.com/codex/cli) for every model call: `gpt-6.2-sol` with reasoning effort `high`, using the Codex ChatGPT login. It reads model and effort back from Codex's own session record. |
| `handle-issue.mjs` | Trusted code around the agents: admission, labels, comments, the scope check, the before/after test run and the pull request. |
| `listen.mjs` | A bounded listener for the demo. It polls for new issues and stops by itself. |

### What the agents can and cannot do

- Neither agent has a Flue sandbox, so Flue gives them no file or shell tools.
- Each model call is one `codex exec` run in Codex's own sandbox:
  - Triage runs `read-only`.
  - Implement runs `workspace-write` in one throwaway checkout. Network access is off.
- The agents never see a GitHub token. Only `handle-issue.mjs` talks to GitHub.
- Codex runs with its own home directory inside the state directory. It contains a link to the existing ChatGPT login and nothing else, so no personal Codex instructions, settings or MCP servers reach the agents. No credential is copied.
- The workflow accepts a change only if it touches nothing outside `src/` and `test/`. The new tests must fail on the old code and pass on the new code. Otherwise no pull request is opened.
- Issues from people who are not the owner or a collaborator are ignored, so strangers cannot start model runs.
- A re-delivered issue does not start a second run: each issue gets one Flue agent instance, created only once.

## Run it again

You need Node.js 22 or newer, the GitHub CLI logged in with write access to this repository, and the Codex CLI logged in with ChatGPT (with `gpt-6.2-sol` available).

```sh
cd workflow
npm ci
node listen.mjs --repo pandysp/issue-to-pr-demo --state-dir /some/dir/outside/the/repo --minutes 20
```

Then open an issue. The listener handles issues opened after it starts and stops after `--minutes`. It is not a service and it is not running unless someone starts it.

The state directory holds the Flue database, the checkouts, a log and one receipt per model call (`codex-receipts.jsonl`: Codex thread id, model, effort and sandbox).
