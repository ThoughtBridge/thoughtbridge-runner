# thoughtbridge-runner

Turn spoken thoughts into pull requests.

End a [ThoughtBridge](https://github.com/ThoughtBridge) voice capture with
**"bridge it"** and this runner — on *your* machine, with *your* Claude Code —
picks the thought up, implements it on a branch in the project's GitHub repo,
and opens a PR. If the agent needs a decision, the question appears in the
ThoughtBridge app; your answer resumes the session.

Your code and the full agent conversation never leave your machine —
ThoughtBridge only sees the run's status, branch, PR link, and any questions
the runner reports.

## Requirements

- Node 20+, `git`, [`gh`](https://cli.github.com) (authenticated), and
  [`claude`](https://claude.com/claude-code) (Claude Code) on the machine
- A ThoughtBridge API key with the **runner** scope (app → Settings → API keys)
- v1 works with **GitHub destinations** (a PR is the review mechanism)

## Run it

```bash
npm install
TB_API_KEY=tbk_… npm start          # poll loop (60s)
TB_API_KEY=tbk_… npm run once       # single pass — good for testing
```

Config via env or `~/.thoughtbridge-runner.json`:

| Key | Default | Meaning |
|---|---|---|
| `TB_API_KEY` | — (required) | runner-scoped ThoughtBridge API key |
| `TB_API_URL` | production API | override for self-hosted backends |
| `TB_RUNNER_ID` | `runner-<hostname>` | stable id shown on the run |
| `TB_WORKDIR` | `~/.thoughtbridge-runner/work` | where repos are cloned |
| `TB_AGENT_COMMAND` | *(none — plain prompt)* | your own skill/slash command, e.g. `/my-orchestrator`. The runner invokes it with the thought and steps back. |
| `TB_MODEL` | *(none — claude's default)* | model for every session the runner drives, passed to `claude` as `--model`. An alias (`sonnet`, `opus`, `fable`, `haiku`) or a full model name (`claude-sonnet-5`). Unset, sessions use whatever this machine's Claude Code config selects — the runner logs the effective setting at startup. |
| `TB_POLL_SECONDS` | `60` | queue poll interval |

## How a run works

1. Claim a queued thought (5-minute cancel grace window has passed).
2. Fresh checkout of the project's repo → branch `thought/<id>`.
3. Drive a headless Claude Code session: the thought is the work order; the
   repo's own `AGENTS.md` / `.thoughtbridge/THOUGHTBRIDGE.md` are the context.
4. `QUESTION: …` in the agent's reply pauses the run → the question shows in
   the app → your answer resumes the same session.
5. Push the branch, open a PR, report `pr_ready`.

The run record carries `(machine, sessionId)` — `claude --resume <sessionId>`
on that machine drops you into the live session at any point.

## Safety

- Never commits to the default branch — branch + PR only (enforced by the
  runner, not just the prompt).
- One run at a time; every run is cancellable from the app.
- The API key can be revoked in the app at any moment.
