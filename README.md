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

## Prerequisites

Before you start the runner, make sure you have:

- **[`git`](https://git-scm.com/downloads)** on your PATH.
- **[`gh`](https://cli.github.com)** (the GitHub CLI) on your PATH, authenticated:
  `gh auth login`.
- **At least one coding-agent CLI**, installed and authenticated:
  - **Claude Code** (default): `npm install -g @anthropic-ai/claude-code`,
    then run `claude` once and follow the login prompt.
  - **Codex**: `npm install -g @openai/codex`, then run `codex login`.
  - **Gemini CLI**: `npm install -g @google/gemini-cli`, then run `gemini`
    once and follow the first-run login prompt. Some Google accounts also
    need `GOOGLE_CLOUD_PROJECT` set - see the reference table below.
- A ThoughtBridge API key with the **runner** scope (app → Settings → API keys).

You don't need all three agent CLIs - just the ones your profiles use (see
below). The runner checks all of this itself at startup (see *Preflight*).

v1 works with **GitHub destinations** (a PR is the review mechanism).

## Quickstart

### Option A: downloaded binary

Grab the binary for your platform from the
[latest release](https://github.com/ThoughtBridge/thoughtbridge-runner/releases/latest):

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `thoughtbridge-runner-macos-arm64` |
| macOS (Intel) | `thoughtbridge-runner-macos-x64` |
| Linux (x64) | `thoughtbridge-runner-linux-x64` |

```bash
chmod +x thoughtbridge-runner-macos-arm64
echo 'TB_API_KEY=tbk_…' > .env          # one-time setup; or pass it inline as below
./thoughtbridge-runner-macos-arm64          # poll loop (60s)
./thoughtbridge-runner-macos-arm64 --once   # single pass - good for testing

# or fully parameterized, no files (see all flags: --help):
TB_API_KEY=tbk_… ./thoughtbridge-runner-macos-arm64 --id runner-codex --agent codex --model gpt-5-codex
```

### Option B: clone + npm

```bash
git clone https://github.com/ThoughtBridge/thoughtbridge-runner.git
cd thoughtbridge-runner
npm install
cp .env.example .env                # then put your real key in .env (one-time)
npm start                           # poll loop (60s)
npm run once                        # single pass - good for testing

# or fully parameterized, no files (see all flags: --help):
TB_API_KEY=tbk_... npx tsx src/index.ts --id runner-codex --agent codex --model gpt-5-codex
```

Both options run the exact same code; the binary just skips the Node/tsx
install step.

## Runner profiles - one process, N runners

By default (no config file) the runner is a single profile built from the
env vars below - unchanged from earlier versions.

To drive **several agent identities from one process** - e.g. a Codex
profile and a Gemini profile polling and building side by side - add a
`runner.yaml` next to where you run the binary (or point `--config <path>` /
`TB_CONFIG` at one):

```yaml
apiKey: tbk_...        # optional; TB_API_KEY env still wins if set
profiles:
  - id: runner-codex
    agent: codex        # claude | codex | gemini (default claude)
    model: gpt-5-codex   # optional; agent CLI's own default when omitted
  - id: runner-gemini-flash
    agent: gemini
    model: gemini-2.5-flash
```

Each profile:

- registers, polls, claims, and merge-sweeps under its **own id** (shown in
  the ThoughtBridge app's runner registry, so you can pin a project to one
  specific profile).
- gets its **own namespaced subdirectory** under `TB_WORKDIR` - two profiles
  never share a working copy of the same repo, even if they're both assigned
  the same project.
- has its poll loop **staggered a little** at startup so several profiles
  don't hit the API in lockstep.

Every other setting (`TB_API_URL`, `TB_WORKDIR`, `TB_AGENT_COMMAND`,
`TB_POLL_SECONDS`, `TB_MAX_SESSIONS`) is shared across all profiles in the
file. `TB_API_KEY`, when set, overrides `apiKey:` in the file for every
profile.

Bad config (unknown `agent:` value, a profile missing `id`, or two profiles
sharing an `id`) fails fast at startup with the exact problem named.

## Env-var single-profile mode (no config file)

Config via env or `~/.thoughtbridge-runner.json`:

| Key | Default | Meaning |
|---|---|---|
| `TB_API_KEY` | - (required) | runner-scoped ThoughtBridge API key |
| `TB_API_URL` | production API | override for self-hosted backends |
| `TB_RUNNER_ID` | `runner-<hostname>` | stable id shown on the run |
| `TB_WORKDIR` | `~/.thoughtbridge-runner/work` | where repos are cloned |
| `TB_AGENT` | `claude` | which coding-agent CLI drives sessions: `claude`, `codex`, or `gemini`. See `src/agents.ts`. |
| `TB_AGENT_COMMAND` | *(none - plain prompt)* | your own skill/slash command, e.g. `/my-orchestrator`. The runner invokes it with the thought and steps back. |
| `TB_MODEL` | *(none - the agent's default)* | model for every session the runner drives, passed as `--model` (claude) or `-m` (codex, gemini). |
| | | **Bee projects:** for claude sessions, a `bee.yaml` in the checkout wins - `models.queen.model` (aliases `opus-5.5`/`sonnet-5.5`/`haiku-5.5` accepted, `inherit` = no preference); a Bee project with neither `TB_MODEL` nor the key defaults to `claude-opus-5-5`. Non-Bee checkouts are unchanged. |
| `TB_POLL_SECONDS` | `60` | queue poll interval |
| `TB_MAX_SESSIONS` | `3` | max concurrent agent sessions per profile (always at most ONE session per repo checkout) |
| `TB_CONFIG` | *(none)* | path to a `runner.yaml` - same as `--config <path>`. Presence of `./runner.yaml` (cwd) also triggers config-file mode without setting this. |
| `GOOGLE_CLOUD_PROJECT` | *(none)* | needed by the `gemini` agent CLI on Google accounts that require a GCP project for API access - the `gemini` CLI itself reports this if it's missing. |

Codex and Claude can natively resume a session; Gemini can't, so the runner
replays conversation history from a local file instead (see `spawnTurn()` in
`src/index.ts`).

## Preflight

On every startup, before serving any work, the runner runs a fast checklist
(presence + status checks only - it never spawns a real agent turn):

- `git` on PATH.
- `gh` on PATH **and** authenticated (`gh auth status`).
- For each configured profile's agent CLI: installed, and authenticated
  where the CLI supports a cheap, read-only status check (`codex login
  status`; a probed `auth status`/`whoami`-style subcommand for `claude` and
  `gemini`; a file-based fallback for `gemini` when no such subcommand
  exists).

Every failed check prints the exact remedy (install command, auth command).

- **`git` or `gh` missing/unauthenticated** → the runner exits nonzero.
  Nothing works without them.
- **A profile's agent CLI missing/unauthenticated** → that profile is
  skipped with a loud warning; every other healthy profile still starts.
  The runner only exits nonzero when **no** profile is healthy.

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
- One run at a time per repo checkout; every run is cancellable from the app.
- The API key can be revoked in the app at any moment.

## Platform support

- **macOS** (Apple Silicon and Intel) and **Linux (x64)**: fully supported,
  including downloadable release binaries.
- **Windows**: deferred. The runner's TypeScript itself is cross-platform,
  but `bootstrap.sh` and this project's release pipeline are bash/Unix-only
  today - a Windows release needs a bash port of `bootstrap.sh` (or a
  PowerShell equivalent) plus a `bun-windows-x64` build target added to
  `.github/workflows/release.yml`. Until then, Windows users can run via
  WSL using the "clone + npm" quickstart above.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run once         # single pass against the real API
```

Release binaries are built by `.github/workflows/release.yml` on any `v*`
tag push, using [Bun](https://bun.sh)'s `--compile` cross-compilation (one
Linux runner builds all three binaries - no macOS runner needed).
