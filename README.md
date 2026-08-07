# thoughtbridge-runner

Turn spoken thoughts into pull requests.

End a [ThoughtBridge](https://github.com/ThoughtBridge) voice capture with
**"bridge it"** and this runner - on *your* machine, with *your* coding agent
(Claude Code by default; Codex and Gemini also supported) - picks the thought
up, implements it on a branch in the project's GitHub repo, and opens a PR.
If the agent needs a decision, the question appears in the ThoughtBridge app;
your answer resumes the session.

Your code and the full agent conversation never leave your machine -
ThoughtBridge only sees the run's status, branch, PR link, and any questions
the runner reports.

## Requirements

- Node 20+, `git`, [`gh`](https://cli.github.com) (authenticated), and
  whichever agent CLI you select (`claude`, `codex`, or `gemini`),
  authenticated, on the machine
- A ThoughtBridge API key with the **runner** scope (app → Settings → API keys)
- v1 works with **GitHub destinations** (a PR is the review mechanism)

## Run it

```bash
npm install
TB_API_KEY=tbk_… npm start          # poll loop (60s)
TB_API_KEY=tbk_… npm run once       # single pass - good for testing
```

Config via env or `~/.thoughtbridge-runner.json`:

| Key | Default | Meaning |
|---|---|---|
| `TB_API_KEY` | - (required) | runner-scoped ThoughtBridge API key |
| `TB_API_URL` | production API | override for self-hosted backends |
| `TB_RUNNER_ID` | `runner-<hostname>` | stable id shown on the run |
| `TB_WORKDIR` | `~/.thoughtbridge-runner/work` | where repos are cloned |
| `TB_AGENT` | `claude` | which coding-agent CLI drives sessions: `claude`, `codex`, or `gemini`. See `src/agents.ts`. Codex and claude can resume a session natively; gemini can't, so the runner replays conversation history from a local file instead. Gemini also needs `GOOGLE_CLOUD_PROJECT` set in this process's environment when its account requires one (a GCP project with the Cloud AI Companion API enabled) - the `gemini` CLI itself reports this if it's missing. |
| `TB_AGENT_COMMAND` | *(none - plain prompt)* | your own skill/slash command, e.g. `/my-orchestrator`. The runner invokes it with the thought and steps back. |
| `TB_MODEL` | *(none - the agent's default)* | model for every session the runner drives, passed as `--model` (claude) or `-m` (codex, gemini). For claude, an alias (`sonnet`, `opus`, `fable`, `haiku`) or a full model name (`claude-sonnet-5`). Unset, sessions use whatever the CLI's own config selects - the runner logs the effective agent and model at startup. |
| `TB_POLL_SECONDS` | `60` | queue poll interval |

## How a run works

1. Claim a queued thought (5-minute cancel grace window has passed).
2. Fresh checkout of the project's repo → branch `thought/<id>`.
3. Drive a headless agent session: the thought is the work order; the repo's
   own `AGENTS.md` / `.thoughtbridge/THOUGHTBRIDGE.md` are the context.
4. `QUESTION: …` in the agent's reply pauses the run → the question shows in
   the app → your answer resumes the same session.
5. Push the branch, open a PR, report `pr_ready`.

The run record carries `(machine, sessionId)` - the adapter's resume command
(e.g. `claude --resume <sessionId>`, `codex resume <sessionId>`) on that
machine drops you into the live session at any point, when the agent
supports resuming one.

## Safety

- Never commits to the default branch - branch + PR only (enforced by the
  runner, not just the prompt).
- One run at a time; every run is cancellable from the app.
- The API key can be revoked in the app at any moment.
