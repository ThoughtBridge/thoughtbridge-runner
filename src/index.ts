#!/usr/bin/env tsx
/**
 * thoughtbridge-runner - the self-hosted bridge-it runner.
 *
 * Polls your ThoughtBridge account for thoughts you ended with "bridge it",
 * checks out the project's GitHub repo, drives a Claude Code session to build
 * the thought on a branch, and opens a PR. Questions from the agent pause the
 * run and surface in the ThoughtBridge app; your answer resumes the session.
 *
 * Requirements on this machine: git, gh (authenticated), and whichever agent
 * CLI is selected (claude / codex / gemini - see TB_AGENT below), authenticated.
 * Checked at startup - see src/preflight.ts.
 *
 * Runner profiles: one process can drive several independent runner
 * identities ("profiles"), each with its own agent CLI/model, polling and
 * claiming work under its own runnerId, in its own namespaced workdir. See
 * `runner.yaml` (or --config <path> / TB_CONFIG) below. With no config file,
 * behavior is unchanged from before profiles existed: exactly one profile
 * built from the env vars in this comment.
 *
 * Config (env or ~/.thoughtbridge-runner.json) - single-profile mode:
 *   TB_API_URL        - default https://thoughtbridge-api-238666896847.australia-southeast1.run.app/v1
 *   TB_API_KEY        - a `runner`-scoped ThoughtBridge API key (required)
 *   TB_RUNNER_ID      - stable id for this runner (default: runner-<hostname>).
 *                       Registered in your account's runner registry at startup;
 *                       the app lists instances and can pin a project's
 *                       bridge-it work to one of them.
 *   TB_WORKDIR        - where repos are cloned (default ~/.thoughtbridge-runner/work)
 *   TB_AGENT          - which coding-agent CLI drives sessions: "claude"
 *                       (default), "codex", or "gemini". See src/agents.ts.
 *                       Codex and claude can natively resume a session;
 *                       gemini can't, so the runner replays conversation
 *                       history from a local file instead (see spawnTurn()).
 *                       gemini also needs GOOGLE_CLOUD_PROJECT set in this
 *                       process's environment (a GCP project with the Cloud
 *                       AI Companion API enabled) when its account requires
 *                       one - the gemini CLI itself reports this.
 *   TB_AGENT_COMMAND  - optional skill/slash-command prefix (e.g. "/bee-feature").
 *                       Absent → plain prompt (the default for everyone).
 *   TB_MODEL          - model for every agent session the runner drives.
 *                       For claude: an alias ("sonnet", "opus", "fable",
 *                       "haiku") or a full model name, passed as --model.
 *                       For codex/gemini: passed as -m. Absent → each CLI's
 *                       own configured default.
 *   TB_POLL_SECONDS   - queue poll interval (default 60)
 *   TB_MAX_SESSIONS   - max concurrent agent sessions (default 3; always
 *                       at most ONE session per repo checkout) - applies to
 *                       EACH profile's own pool.
 *
 * Multi-profile mode - runner.yaml (cwd, or --config <path> / TB_CONFIG):
 *   apiKey: tbk_...        # optional; TB_API_KEY env still wins if set
 *   profiles:
 *     - id: runner-codex
 *       agent: codex        # claude | codex | gemini (default claude)
 *       model: gpt-5-codex  # optional; agent CLI's own default when omitted
 *     - id: runner-gemini-flash
 *       agent: gemini
 *       model: gemini-2.5-flash
 * Every other setting above (TB_API_URL, TB_WORKDIR, TB_AGENT_COMMAND,
 * TB_POLL_SECONDS, TB_MAX_SESSIONS) still applies, shared across all
 * profiles. Each profile registers, polls, claims, and merge-sweeps under
 * its own id, and gets its own namespaced subdirectory under TB_WORKDIR so
 * two profiles never share a working copy of the same repo.
 *
 * The agent SESSION stays on this machine; the run record in ThoughtBridge
 * carries (machine, sessionId) so the adapter's resume command (e.g.
 * `claude --resume <sessionId>`, `codex resume <sessionId>`) here drops
 * you into the live conversation - when the agent supports resuming one.
 */

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { pickAdapter, type AgentAdapter, type SessionResult } from './agents.js';
import { runPreflight } from './preflight.js';

// ── config ──────────────────────────────────────────────────────────────────

export interface Config {
  apiUrl: string;
  apiKey: string;
  runnerId: string;
  workdir: string;
  agentCommand: string | null;
  /** Model passed to the agent CLI (--model / -m); null → its own default. */
  model: string | null;
  /** Which agent CLI drives sessions - see TB_AGENT in the header comment. */
  agent: AgentAdapter;
  pollSeconds: number;
  /** Max concurrent agent sessions (builds + merges) across all repos. */
  maxSessions: number;
}

const KNOWN_AGENTS = ['claude', 'codex', 'gemini'] as const;

interface RunnerYamlProfile {
  id?: unknown;
  agent?: unknown;
  model?: unknown;
}

interface RunnerYamlFile {
  apiKey?: unknown;
  profiles?: unknown;
}

/** --config <path> flag, else TB_CONFIG env, else ./runner.yaml if present. */
function resolveConfigPath(): string | null {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--config');
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1]!;
  const envPath = process.env['TB_CONFIG'];
  if (envPath) return envPath;
  const def = join(process.cwd(), 'runner.yaml');
  return existsSync(def) ? def : null;
}

/** Fails fast with a clear message on any malformed profile - unknown agent
 *  name, missing/blank id, or duplicate ids. */
function validateAndNormalizeProfiles(raw: unknown, confPath: string): RunnerYamlProfile[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error(`${confPath}: "profiles" must be a non-empty array.`);
    process.exit(1);
  }
  const seenIds = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      console.error(`${confPath}: profiles[${i}] must be an object.`);
      process.exit(1);
    }
    const p = entry as RunnerYamlProfile;
    if (typeof p.id !== 'string' || p.id.trim().length === 0) {
      console.error(`${confPath}: profiles[${i}] is missing a non-empty "id".`);
      process.exit(1);
    }
    if (seenIds.has(p.id)) {
      console.error(`${confPath}: duplicate profile id "${p.id}" - ids must be unique.`);
      process.exit(1);
    }
    seenIds.add(p.id);
    if (p.agent !== undefined && !KNOWN_AGENTS.includes(p.agent as (typeof KNOWN_AGENTS)[number])) {
      console.error(
        `${confPath}: profile "${p.id}" has unknown agent "${String(p.agent)}" - must be one of: ${KNOWN_AGENTS.join(', ')}.`,
      );
      process.exit(1);
    }
    if (p.model !== undefined && typeof p.model !== 'string') {
      console.error(`${confPath}: profile "${p.id}" has a non-string "model".`);
      process.exit(1);
    }
  }
  return raw as RunnerYamlProfile[];
}

/**
 * Builds one Config per profile. With no runner.yaml (and no --config /
 * TB_CONFIG), this is exactly today's behavior: a single profile from
 * TB_RUNNER_ID/TB_AGENT/TB_MODEL, workdir unchanged (no per-profile
 * subdirectory) - so existing single-runner setups keep working unchanged.
 */
function loadConfig(): Config[] {
  let fileConf: Record<string, string> = {};
  const legacyJsonPath = join(homedir(), '.thoughtbridge-runner.json');
  if (existsSync(legacyJsonPath)) {
    try {
      fileConf = JSON.parse(readFileSync(legacyJsonPath, 'utf8')) as Record<string, string>;
    } catch {
      console.error(`warning: could not parse ${legacyJsonPath} - ignoring`);
    }
  }
  // .env next to package.json: the standard place for TB_API_KEY so plain
  // `npm start` (or the downloaded binary run from this directory) works.
  // Precedence: real env vars > .env > legacy ~/.thoughtbridge-runner.json.
  const dotenvPath = join(process.cwd(), '.env');
  if (existsSync(dotenvPath)) {
    for (const line of readFileSync(dotenvPath, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[1].startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      fileConf[m[1]] = v;
    }
  }
  const get = (key: string): string | undefined => process.env[key] ?? fileConf[key];

  const apiUrl =
    get('TB_API_URL') ?? 'https://thoughtbridge-api-238666896847.australia-southeast1.run.app/v1';
  const workdirBase = get('TB_WORKDIR') ?? join(homedir(), '.thoughtbridge-runner', 'work');
  const agentCommand = get('TB_AGENT_COMMAND') ?? null;
  const pollSeconds = Number(get('TB_POLL_SECONDS') ?? 60);
  const maxSessions = Math.max(1, Number(get('TB_MAX_SESSIONS') ?? 3));

  const confPath = resolveConfigPath();
  if (!confPath) {
    const apiKey = get('TB_API_KEY');
    if (!apiKey) {
      console.error(
        'TB_API_KEY is required (a runner-scoped ThoughtBridge API key, created in the app under Settings > API keys).\n' +
          'Provide it one of three ways:\n' +
          '  1. a .env file in this directory containing:  TB_API_KEY=tbk_...\n' +
          '  2. inline:  TB_API_KEY=tbk_... npm start\n' +
          '  3. "apiKey:" in a runner.yaml (see README for the profile format)',
      );
      process.exit(1);
    }
    return [
      {
        apiUrl,
        apiKey,
        runnerId: get('TB_RUNNER_ID') ?? `runner-${hostname()}`,
        workdir: workdirBase,
        agentCommand,
        model: get('TB_MODEL') ?? null,
        agent: pickAdapter(get('TB_AGENT')),
        pollSeconds,
        maxSessions,
      },
    ];
  }

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(confPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${confPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (typeof doc !== 'object' || doc === null) {
    console.error(`${confPath}: expected a YAML mapping at the top level.`);
    process.exit(1);
  }
  const yamlFile = doc as RunnerYamlFile;
  const profiles = validateAndNormalizeProfiles(yamlFile.profiles, confPath);

  const apiKey = process.env['TB_API_KEY'] ?? (typeof yamlFile.apiKey === 'string' ? yamlFile.apiKey : undefined);
  if (!apiKey) {
    console.error(
      `TB_API_KEY is required - set "apiKey:" in ${confPath}, add TB_API_KEY=tbk_... to a .env file in this directory, or set the TB_API_KEY env var.`,
    );
    process.exit(1);
  }

  return profiles.map((p) => ({
    apiUrl,
    apiKey,
    runnerId: p.id as string,
    // Namespaced per profile so two profiles never share a working copy of
    // the same repo (extends every checkout key derived from workdir).
    workdir: join(workdirBase, p.id as string),
    agentCommand,
    model: typeof p.model === 'string' ? p.model : null,
    agent: pickAdapter(p.agent as string | undefined),
    pollSeconds,
    maxSessions,
  }));
}

// ── session pool ────────────────────────────────────────────────────────────

/**
 * One Bridget session per repo, a few across the whole runner. The unit of
 * mutual exclusion is the repo CHECKOUT (two sessions in one working tree
 * would fight over branches), which yields one-session-per-project whenever
 * projects live in their own repos - and safely serializes projects that
 * share a repo (shared destinations). A run waiting on a user answer holds
 * only its own slot; other repos keep building.
 */
class SessionPool {
  private readonly busyRepos = new Set<string>();
  private readonly active = new Map<string, Promise<void>>(); // captureId → task

  constructor(private readonly maxSessions: number) {}

  /** Starts [task] if the capture isn't already running, its repo is free,
   *  and a slot is available. Returns whether it started. */
  schedule(repo: string | null, cid: string, task: () => Promise<void>): boolean {
    if (this.active.has(cid)) return false;
    if (repo !== null && this.busyRepos.has(repo)) return false;
    if (this.active.size >= this.maxSessions) return false;
    if (repo !== null) this.busyRepos.add(repo);
    const p = task()
      .catch((err: unknown) =>
        console.error(
          `[${cid.slice(0, 8)}] unhandled: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        if (repo !== null) this.busyRepos.delete(repo);
        this.active.delete(cid);
      });
    this.active.set(cid, p);
    return true;
  }

  isActive(cid: string): boolean {
    return this.active.has(cid);
  }

  /** Waits for every in-flight session to finish (used by --once). */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.race([...this.active.values()]);
    }
  }
}

// ── ThoughtBridge API ───────────────────────────────────────────────────────

interface QueuedRun {
  captureId: string;
  projectId: string;
  projectSlug: string;
  title: string | null;
  executeInstruction: string | null;
  repoFullName: string | null;
  queuedAt: string;
  status: string;
  sessionId: string | null;
}

class TB {
  constructor(private readonly conf: Config) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.conf.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.conf.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Startup registration: lands this instance in the account's runner
   * registry so the app can list it and pin projects to it. Best-effort -
   * an older API without the endpoint must not stop the runner.
   */
  async register(): Promise<void> {
    try {
      await this.call('POST', '/runner/register', {
        runnerId: this.conf.runnerId,
        machine: hostname(),
      });
      console.log(`registered as ${this.conf.runnerId} in the runner registry`);
    } catch (err) {
      console.error(
        `warning: runner registration failed (older API?): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  queue(): Promise<{ runs: QueuedRun[] }> {
    // runnerId identifies this instance: heartbeat for the registry, and the
    // server hides runs for projects pinned to a different runner.
    return this.call('GET', `/runner/queue?runnerId=${encodeURIComponent(this.conf.runnerId)}`);
  }
  /** In-flight runs claimed by THIS runner - restart recovery. */
  mine(): Promise<{ runs: QueuedRun[] }> {
    return this.call('GET', `/runner/queue?mine=${encodeURIComponent(this.conf.runnerId)}`);
  }
  claim(captureId: string): Promise<Record<string, unknown>> {
    return this.call('POST', `/runner/runs/${captureId}/claim`, {
      runnerId: this.conf.runnerId,
      machine: hostname(),
    });
  }
  report(captureId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call('PATCH', `/runner/runs/${captureId}`, {
      runnerId: this.conf.runnerId,
      ...fields,
    });
  }
  capture(captureId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/captures/${captureId}`);
  }
  chats(): Promise<{ chats: PendingChat[] }> {
    return this.call('GET', `/runner/chats?runnerId=${encodeURIComponent(this.conf.runnerId)}`);
  }
  chatReply(
    projectId: string,
    text: string,
    sessionId: string | null,
    answeredCount: number,
  ): Promise<unknown> {
    return this.call('POST', `/runner/chats/${projectId}/reply`, {
      runnerId: this.conf.runnerId,
      text,
      sessionId,
      machine: hostname(),
      answeredCount,
    });
  }
}

interface ChatMessage {
  messageId: string;
  role: 'user' | 'bridget';
  text: string;
  createdAt: string;
}

interface PendingChat {
  projectId: string;
  projectName: string;
  projectSlug: string;
  repoFullName: string;
  sessionId: string | null;
  messages: ChatMessage[];
  pendingCount: number;
}

// ── git helpers ──────────────────────────────────────────────────────────────

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureCheckout(workdir: string, repoFullName: string, suffix = ''): string {
  const dir = join(workdir, repoFullName.replace('/', '__') + suffix);
  if (!existsSync(dir)) {
    console.log(`  cloning ${repoFullName}…`);
    sh(workdir, 'gh', ['repo', 'clone', repoFullName, dir]);
  }
  const defaultBranch = sh(dir, 'gh', [
    'repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name',
  ]).trim();
  sh(dir, 'git', ['fetch', 'origin', defaultBranch]);
  sh(dir, 'git', ['checkout', defaultBranch]);
  sh(dir, 'git', ['reset', '--hard', `origin/${defaultBranch}`]);
  return dir;
}

/** The QUESTION marker contract for headless runs (v0). */
const QUESTION_RE = /^QUESTION:\s*(.+)$/m;

// ── replay fallback for agents that can't natively resume a session ────────
//
// Codex and claude carry a real session id across turns (`--resume <id>`).
// Gemini's --resume only understands "latest" or a per-directory index, not
// a stable id, so canResume is false for it. For those adapters we keep a
// small per-run transcript in the checkout and replay it into a fresh spawn
// on every turn instead of resuming. The chat lane doesn't need this - its
// server-side message history already gives a fresh session everything it
// needs (see answerChat).

interface HistoryEntry {
  role: 'prompt' | 'reply';
  text: string;
}

function historyFileName(captureId: string): string {
  return `.tb-run-history-${captureId}.jsonl`;
}

/** Keeps the history file out of the checkout's git status without ever
 *  touching anything that gets committed (.git/info/exclude, not .gitignore). */
function excludeFromGit(dir: string, fileName: string): void {
  try {
    const excludePath = join(dir, '.git', 'info', 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').includes(fileName)) return;
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(excludePath, `${sep}${fileName}\n`);
  } catch {
    /* best effort - never block a run over a housekeeping file */
  }
}

function appendHistory(dir: string, captureId: string, role: HistoryEntry['role'], text: string): void {
  const fileName = historyFileName(captureId);
  excludeFromGit(dir, fileName);
  appendFileSync(join(dir, fileName), `${JSON.stringify({ role, text })}\n`);
}

function readHistory(dir: string, captureId: string): HistoryEntry[] {
  const path = join(dir, historyFileName(captureId));
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HistoryEntry);
}

function buildReplayPrompt(contextHeader: string, history: HistoryEntry[], message: string): string {
  const transcript = history
    .map((h) => (h.role === 'prompt' ? `--- you were asked ---\n${h.text}` : `--- you replied ---\n${h.text}`))
    .join('\n\n');
  return `${contextHeader}

This agent CLI has no native session resume, so this is a FRESH process
being given the full conversation so far. Do not repeat completed work -
pick up exactly where the last reply left off.

CONVERSATION SO FAR
${transcript}

${message}`;
}

/**
 * Spawns one agent turn. When the active adapter can resume (claude, codex),
 * this is a thin pass-through to adapter.spawn - byte-identical to calling
 * it directly. When it can't (gemini), turns after the first are replayed
 * from a local history file instead of a native resume, and every turn is
 * recorded to that file for the next one. `contextHeader` is the run's
 * original full prompt/instructions (used only to prime a replay);
 * `message` is this turn's actual prompt (the context header itself, on the
 * very first turn).
 */
async function spawnTurn(
  conf: Config,
  dir: string,
  captureId: string,
  contextHeader: string,
  sessionId: string | null,
  message: string,
): Promise<SessionResult> {
  if (conf.agent.canResume) {
    return conf.agent.spawn(dir, message, sessionId, conf.model);
  }
  const isFirstTurn = sessionId === null;
  const prompt = isFirstTurn ? message : buildReplayPrompt(contextHeader, readHistory(dir, captureId), message);
  const result = await conf.agent.spawn(dir, prompt, null, conf.model);
  appendHistory(dir, captureId, 'prompt', message);
  appendHistory(dir, captureId, 'reply', result.text);
  // No real session id to hand back - synthesize a stable, truthy one scoped
  // to this capture so callers' "have we started yet?" checks keep working.
  return { sessionId: `replay:${captureId}`, text: result.text };
}

// ── the run ─────────────────────────────────────────────────────────────────

function buildPrompt(
  conf: Config,
  run: QueuedRun,
  captureMarkdown: string,
  branch: string,
): string {
  const skill = conf.agentCommand ? `${conf.agentCommand}\n\n` : '';
  return `${skill}You are executing a ThoughtBridge "bridge it" request: the user spoke a thought and explicitly asked for it to be built.

WORK ORDER
${run.executeInstruction ?? '(see the full thought below)'}

FULL THOUGHT
${captureMarkdown}

RULES
- You are on branch ${branch} - stay on it. NEVER commit to the default branch.
- This repo's own agent files (AGENTS.md, .thoughtbridge/THOUGHTBRIDGE.md) describe its layout and conventions - read them first and follow them.
- Implement the work order completely: code, tests if the repo has a test setup, and a short summary of what you did as your final message.
- Commit your work with clear messages (no AI attribution trailers).
- Never use em dashes or en dashes in anything you write (code comments, docs, commit messages, your summary). Use a comma, colon, or plain hyphen instead.
- If you hit a decision only the user can make, output a single line starting with "QUESTION: " stating the question, then stop. You will be resumed with the answer.`;
}

/**
 * The agent's final summary IS the PR description (the destination's
 * AGENTS.md contract makes sessions end with a PR-ready what-was-built /
 * tested / after-merge write-up); the fixed capture/session lines become a
 * short footer. Falls back to the work order when a session somehow ends
 * with no text. GitHub caps bodies at 65536 chars - truncate the summary,
 * never the footer.
 */
function buildPrBody(
  summary: string,
  cid: string,
  resumeCommand: string,
  executeInstruction: string | null,
): string {
  const footer = [
    '---',
    'Built from a ThoughtBridge "bridge it" capture.',
    '',
    `CaptureId: ${cid}`,
    `Session: \`${resumeCommand}\` on \`${hostname()}\``,
  ].join('\n');
  const body = summary.trim() || (executeInstruction ?? '').trim();
  const budget = 65_000 - footer.length;
  const clipped = body.length > budget ? `${body.slice(0, budget)}\n\n…(truncated)` : body;
  return `${clipped}\n\n${footer}`;
}

async function executeRun(
  conf: Config,
  tb: TB,
  run: QueuedRun,
  { recover = false }: { recover?: boolean } = {},
): Promise<void> {
  const cid = run.captureId;
  const tag = `[${cid.slice(0, 8)}]`;
  console.log(
    `${tag} ${recover ? '↻ recovering' : '▶'} "${run.title ?? 'untitled'}" → ${run.repoFullName}`,
  );
  if (!run.repoFullName) {
    await tb.report(cid, { status: 'failed', error: 'No repoFullName on queue entry' });
    return;
  }

  if (!recover) await tb.claim(cid);
  const branch = `thought/${cid.slice(0, 8)}`;

  try {
    const dir = recover
      ? join(conf.workdir, run.repoFullName.replace('/', '__'))
      : ensureCheckout(conf.workdir, run.repoFullName);
    if (recover && !existsSync(dir)) {
      throw new Error('Checkout missing after restart - cancel and re-bridge this thought');
    }
    sh(dir, 'git', ['checkout', recover ? branch : '-B', ...(recover ? [] : [branch])]);

    const capture = await tb.capture(cid);
    const markdown =
      (capture['renderedMarkdown'] as string | undefined) ??
      (capture['transcript'] as string | undefined) ??
      '(no transcript available)';

    // The run's original instructions - used verbatim as the first turn's
    // prompt, and as the header a replay fallback (see spawnTurn) primes
    // every later turn with.
    const contextHeader = buildPrompt(conf, run, markdown, branch);
    let sessionId: string | null = recover ? run.sessionId : null;
    let prompt = recover && sessionId
      ? 'The runner restarted. Continue the work order from where you left off - if it is already complete, summarise what was done. Same rules apply.'
      : contextHeader;
    if (recover && run.status === 'awaiting_input') {
      // Re-enter the wait: the question is still open in the app.
      const answer = await waitForAnswer(tb, cid);
      if (answer === null) {
        console.log(`${tag} run cancelled while awaiting input`);
        return;
      }
      prompt = `The user answered: ${answer}\n\nContinue the work order. Same rules apply.`;
    }

    // Session loop: run → maybe QUESTION → wait for answer → resume.
    // The final iteration's text is the agent's summary - it becomes the PR body.
    let finalSummary = '';
    for (;;) {
      await tb.report(cid, {
        status: 'building',
        ...(sessionId ? {} : { branch }),
        ...(sessionId ? { sessionId } : {}),
      });
      const result = await spawnTurn(conf, dir, cid, contextHeader, sessionId, prompt);
      finalSummary = result.text;
      sessionId = result.sessionId;
      await tb.report(cid, { status: 'building', sessionId, branch });

      const q = QUESTION_RE.exec(result.text);
      if (!q) break;

      console.log(`${tag} ? ${q[1]}`);
      await tb.report(cid, { status: 'awaiting_input', question: q[1]!, sessionId });
      const answer = await waitForAnswer(tb, cid);
      if (answer === null) {
        console.log(`${tag} run cancelled while awaiting input`);
        return; // cancelled - nothing more to do
      }
      prompt = `The user answered: ${answer}\n\nContinue the work order. Same rules apply.`;
    }

    // Guard: the agent must not have wandered off the branch.
    const current = sh(dir, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (current !== branch) {
      throw new Error(`Agent ended on branch "${current}" instead of "${branch}"`);
    }

    // Anything uncommitted? Commit it so the PR is complete.
    const dirty = sh(dir, 'git', ['status', '--porcelain']).trim();
    if (dirty) {
      sh(dir, 'git', ['add', '-A']);
      sh(dir, 'git', ['commit', '-m', `feat: ${run.title ?? 'bridge-it thought'}\n\nRemaining changes from the bridge-it session.`]);
    }

    const commits = sh(dir, 'git', ['rev-list', '--count', `origin/HEAD..${branch}`]).trim();
    if (commits === '0') {
      // Multi-repo thoughts can be app-only: zero commits in THIS repo while
      // the session opened sibling PRs elsewhere. Promote the first sibling
      // to the run's PR so review/approve/merge work exactly as usual.
      const orphanSibs = extractSiblingPrUrls(finalSummary, '');
      if (orphanSibs.length > 0) {
        const [head, ...rest] = orphanSibs;
        const orphanSteps = extractAfterMergeSteps(finalSummary);
        await tb.report(cid, {
          status: 'pr_ready',
          prUrl: head!,
          sessionId,
          branch,
          ...(rest.length > 0 ? { siblingPrUrls: rest } : {}),
          ...(orphanSteps ? { postMergeSteps: orphanSteps } : {}),
        });
        console.log(
          `${tag} ✔ no root commits - sibling PR ready: ${head}` +
            (rest.length > 0 ? ` (+${rest.length} more)` : ''),
        );
        return;
      }
      // Surface WHY in the app: the session's own closing words are the
      // only explanation the user gets (resume hint included for digging).
      const summaryTail = finalSummary.trim().slice(0, 350);
      await tb.report(cid, {
        status: 'done',
        sessionId,
        error:
          `Session produced no commits - nothing to open a PR for. ` +
          `Bridget's last words: "${summaryTail}" - resume with: ${conf.agent.resumeCommand(dir, sessionId ?? '')}`,
      });
      console.log(`${tag} no commits - reported done (empty)`);
      return;
    }

    sh(dir, 'git', ['push', '-u', 'origin', branch, '--force-with-lease']);
    const prUrl = sh(dir, 'gh', [
      'pr', 'create',
      '--head', branch,
      '--title', `Thought: ${run.title ?? cid}`,
      '--body',
      buildPrBody(finalSummary, cid, conf.agent.resumeCommand(dir, sessionId ?? ''), run.executeInstruction),
    ]).trim();

    // Sibling PRs the session opened (multi-repo bridge-it) ride the run
    // record so the app can list every PR, not just the root one.
    const siblingPrUrls = extractSiblingPrUrls(finalSummary, prUrl);
    const postMergeSteps = extractAfterMergeSteps(finalSummary);
    await tb.report(cid, {
      status: 'pr_ready',
      prUrl,
      sessionId,
      branch,
      ...(siblingPrUrls.length > 0 ? { siblingPrUrls } : {}),
      ...(postMergeSteps ? { postMergeSteps } : {}),
    });
    console.log(
      `${tag} ✔ PR ready: ${prUrl}` +
        (siblingPrUrls.length > 0 ? ` (+${siblingPrUrls.length} sibling)` : ''),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} ✖ failed: ${message}`);
    try {
      // Never mark a run failed when its PR actually merged - a late error
      // (e.g. pushing a branch GitHub deleted on merge) is success noise.
      const capture = await tb.capture(cid).catch(() => null);
      const prUrl = (capture?.['executeRun'] as { prUrl?: string | null } | null)?.prUrl;
      if (prUrl) {
        const state = sh(process.cwd(), 'gh', [
          'pr', 'view', prUrl, '--json', 'state', '--jq', '.state',
        ]).trim();
        if (state === 'MERGED') {
          console.log(`${tag} PR is merged - reporting done despite the late error`);
          await tb.report(cid, { status: 'done' });
          return;
        }
      }
      await tb.report(cid, { status: 'failed', error: message.slice(0, 500) });
    } catch {
      /* run may have been cancelled - nothing to report onto */
    }
  }
}

/** Polls the run until the user answers (returns the answer) or cancels (null). */
async function waitForAnswer(tb: TB, captureId: string): Promise<string | null> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    const capture = await tb.capture(captureId);
    const run = capture['executeRun'] as
      | { status?: string; answer?: string | null }
      | null
      | undefined;
    if (!run) return null;
    if (run.status === 'cancelled') return null;
    if (typeof run.answer === 'string' && run.answer.length > 0) return run.answer;
  }
}


/**
 * Approve & merge: the app flipped a pr_ready run to merge_requested. Resume
 * the stored Claude session in the repo checkout so it can update the branch
 * from main, resolve the expected conflicts (agent files, thoughts-state.json),
 * and merge the PR. Conflicts are why a plain GitHub-API merge is not enough.
 * On failure the run goes back to pr_ready with the error so the Approve
 * button reappears and the merge can be retried.
 */
async function sweepMergeRequests(conf: Config, tb: TB, pool: SessionPool): Promise<void> {
  const { runs } = await tb.mine();
  for (const r of runs) {
    // merging = we crashed mid-merge on a previous cycle; re-enter the flow
    // (the merge prompt is idempotent - an already-merged PR just verifies).
    // awaiting_input WITH a prUrl = a merge-flow question survived a restart
    // (build questions never have a PR yet); pick up the wait here.
    if (
      r.status !== 'merge_requested' &&
      r.status !== 'merging' &&
      r.status !== 'awaiting_input'
    )
      continue;
    const cid = r.captureId;
    if (pool.isActive(cid)) continue; // its session is live right now
    const capture = await tb.capture(cid);
    const run = capture['executeRun'] as
      | { prUrl?: string | null; branch?: string | null; sessionId?: string | null; siblingPrUrls?: string[] }
      | null;
    const prUrl = run?.prUrl;
    const branch = run?.branch ?? `thought/${cid.slice(0, 8)}`;
    if (r.status === 'awaiting_input' && !prUrl) continue; // build question - recovery owns it
    if (!prUrl || !r.repoFullName) {
      await tb.report(cid, { status: 'pr_ready', error: 'Merge request missing PR or repo' });
      continue;
    }
    pool.schedule(r.repoFullName, cid, () =>
      runMergeFlow(conf, tb, r, {
        prUrl,
        branch,
        sessionId: r.sessionId ?? run?.sessionId ?? null,
        knownSiblings: run?.siblingPrUrls ?? [],
      }),
    );
  }
}

/**
 * Sibling PRs for a thought, read from the root PR's body (the session's
 * final summary lists them - see thoughtbridge-root AGENTS.md). Prefers a
 * "Sibling PRs" section when present; otherwise any GitHub PR URL in the
 * body except the root PR itself. "Done means merged" covers ALL of them.
 */
function extractSiblingPrUrls(body: string, rootPrUrl: string): string[] {
  const section = /##+\s*Sibling PRs([\s\S]*?)(?=\n##|$)/i.exec(body);
  const haystack = section ? section[1]! : body;
  const urls = haystack.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [];
  return [...new Set(urls)].filter((u) => u !== rootPrUrl);
}

/**
 * The "## After merge" section of the session summary - the manual steps the
 * user must perform after merging (restart the runner, tag a release, …).
 * Shown in the app BEFORE approval. Empty when absent or "None."
 */
function extractAfterMergeSteps(summary: string): string | null {
  const m = /##+\s*After merge([\s\S]*?)(?=\n##|$)/i.exec(summary);
  const text = m?.[1]?.trim() ?? '';
  if (!text || /^_?\s*none\.?\s*_?$/i.test(text)) return null;
  return text.slice(0, 2000);
}

function prState(cwd: string, prUrl: string): string {
  return sh(cwd, 'gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state']).trim();
}

async function runMergeFlow(
  conf: Config,
  tb: TB,
  r: QueuedRun,
  merge: { prUrl: string; branch: string; sessionId: string | null; knownSiblings?: string[] },
): Promise<void> {
  const cid = r.captureId;
  const tag = `[${cid.slice(0, 8)}]`;
  const { prUrl, branch } = merge;
  console.log(`${tag} ⇥ merging - ${prUrl}`);
    try {
      const dir = ensureCheckout(conf.workdir, r.repoFullName!);
      // One approval merges the whole thought: the root PR plus every
      // sibling PR its body lists (multi-repo bridge-it).
      let siblingPrUrls: string[] = merge.knownSiblings ?? [];
      try {
        const body = sh(dir, 'gh', ['pr', 'view', prUrl, '--json', 'body', '--jq', '.body']);
        siblingPrUrls = [...new Set([...siblingPrUrls, ...extractSiblingPrUrls(body, prUrl)])]
          .filter((u) => u !== prUrl);
      } catch {
        /* body unreadable - merge what we already know about */
      }
      if (siblingPrUrls.length > 0) {
        console.log(`${tag} + ${siblingPrUrls.length} sibling PR(s) to merge`);
        // Backfill the run record for runs reported before siblings existed.
        await tb.report(cid, { siblingPrUrls }).catch(() => {});
      }
      const siblingSection = siblingPrUrls.length > 0
        ? `\n\nThis thought also has sibling PRs in other repos - merge EVERY one of these the same way (update from its default branch, resolve conflicts by the same rules, \`gh pr merge --merge --delete-branch\`):\n${siblingPrUrls.map((u) => `- ${u}`).join('\n')}\n`
        : '';
      const prompt = `The user approved this thought's work - merge its pull request(s) into their default branches now.

Root PR: ${prUrl}
Branch: ${branch}
${siblingSection}
Steps for the root PR:
1. Read the PR with \`gh pr view ${prUrl}\`.
2. \`git fetch origin\`, check out ${branch}, and merge origin's default branch into it.
3. Resolve any conflicts:
   - Agent/instruction files (AGENTS.md, CLAUDE.md, tasks/*.md): union both sides - keep everyone's entries.
   - thoughts-state.json: reconcile PER ENTRY - for each thought id keep the side with the newest updatedAt; never drop entries that exist on only one side.
   - Anything else: prefer the intent of the PR while keeping unrelated changes from the default branch.
4. Commit the merge, push the branch, then \`gh pr merge ${prUrl} --merge --delete-branch\`.
5. Confirm every PR (root${siblingPrUrls.length > 0 ? ' and each sibling' : ''}) reports MERGED via \`gh pr view <url> --json state\`. Already-merged PRs count as success.

Note: a PR may live in a SIBLING repo rather than this checkout's repo (an
app-only thought has no root commits). \`gh pr view/merge <url>\` work from
anywhere; if conflict resolution needs a working tree, the sibling checkouts
live under repos/<name> after \`./bootstrap.sh --clone-only\`.

Do NOT commit directly to any default branch. No AI attribution in commit messages.
If you hit a decision only the user can make, output a single line starting with "QUESTION: " stating the question, then stop. You will be resumed with the answer.`;
      // Same question loop as the build flow: QUESTION → surface in the app →
      // wait for the answer → resume the merge session.
      let sessionId = merge.sessionId;
      let nextPrompt: string;
      if (r.status === 'awaiting_input') {
        // Question already posted before the restart - just wait for the answer.
        const answer = await waitForAnswer(tb, cid);
        if (answer === null) return;
        nextPrompt = `The user answered: ${answer}\n\nContinue the merge. Same rules apply.`;
      } else {
        nextPrompt = prompt;
      }
      await tb.report(cid, { status: 'merging', ...(sessionId ? { sessionId } : {}) });
      let result: SessionResult;
      for (;;) {
        result = await spawnTurn(conf, dir, cid, prompt, sessionId, nextPrompt);
        sessionId = result.sessionId;
        const q = QUESTION_RE.exec(result.text);
        if (!q) break;
        console.log(`${tag} ? ${q[1]}`);
        await tb.report(cid, { status: 'awaiting_input', question: q[1]!, sessionId });
        const answer = await waitForAnswer(tb, cid);
        if (answer === null) {
          console.log(`${tag} merge cancelled while awaiting input`);
          return;
        }
        await tb.report(cid, { status: 'merging', sessionId });
        nextPrompt = `The user answered: ${answer}\n\nContinue the merge. Same rules apply.`;
      }
      // Done means ALL merged - the root PR and every sibling PR.
      const unmerged = [prUrl, ...siblingPrUrls].filter((u) => {
        try {
          return prState(dir, u) !== 'MERGED';
        } catch {
          return true; // unreadable → treat as unmerged
        }
      });
      if (unmerged.length === 0) {
        console.log(`${tag} ✔ merged (root + ${siblingPrUrls.length} sibling) → done`);
        await tb.report(cid, { status: 'done', sessionId: result.sessionId });
      } else {
        const tail = result.text.trim().slice(-200);
        await tb.report(cid, {
          status: 'pr_ready',
          error: `Still unmerged: ${unmerged.join(', ')}. ${tail}`.slice(0, 500),
        });
        console.log(`${tag} ✖ merge incomplete - still open: ${unmerged.join(', ')}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${tag} ✖ merge failed: ${message}`);
      try {
        await tb.report(cid, {
          status: 'pr_ready',
          error: `Merge failed: ${message}`.slice(0, 500),
        });
      } catch {
        /* run may have been cancelled */
      }
    }
}

/**
 * Done means MERGED: check this runner's pr_ready runs and report the
 * outcome - done on merge, failed when the PR was closed unmerged. The
 * backend reacts to the done transition by completing the thought.
 */
async function checkOpenPRs(tb: TB): Promise<void> {
  const { runs } = await tb.mine();
  for (const r of runs) {
    if (r.status !== 'pr_ready') continue;
    const capture = await tb.capture(r.captureId);
    const run = capture['executeRun'] as
      | { prUrl?: string | null; siblingPrUrls?: string[] }
      | null;
    const prUrl = run?.prUrl;
    if (!prUrl) continue;
    const knownSiblings = run?.siblingPrUrls ?? [];
    try {
      const state = sh(process.cwd(), 'gh', [
        'pr', 'view', prUrl, '--json', 'state', '--jq', '.state',
      ]).trim();
      if (state === 'MERGED') {
        // Done means ALL merged: a hand-merged root PR only completes the
        // thought once its sibling PRs (listed in the body) are merged too.
        const body = sh(process.cwd(), 'gh', [
          'pr', 'view', prUrl, '--json', 'body', '--jq', '.body',
        ]);
        const openSiblings = [
          ...new Set([...knownSiblings, ...extractSiblingPrUrls(body, prUrl)]),
        ].filter((u) => u !== prUrl).filter((u) => {
          try {
            return prState(process.cwd(), u) !== 'MERGED';
          } catch {
            return true;
          }
        });
        if (openSiblings.length > 0) {
          console.log(
            `  root PR merged but sibling PR(s) still open (${openSiblings.join(', ')}) - waiting`,
          );
          continue;
        }
        console.log(`  ✔ PR merged → done: ${prUrl}`);
        await tb.report(r.captureId, { status: 'done' });
      } else if (state === 'CLOSED') {
        console.log(`  ✖ PR closed unmerged: ${prUrl}`);
        await tb.report(r.captureId, {
          status: 'failed',
          error: 'PR was closed without merging',
        });
      }
    } catch (err) {
      console.error('  pr check error:', err instanceof Error ? err.message : err);
    }
  }
}

// ── project chat lane ───────────────────────────────────────────────────────
// Completely separate from the build SessionPool: chats never consume build
// slots and builds never delay a chat. One conversation per project at a
// time; the session lives in a chat-only checkout (`<repo>__chat`) so it
// never touches a build tree mid-branch.

const activeChats = new Set<string>();

function chatPrompt(chat: PendingChat, dir: string): string {
  const unanswered = chat.messages
    .slice(-Math.max(chat.pendingCount, 1))
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('\n\n');
  if (chat.sessionId) {
    return `The user says:\n\n${unanswered}\n\nReply as Bridget - concise, concrete, honest. Investigate in this checkout (git, gh) when the question needs it. Actions the repo's AGENTS.md sanctions for chat sessions may be EXECUTED when the user asks; verify outcomes with real commands and state plainly what you did versus did not do - never describe unexecuted steps as done.`;
  }
  const history = chat.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Bridget'}: ${m.text}`)
    .join('\n');
  return `You are Bridget, the ThoughtBridge agent for the project "${chat.projectName}". The user is chatting with you about this project from the ThoughtBridge app.

Your working copy of the project's repo (${chat.repoFullName}) is at ${dir} - a chat-only checkout on the default branch. You may read anything (files, git history, \`gh\` for PRs/issues/CI) to answer properly. The project's captured thoughts live under ${chat.projectSlug}/thoughtbridge/ if present.

RULES
- FIRST read the repo's AGENTS.md and any .claude/skills/ - they define what a chat session may do here, including any actions explicitly SANCTIONED for chats (e.g. a release ritual). Follow them.
- Default is read-only: do not commit, push, or modify the repo EXCEPT actions the repo's AGENTS.md explicitly sanctions for chat sessions and the user explicitly asked for. For anything else that needs work, say what you'd do and suggest the user capture a thought and "bridge it".
- BE HONEST ABOUT WHAT HAPPENED. Your reply must state plainly what you actually EXECUTED versus what you did NOT do. When you perform a sanctioned action, VERIFY the outcome with real commands (e.g. the tag exists on origin, the CI run started, the artifact uploaded) and report each result. If you couldn't or didn't do something, open your reply with that - never describe unexecuted steps in a way that reads as done.
- Reply concise, concrete, honest. Plain text (light markdown fine). Your ENTIRE output is the chat reply.
- Never use em dashes or en dashes in your replies. Use a comma, colon, or plain hyphen instead.

CONVERSATION SO FAR
${history}

Reply to the user's latest message(s).`;
}

async function answerChat(conf: Config, tb: TB, chat: PendingChat): Promise<void> {
  const tag = `[chat:${chat.projectSlug}]`;
  console.log(`${tag} ${chat.pendingCount} message(s) - answering…`);
  try {
    const dir = ensureCheckout(conf.workdir, chat.repoFullName, '__chat');
    let result: SessionResult;
    try {
      // Adapters that can't resume (e.g. gemini) always report sessionId ''
      // from a chat spawn, which chatReply below stores as null - so
      // chat.sessionId is already falsy here on every turn for them, and
      // chatPrompt naturally takes its "no session, full history" branch.
      // No separate history file needed - chat.messages IS that history.
      result = await conf.agent.spawn(dir, chatPrompt(chat, dir), chat.sessionId, conf.model);
    } catch (err) {
      if (!chat.sessionId) throw err;
      // Sessions are per-directory: a repo/destination change strands the
      // stored id. Start fresh with the full preamble + history instead.
      console.log(`${tag} stored session unusable - starting fresh`);
      const fresh: PendingChat = { ...chat, sessionId: null };
      result = await conf.agent.spawn(dir, chatPrompt(fresh, dir), null, conf.model);
    }
    const text = result.text.trim() || '(Bridget had nothing to say - try rephrasing.)';
    await tb.chatReply(chat.projectId, text, result.sessionId || null, chat.pendingCount);
    console.log(`${tag} ✔ replied (${text.length} chars)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} ✖ ${message}`);
    // Best-effort error reply so the user isn't left waiting on silence.
    try {
      await tb.chatReply(
        chat.projectId,
        `Bridget hit an error answering this: ${message.slice(0, 300)} - send your message again to retry.`,
        chat.sessionId,
        chat.pendingCount,
      );
    } catch {
      /* next sweep retries */
    }
  }
}

async function sweepChats(conf: Config, tb: TB): Promise<void> {
  const { chats } = await tb.chats();
  for (const c of chats) {
    if (activeChats.has(c.projectId)) continue;
    activeChats.add(c.projectId);
    void answerChat(conf, tb, c).finally(() => activeChats.delete(c.projectId));
  }
}

// ── main loop ───────────────────────────────────────────────────────────────

/**
 * Runs ONE profile end to end: register → chat lane → restart recovery →
 * poll/claim/build loop. Independent of every other profile - its own
 * TB client (scoped by its own runnerId), its own SessionPool, its own
 * namespaced workdir (see loadConfig). Safe to run several of these
 * concurrently in the same process (see main()).
 *
 * `staggerMs` delays this profile's first poll iteration (not registration
 * or recovery) so N profiles started together don't hit the API in lockstep
 * every tick thereafter.
 */
async function runProfile(conf: Config, once: boolean, staggerMs: number): Promise<void> {
  mkdirSync(conf.workdir, { recursive: true });
  const tb = new TB(conf);

  console.log(
    `thoughtbridge-runner ${conf.runnerId} on ${hostname()} (agent: ${conf.agent.name})` +
      (conf.agentCommand ? ` (agent command: ${conf.agentCommand})` : ' (plain prompt)') +
      ` (model: ${conf.model ?? `${conf.agent.name} default`})`,
  );

  // Announce this instance to the account's runner registry (multi-instance:
  // the app lists registered runners and can pin a project to one).
  await tb.register();

  const pool = new SessionPool(conf.maxSessions);

  // Chat lane: its own faster poll (10s) so conversations feel responsive -
  // fully independent of the build queue and TB_MAX_SESSIONS.
  if (!once) {
    void (async () => {
      for (;;) {
        try {
          await sweepChats(conf, tb);
        } catch (err) {
          console.error('chat poll error:', err instanceof Error ? err.message : err);
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
    })();
  }

  // Restart recovery: pick up runs this runner had in flight.
  try {
    const { runs: mine } = await tb.mine();
    for (const r of mine) {
      // pr_ready runs are DONE building - the merge-watcher owns them from
      // here. Re-executing one re-pushes a branch that may already be merged
      // and deleted, clobbering a successful run with 'failed'. Likewise
      // merge_requested/merging belong to sweepMergeRequests in the main loop.
      if (r.status === 'pr_ready' || r.status === 'merge_requested' || r.status === 'merging')
        continue;
      if (r.status === 'awaiting_input') {
        // A question WITH a PR attached is a merge-flow question - the
        // merge sweep owns it. Build questions (no PR yet) resume here.
        const capture = await tb.capture(r.captureId).catch(() => null);
        const prUrl = (capture?.['executeRun'] as { prUrl?: string | null } | null)?.prUrl;
        if (prUrl) continue;
      }
      pool.schedule(r.repoFullName, r.captureId, () =>
        executeRun(conf, tb, r, { recover: true }),
      );
    }
  } catch (err) {
    console.error('recovery error:', err instanceof Error ? err.message : err);
  }

  // Stagger the poll loop's start across profiles (registration/recovery
  // above already happened immediately - only the recurring cadence needs
  // spreading out) so several profiles don't stampede the API in sync.
  if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));

  for (;;) {
    try {
      await sweepMergeRequests(conf, tb, pool);
      await checkOpenPRs(tb);
      // One session per repo, up to maxSessions across repos - oldest first.
      // A run that can't start this tick (repo busy / pool full) just stays
      // queued and is retried next poll.
      const { runs } = await tb.queue();
      for (const r of runs) {
        pool.schedule(r.repoFullName, r.captureId, () => executeRun(conf, tb, r));
      }
      if (runs.length === 0 && once) console.log('queue empty');
    } catch (err) {
      console.error('poll error:', err instanceof Error ? err.message : err);
    }
    if (once) {
      await sweepChats(conf, tb).catch(() => {});
      while (activeChats.size > 0) await new Promise((r) => setTimeout(r, 500));
      await pool.drain();
      break;
    }
    await new Promise((r) => setTimeout(r, conf.pollSeconds * 1000));
  }
}

/** A little jitter between each profile's poll-loop start, per profile. */
const PROFILE_STAGGER_MS = 3_000;

/**
 * Orchestrator: builds every configured profile, runs the startup preflight
 * across all of them (see src/preflight.ts), then drives the healthy ones
 * concurrently - one runProfile() per profile, same process.
 *
 * Exit codes:
 *   - git or gh missing/unauthenticated → exit 1 (nothing works without them).
 *   - at least one profile unhealthy but at least one healthy → serve the
 *     healthy ones, exit 0 eventually (or when they finish, for --once).
 *   - every profile unhealthy → exit 1.
 */
async function main(): Promise<void> {
  const profiles = loadConfig();
  const once = process.argv.includes('--once');

  const outcome = runPreflight(profiles);
  if (!outcome.gitOk || !outcome.ghOk) {
    console.error('git and gh are both required - fix the issue(s) above and re-run.');
    process.exit(1);
  }
  const healthyProfiles = profiles.filter((p) => outcome.healthyProfileIds.has(p.runnerId));
  if (healthyProfiles.length === 0) {
    console.error('No profile has a healthy, authenticated agent CLI - fix at least one and re-run.');
    process.exit(1);
  }
  if (healthyProfiles.length < profiles.length) {
    console.warn(
      `Continuing with ${healthyProfiles.length}/${profiles.length} healthy profile(s): ` +
        healthyProfiles.map((p) => p.runnerId).join(', '),
    );
  }

  await Promise.all(
    healthyProfiles.map((conf, i) => runProfile(conf, once, i * PROFILE_STAGGER_MS)),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
