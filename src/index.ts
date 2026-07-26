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
 *   TB_RUNNER_ID      — stable id for this runner (default: runner-<hostname>)
 *   TB_WORKDIR        — where repos are cloned (default ~/.thoughtbridge-runner/work)
 *   TB_AGENT_COMMAND  — optional skill/slash-command prefix (e.g. "/bee-feature").
 *                       Absent → plain prompt (the default for everyone).
 *   TB_POLL_SECONDS   — queue poll interval (default 60)
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
  pollSeconds: number;
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
    pollSeconds: Number(get('TB_POLL_SECONDS') ?? 60),
  };
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

  queue(): Promise<{ runs: QueuedRun[] }> {
    return this.call('GET', '/runner/queue');
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

function ensureCheckout(workdir: string, repoFullName: string): string {
  const dir = join(workdir, repoFullName.replace('/', '__'));
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
): Promise<SessionResult> {
  // Autonomous by definition: the session runs headless in the runner's own
  // checkout, so nobody is present to approve tool calls. Without this flag
  // every Edit/Write/git command is denied and the run stalls.
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];
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

async function executeRun(conf: Config, tb: TB, run: QueuedRun): Promise<void> {
  const cid = run.captureId;
  console.log(`▶ ${cid} — "${run.title ?? 'untitled'}" → ${run.repoFullName}`);
  if (!run.repoFullName) {
    await tb.report(cid, { status: 'failed', error: 'No repoFullName on queue entry' });
    return;
  }

  await tb.claim(cid);
  const branch = `thought/${cid.slice(0, 8)}`;

  try {
    const dir = ensureCheckout(conf.workdir, run.repoFullName);
    sh(dir, 'git', ['checkout', '-B', branch]);

    const capture = await tb.capture(cid);
    const markdown =
      (capture['renderedMarkdown'] as string | undefined) ??
      (capture['transcript'] as string | undefined) ??
      '(no transcript available)';

    let sessionId: string | null = null;
    let prompt = buildPrompt(conf, run, markdown, branch);

    // Session loop: run → maybe QUESTION → wait for answer → resume.
    for (;;) {
      await tb.report(cid, {
        status: 'building',
        ...(sessionId ? {} : { branch }),
        ...(sessionId ? { sessionId } : {}),
      });
      const result = await runClaude(dir, prompt, sessionId);
      sessionId = result.sessionId;
      await tb.report(cid, { status: 'building', sessionId, branch });

      const q = QUESTION_RE.exec(result.text);
      if (!q) break;

      console.log(`  ? ${q[1]}`);
      await tb.report(cid, { status: 'awaiting_input', question: q[1]!, sessionId });
      const answer = await waitForAnswer(tb, cid);
      if (answer === null) {
        console.log('  run cancelled while awaiting input');
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
      await tb.report(cid, {
        status: 'done',
        sessionId,
        error: 'Session produced no commits — nothing to open a PR for',
      });
      console.log('  no commits — reported done (empty)');
      return;
    }

    sh(dir, 'git', ['push', '-u', 'origin', branch, '--force-with-lease']);
    const prUrl = sh(dir, 'gh', [
      'pr', 'create',
      '--head', branch,
      '--title', `Thought: ${run.title ?? cid}`,
      '--body',
      `Built from a ThoughtBridge "bridge it" capture.\n\nCaptureId: ${cid}\nSession: \`claude --resume ${sessionId}\` on \`${hostname()}\`\n\n${run.executeInstruction ?? ''}`,
    ]).trim();

    await tb.report(cid, { status: 'pr_ready', prUrl, sessionId, branch });
    console.log(`  ✔ PR ready: ${prUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ✖ failed: ${message}`);
    try {
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

// ── main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const conf = loadConfig();
  mkdirSync(conf.workdir, { recursive: true });
  const tb = new TB(conf);
  const once = process.argv.includes('--once');

  console.log(
    `thoughtbridge-runner ${conf.runnerId} on ${hostname()}` +
      (conf.agentCommand ? ` (agent command: ${conf.agentCommand})` : ' (plain prompt)'),
  );

  for (;;) {
    try {
      const { runs } = await tb.queue();
      if (runs.length > 0) {
        // One at a time, oldest first — a run can take a while.
        await executeRun(conf, tb, runs[0]!);
      } else if (once) {
        console.log('queue empty');
      }
    } catch (err) {
      console.error('poll error:', err instanceof Error ? err.message : err);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, conf.pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
