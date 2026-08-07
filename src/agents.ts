/**
 * Agent adapters - the runner drives ONE coding-agent CLI per session
 * (claude, codex, or gemini), all shelled out to headlessly in a repo
 * checkout. Everything else in index.ts is agent-neutral; this module is
 * the only place that knows each CLI's flags and JSON shapes.
 *
 * Picked via TB_AGENT ('claude' | 'codex' | 'gemini', default 'claude') -
 * see pickAdapter() and the header comment in index.ts.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** All three CLIs get the same generous ceiling - these are autonomous,
 *  unattended builds with no one present to notice a hang sooner. */
const AGENT_TIMEOUT_MS = 45 * 60_000;

export interface SessionResult {
  sessionId: string;
  text: string;
}

export interface AgentAdapter {
  name: string;
  /** True when this CLI can resume a prior session by id (claude, codex).
   *  False when it can't (gemini's --resume only takes "latest" or a
   *  per-directory index, not a stable id) - callers fall back to
   *  replaying the conversation from local history instead. See
   *  index.ts's spawnTurn(). */
  canResume: boolean;
  spawn(
    cwd: string,
    prompt: string,
    resumeSessionId: string | null,
    model: string | null,
  ): Promise<SessionResult>;
  /** A human-runnable command to drop into this session interactively,
   *  used in PR footers and error messages. */
  resumeCommand(dir: string, sessionId: string): string;
}

/**
 * Runs a CLI to completion, optionally feeding it stdin, and collects
 * stdout/stderr. Kills the child on timeout. Unlike execFile, this gives us
 * a real stdin pipe to write a prompt into (codex reads its prompt from
 * stdin when none is given as an argument).
 */
function execWithTimeout(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`));
      }
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ── claude ───────────────────────────────────────────────────────────────

const claudeAdapter: AgentAdapter = {
  name: 'claude',
  canResume: true,
  async spawn(cwd, prompt, resumeSessionId, model) {
    // Autonomous by definition: the session runs headless in the runner's
    // own checkout, so nobody is present to approve tool calls. Without
    // this flag every Edit/Write/git command is denied and the run stalls.
    const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (resumeSessionId) args.unshift('--resume', resumeSessionId);
    const { stdout } = await execWithTimeout(cwd, 'claude', args, AGENT_TIMEOUT_MS);
    const parsed = JSON.parse(stdout) as { session_id?: string; result?: string };
    return {
      sessionId: parsed.session_id ?? resumeSessionId ?? '',
      text: parsed.result ?? '',
    };
  },
  resumeCommand(dir, sessionId) {
    return `cd ${dir} && claude --resume ${sessionId}`;
  },
};

// ── codex ────────────────────────────────────────────────────────────────

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
}

/** Newest-first scan for the field we need out of codex's `--json` JSONL
 *  event stream, since some events repeat the thread id and some don't. */
function parseCodexEvents(stdout: string): { threadId: string | null; lastAgentMessage: string | null } {
  let threadId: string | null = null;
  let lastAgentMessage: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue; // stray non-JSON line - ignore
    }
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      lastAgentMessage = event.item.text;
    }
  }
  return { threadId, lastAgentMessage };
}

const codexAdapter: AgentAdapter = {
  name: 'codex',
  canResume: true,
  async spawn(cwd, prompt, resumeSessionId, model) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tb-codex-'));
    const outputFile = join(tmpDir, 'last-message.txt');
    try {
      const args = resumeSessionId ? ['exec', 'resume', resumeSessionId] : ['exec'];
      args.push(
        '--json',
        '--output-last-message',
        outputFile,
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
      );
      if (model) args.push('-m', model);
      // Prompt is deliberately NOT passed as a positional argument - both
      // `codex exec` and `codex exec resume` read it from stdin when none
      // is given, verified against codex-cli 0.144.4.
      const { stdout } = await execWithTimeout(cwd, 'codex', args, AGENT_TIMEOUT_MS, prompt);
      const { threadId, lastAgentMessage } = parseCodexEvents(stdout);
      let text = '';
      try {
        text = readFileSync(outputFile, 'utf8').trim();
      } catch {
        text = lastAgentMessage ?? '';
      }
      return {
        sessionId: threadId ?? resumeSessionId ?? '',
        text,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  resumeCommand(dir, sessionId) {
    return `cd ${dir} && codex resume ${sessionId}`;
  },
};

// ── gemini ───────────────────────────────────────────────────────────────

const geminiAdapter: AgentAdapter = {
  name: 'gemini',
  canResume: false, // --resume only takes "latest" or a per-directory index
  async spawn(cwd, prompt, _resumeSessionId, model) {
    const args = ['--output-format', 'json', '--approval-mode', 'yolo'];
    if (model) args.push('-m', model);
    args.push(prompt);
    const { stdout } = await execWithTimeout(cwd, 'gemini', args, AGENT_TIMEOUT_MS);
    const parsed = JSON.parse(stdout) as {
      response?: string;
      error?: { type?: string; message?: string; code?: number };
    };
    if (parsed.error) {
      throw new Error(
        `gemini error ${parsed.error.code ?? ''}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
      );
    }
    return { sessionId: '', text: parsed.response ?? '' };
  },
  resumeCommand(dir) {
    return `cd ${dir} && gemini --resume latest`;
  },
};

// ── selection ────────────────────────────────────────────────────────────

export function pickAdapter(name: string | undefined): AgentAdapter {
  switch (name) {
    case 'codex':
      return codexAdapter;
    case 'gemini':
      return geminiAdapter;
    default:
      return claudeAdapter;
  }
}
