#!/usr/bin/env tsx
/**
 * thoughtbridge-runner — the self-hosted bridge-it runner.
 *
 * Polls your ThoughtBridge account for thoughts you ended with "bridge it",
 * checks out the project's GitHub repo, drives a Claude Code session to build
 * the thought on a branch, and opens a PR. Questions from the agent pause the
 * run and surface in the ThoughtBridge app; your answer resumes the session.
 *
 * Requirements on this machine: git, gh (authenticated), claude (Claude Code).
 *
 * Config (env or ~/.thoughtbridge-runner.json):
 *   TB_API_URL        — default https://thoughtbridge-api-238666896847.australia-southeast1.run.app/v1
 *   TB_API_KEY        — a `runner`-scoped ThoughtBridge API key (required)
 *   TB_RUNNER_ID      — stable id for this runner (default: runner-<hostname>).
 *                       Registered in your account's runner registry at startup;
 *                       the app lists instances and can pin a project's
 *                       bridge-it work to one of them.
 *   TB_WORKDIR        — where repos are cloned (default ~/.thoughtbridge-runner/work)
 *   TB_AGENT_COMMAND  — optional skill/slash-command prefix (e.g. "/bee-feature").
 *                       Absent → plain prompt (the default for everyone).
 *   TB_MODEL          — model for every Claude session the runner drives.
 *                       An alias ("sonnet", "opus", "fable", "haiku") or a full
 *                       model name ("claude-sonnet-5"), passed to claude as
 *                       --model. Absent → the claude CLI's own default (whatever
 *                       this machine's Claude Code config selects).
 *   TB_POLL_SECONDS   — queue poll interval (default 60)
 *   TB_MAX_SESSIONS   — max concurrent Claude sessions (default 3; always
 *                       at most ONE session per repo checkout)
 *
 * The Claude Code SESSION stays on this machine; the run record in
 * ThoughtBridge carries (machine, sessionId) so `claude --resume <sessionId>`
 * here drops you into the live conversation.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// ── config ──────────────────────────────────────────────────────────────────

interface Config {
  apiUrl: string;
  apiKey: string;
  runnerId: string;
  workdir: string;
  agentCommand: string | null;
  /** Model passed to claude as --model; null → the CLI's configured default. */
  model: string | null;
  pollSeconds: number;
  /** Max concurrent Claude sessions (builds + merges) across all repos. */
  maxSessions: number;
}

function loadConfig(): Config {
  let fileConf: Record<string, string> = {};
  const confPath = join(homedir(), '.thoughtbridge-runner.json');
  if (existsSync(confPath)) {
    try {
      fileConf = JSON.parse(readFileSync(confPath, 'utf8')) as Record<string, string>;
    } catch {
      console.error(`warning: could not parse ${confPath} — ignoring`);
    }
  }
  const get = (key: string): string | undefined => process.env[key] ?? fileConf[key];

  const apiKey = get('TB_API_KEY');
  if (!apiKey) {
    console.error('TB_API_KEY is required (a runner-scoped ThoughtBridge API key).');
    process.exit(1);
  }
  return {
    apiUrl:
      get('TB_API_URL') ??
      'https://thoughtbridge-api-238666896847.australia-southeast1.run.app/v1',
    apiKey,
    runnerId: get('TB_RUNNER_ID') ?? `runner-${hostname()}`,
    workdir: get('TB_WORKDIR') ?? join(homedir(), '.thoughtbridge-runner', 'work'),
    agentCommand: get('TB_AGENT_COMMAND') ?? null,
    model: get('TB_MODEL') ?? null,
    pollSeconds: Number(get('TB_POLL_SECONDS') ?? 60),
    maxSessions: Math.max(1, Number(get('TB_MAX_SESSIONS') ?? 3)),
  };
}

// ── session pool ────────────────────────────────────────────────────────────

/**
 * One Bridget session per repo, a few across the whole runner. The unit of
 * mutual exclusion is the repo CHECKOUT (two sessions in one working tree
 * would fight over branches), which yields one-session-per-project whenever
 * projects live in their own repos — and safely serializes projects that
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
   * registry so the app can list it and pin projects to it. Best-effort —
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
  /** In-flight runs claimed by THIS runner — restart recovery. */
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

// ── git / claude helpers ────────────────────────────────────────────────────

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function shAsync(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
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

interface SessionResult {
  sessionId: string;
  text: string;
}

async function runClaude(
  cwd: string,
  prompt: string,
  resumeSessionId: string | null,
  model: string | null,
): Promise<SessionResult> {
  // Autonomous by definition: the session runs headless in the runner's own
  // checkout, so nobody is present to approve tool calls. Without this flag
  // every Edit/Write/git command is denied and the run stalls.
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];
  if (model) args.push('--model', model);
  if (resumeSessionId) args.unshift('--resume', resumeSessionId);
  const { stdout } = await shAsync(cwd, 'claude', args, 45 * 60_000);
  const parsed = JSON.parse(stdout) as { session_id?: string; result?: string };
  return {
    sessionId: parsed.session_id ?? resumeSessionId ?? '',
    text: parsed.result ?? '',
  };
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
- You are on branch ${branch} — stay on it. NEVER commit to the default branch.
- This repo's own agent files (AGENTS.md, .thoughtbridge/THOUGHTBRIDGE.md) describe its layout and conventions — read them first and follow them.
- Implement the work order completely: code, tests if the repo has a test setup, and a short summary of what you did as your final message.
- Commit your work with clear messages (no AI attribution trailers).
- If you hit a decision only the user can make, output a single line starting with "QUESTION: " stating the question, then stop. You will be resumed with the answer.`;
}

/**
 * The agent's final summary IS the PR description (the destination's
 * AGENTS.md contract makes sessions end with a PR-ready what-was-built /
 * tested / after-merge write-up); the fixed capture/session lines become a
 * short footer. Falls back to the work order when a session somehow ends
 * with no text. GitHub caps bodies at 65536 chars — truncate the summary,
 * never the footer.
 */
function buildPrBody(
  summary: string,
  cid: string,
  sessionId: string | null,
  executeInstruction: string | null,
): string {
  const footer = [
    '---',
    'Built from a ThoughtBridge "bridge it" capture.',
    '',
    `CaptureId: ${cid}`,
    `Session: \`claude --resume ${sessionId}\` on \`${hostname()}\``,
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
      throw new Error('Checkout missing after restart — cancel and re-bridge this thought');
    }
    sh(dir, 'git', ['checkout', recover ? branch : '-B', ...(recover ? [] : [branch])]);

    const capture = await tb.capture(cid);
    const markdown =
      (capture['renderedMarkdown'] as string | undefined) ??
      (capture['transcript'] as string | undefined) ??
      '(no transcript available)';

    let sessionId: string | null = recover ? run.sessionId : null;
    let prompt = recover && sessionId
      ? 'The runner restarted. Continue the work order from where you left off — if it is already complete, summarise what was done. Same rules apply.'
      : buildPrompt(conf, run, markdown, branch);
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
    // The final iteration's text is the agent's summary — it becomes the PR body.
    let finalSummary = '';
    for (;;) {
      await tb.report(cid, {
        status: 'building',
        ...(sessionId ? {} : { branch }),
        ...(sessionId ? { sessionId } : {}),
      });
      const result = await runClaude(dir, prompt, sessionId, conf.model);
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
        return; // cancelled — nothing more to do
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
          `${tag} ✔ no root commits — sibling PR ready: ${head}` +
            (rest.length > 0 ? ` (+${rest.length} more)` : ''),
        );
        return;
      }
      await tb.report(cid, {
        status: 'done',
        sessionId,
        error: 'Session produced no commits — nothing to open a PR for',
      });
      console.log(`${tag} no commits — reported done (empty)`);
      return;
    }

    sh(dir, 'git', ['push', '-u', 'origin', branch, '--force-with-lease']);
    const prUrl = sh(dir, 'gh', [
      'pr', 'create',
      '--head', branch,
      '--title', `Thought: ${run.title ?? cid}`,
      '--body',
      buildPrBody(finalSummary, cid, sessionId, run.executeInstruction),
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
      // Never mark a run failed when its PR actually merged — a late error
      // (e.g. pushing a branch GitHub deleted on merge) is success noise.
      const capture = await tb.capture(cid).catch(() => null);
      const prUrl = (capture?.['executeRun'] as { prUrl?: string | null } | null)?.prUrl;
      if (prUrl) {
        const state = sh(process.cwd(), 'gh', [
          'pr', 'view', prUrl, '--json', 'state', '--jq', '.state',
        ]).trim();
        if (state === 'MERGED') {
          console.log(`${tag} PR is merged — reporting done despite the late error`);
          await tb.report(cid, { status: 'done' });
          return;
        }
      }
      await tb.report(cid, { status: 'failed', error: message.slice(0, 500) });
    } catch {
      /* run may have been cancelled — nothing to report onto */
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
    // (the merge prompt is idempotent — an already-merged PR just verifies).
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
    if (r.status === 'awaiting_input' && !prUrl) continue; // build question — recovery owns it
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
 * final summary lists them — see thoughtbridge-root AGENTS.md). Prefers a
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
 * The "## After merge" section of the session summary — the manual steps the
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
  console.log(`${tag} ⇥ merging — ${prUrl}`);
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
        /* body unreadable — merge what we already know about */
      }
      if (siblingPrUrls.length > 0) {
        console.log(`${tag} + ${siblingPrUrls.length} sibling PR(s) to merge`);
        // Backfill the run record for runs reported before siblings existed.
        await tb.report(cid, { siblingPrUrls }).catch(() => {});
      }
      const siblingSection = siblingPrUrls.length > 0
        ? `\n\nThis thought also has sibling PRs in other repos — merge EVERY one of these the same way (update from its default branch, resolve conflicts by the same rules, \`gh pr merge --merge --delete-branch\`):\n${siblingPrUrls.map((u) => `- ${u}`).join('\n')}\n`
        : '';
      const prompt = `The user approved this thought's work — merge its pull request(s) into their default branches now.

Root PR: ${prUrl}
Branch: ${branch}
${siblingSection}
Steps for the root PR:
1. Read the PR with \`gh pr view ${prUrl}\`.
2. \`git fetch origin\`, check out ${branch}, and merge origin's default branch into it.
3. Resolve any conflicts:
   - Agent/instruction files (AGENTS.md, CLAUDE.md, tasks/*.md): union both sides — keep everyone's entries.
   - thoughts-state.json: reconcile PER ENTRY — for each thought id keep the side with the newest updatedAt; never drop entries that exist on only one side.
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
        // Question already posted before the restart — just wait for the answer.
        const answer = await waitForAnswer(tb, cid);
        if (answer === null) return;
        nextPrompt = `The user answered: ${answer}\n\nContinue the merge. Same rules apply.`;
      } else {
        nextPrompt = prompt;
      }
      await tb.report(cid, { status: 'merging', ...(sessionId ? { sessionId } : {}) });
      let result: SessionResult;
      for (;;) {
        result = await runClaude(dir, nextPrompt, sessionId, conf.model);
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
      // Done means ALL merged — the root PR and every sibling PR.
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
        console.log(`${tag} ✖ merge incomplete — still open: ${unmerged.join(', ')}`);
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
 * outcome — done on merge, failed when the PR was closed unmerged. The
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
            `  root PR merged but sibling PR(s) still open (${openSiblings.join(', ')}) — waiting`,
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
    return `The user says:\n\n${unanswered}\n\nReply as Bridget — concise, concrete, honest. Investigate in this checkout (git, gh) when the question needs it. Actions the repo's AGENTS.md sanctions for chat sessions may be EXECUTED when the user asks; verify outcomes with real commands and state plainly what you did versus did not do — never describe unexecuted steps as done.`;
  }
  const history = chat.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Bridget'}: ${m.text}`)
    .join('\n');
  return `You are Bridget, the ThoughtBridge agent for the project "${chat.projectName}". The user is chatting with you about this project from the ThoughtBridge app.

Your working copy of the project's repo (${chat.repoFullName}) is at ${dir} — a chat-only checkout on the default branch. You may read anything (files, git history, \`gh\` for PRs/issues/CI) to answer properly. The project's captured thoughts live under ${chat.projectSlug}/thoughtbridge/ if present.

RULES
- FIRST read the repo's AGENTS.md and any .claude/skills/ — they define what a chat session may do here, including any actions explicitly SANCTIONED for chats (e.g. a release ritual). Follow them.
- Default is read-only: do not commit, push, or modify the repo EXCEPT actions the repo's AGENTS.md explicitly sanctions for chat sessions and the user explicitly asked for. For anything else that needs work, say what you'd do and suggest the user capture a thought and "bridge it".
- BE HONEST ABOUT WHAT HAPPENED. Your reply must state plainly what you actually EXECUTED versus what you did NOT do. When you perform a sanctioned action, VERIFY the outcome with real commands (e.g. the tag exists on origin, the CI run started, the artifact uploaded) and report each result. If you couldn't or didn't do something, open your reply with that — never describe unexecuted steps in a way that reads as done.
- Reply concise, concrete, honest. Plain text (light markdown fine). Your ENTIRE output is the chat reply.

CONVERSATION SO FAR
${history}

Reply to the user's latest message(s).`;
}

async function answerChat(conf: Config, tb: TB, chat: PendingChat): Promise<void> {
  const tag = `[chat:${chat.projectSlug}]`;
  console.log(`${tag} ${chat.pendingCount} message(s) — answering…`);
  try {
    const dir = ensureCheckout(conf.workdir, chat.repoFullName, '__chat');
    let result: SessionResult;
    try {
      result = await runClaude(dir, chatPrompt(chat, dir), chat.sessionId, conf.model);
    } catch (err) {
      if (!chat.sessionId) throw err;
      // Sessions are per-directory: a repo/destination change strands the
      // stored id. Start fresh with the full preamble + history instead.
      console.log(`${tag} stored session unusable — starting fresh`);
      const fresh: PendingChat = { ...chat, sessionId: null };
      result = await runClaude(dir, chatPrompt(fresh, dir), null, conf.model);
    }
    const text = result.text.trim() || '(Bridget had nothing to say — try rephrasing.)';
    await tb.chatReply(chat.projectId, text, result.sessionId || null, chat.pendingCount);
    console.log(`${tag} ✔ replied (${text.length} chars)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} ✖ ${message}`);
    // Best-effort error reply so the user isn't left waiting on silence.
    try {
      await tb.chatReply(
        chat.projectId,
        `Bridget hit an error answering this: ${message.slice(0, 300)} — send your message again to retry.`,
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

async function main(): Promise<void> {
  const conf = loadConfig();
  mkdirSync(conf.workdir, { recursive: true });
  const tb = new TB(conf);
  const once = process.argv.includes('--once');

  console.log(
    `thoughtbridge-runner ${conf.runnerId} on ${hostname()}` +
      (conf.agentCommand ? ` (agent command: ${conf.agentCommand})` : ' (plain prompt)') +
      ` (model: ${conf.model ?? 'claude default'})`,
  );

  // Announce this instance to the account's runner registry (multi-instance:
  // the app lists registered runners and can pin a project to one).
  await tb.register();

  const pool = new SessionPool(conf.maxSessions);

  // Chat lane: its own faster poll (10s) so conversations feel responsive —
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
      // pr_ready runs are DONE building — the merge-watcher owns them from
      // here. Re-executing one re-pushes a branch that may already be merged
      // and deleted, clobbering a successful run with 'failed'. Likewise
      // merge_requested/merging belong to sweepMergeRequests in the main loop.
      if (r.status === 'pr_ready' || r.status === 'merge_requested' || r.status === 'merging')
        continue;
      if (r.status === 'awaiting_input') {
        // A question WITH a PR attached is a merge-flow question — the
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

  for (;;) {
    try {
      await sweepMergeRequests(conf, tb, pool);
      await checkOpenPRs(tb);
      // One session per repo, up to maxSessions across repos — oldest first.
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
