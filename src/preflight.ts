/**
 * Startup preflight - fast, non-interactive checks that everything the
 * runner needs is on this machine and authenticated, printed as a
 * checklist with the EXACT remedy command for anything broken.
 *
 * Everything here is presence/status probing only (--version, --help,
 * `gh auth status`, `codex login status`, and similar) - it never spawns a
 * real agent turn, so it stays fast even with several profiles.
 *
 * Failure behavior (enforced by the caller in index.ts, not here):
 *   - git or gh missing/unauthenticated → nothing works, exit nonzero.
 *   - a profile's agent CLI missing/unauthenticated → skip that profile
 *     with a loud warning, keep serving the healthy ones; exit nonzero
 *     only when NO profile is healthy.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './index.js';

const PROBE_TIMEOUT_MS = 8_000;

interface CheckResult {
  ok: boolean;
  /** One-line human summary shown next to the ✔/✖ icon. */
  detail: string;
  /** Non-blocking notes (e.g. an unset env var) - shown even when ok. */
  warnings?: string[];
  /** Exact commands to fix the problem - shown only when !ok. */
  remedy?: string[];
}

export interface PreflightOutcome {
  gitOk: boolean;
  ghOk: boolean;
  /** Profile ids whose agent CLI is present and authenticated. */
  healthyProfileIds: Set<string>;
}

/** Runs [cmd args...] and captures the outcome without ever throwing -
 *  a missing binary (ENOENT) or nonzero exit both come back as !ok. */
function tryRun(
  cmd: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : (e.message ?? String(err)),
    };
  }
}

/**
 * Pulls the actual command NAMES out of a CLI's --help output, scoped to its
 * "Commands:" (or "Available Commands:" / "Subcommands:") section so we
 * never mistake a word inside a flag description (e.g. "git status" showing
 * up in some unrelated help text) for a real subcommand. Matches entries
 * indented exactly one level (commander.js/yargs-style listings); deeper
 * indentation is a wrapped description line, not a new entry. Handles
 * "plugin|plugins" alias syntax.
 */
function extractCommandSectionNames(helpText: string): string[] {
  const headerMatch = /^(?:available\s+)?(?:sub)?commands:\s*$/im.exec(helpText);
  if (!headerMatch) return [];
  const section = helpText.slice(headerMatch.index + headerMatch[0].length);
  const names: string[] = [];
  for (const line of section.split('\n')) {
    if (/^\S/.test(line)) break; // dedented past the Commands: block - section over
    const m = /^ {1,4}(?! )([a-z][\w.|-]*)/i.exec(line);
    if (!m) continue;
    for (const alias of m[1]!.split('|')) names.push(alias.toLowerCase());
  }
  return names;
}

/**
 * Some agent CLIs expose a cheap, read-only "am I logged in?" subcommand;
 * others don't. This looks for a read-only leaf command (status / whoami) at
 * the top level, or nested one level under an "auth" command group (e.g.
 * `claude auth status`), and if found, actually runs it. Never runs
 * anything named login/logout - those can be interactive or mutate state.
 * Returns null when nothing matches, so the caller falls back to a
 * presence-only note or a file-based heuristic.
 */
const READONLY_LEAF_NAMES = ['status', 'whoami'];
const AUTH_GROUP_NAMES = ['auth'];

function runProbe(bin: string, args: string[]): CheckResult {
  const r = tryRun(bin, args, 5_000);
  return {
    ok: r.ok,
    detail: r.ok
      ? `${bin} ${args.join(' ')}: ok`
      : `${bin} ${args.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 150) || 'failed'}`,
  };
}

function probeAuthSubcommand(bin: string, helpText: string): CheckResult | null {
  if (!helpText.trim()) return null;
  const topLevel = extractCommandSectionNames(helpText);

  for (const leaf of READONLY_LEAF_NAMES) {
    if (topLevel.includes(leaf)) return runProbe(bin, [leaf]);
  }

  for (const group of AUTH_GROUP_NAMES) {
    if (!topLevel.includes(group)) continue;
    const nestedHelp = tryRun(bin, [group, '--help'], 5_000);
    if (!nestedHelp.ok) continue;
    const nested = extractCommandSectionNames(nestedHelp.stdout);
    for (const leaf of READONLY_LEAF_NAMES) {
      if (nested.includes(leaf)) return runProbe(bin, [group, leaf]);
    }
  }
  return null;
}

// ── git / gh ─────────────────────────────────────────────────────────────

function checkGit(): CheckResult {
  const r = tryRun('git', ['--version']);
  if (!r.ok) {
    return {
      ok: false,
      detail: 'not found on PATH',
      remedy: ['Install: brew install git   (macOS)   |   https://git-scm.com/downloads (other platforms)'],
    };
  }
  return { ok: true, detail: r.stdout.trim() };
}

function checkGh(): CheckResult {
  const bin = tryRun('gh', ['--version']);
  if (!bin.ok) {
    return {
      ok: false,
      detail: 'not found on PATH',
      remedy: ['Install: brew install gh   (macOS)   |   https://cli.github.com (other platforms)'],
    };
  }
  const auth = tryRun('gh', ['auth', 'status']);
  if (!auth.ok) {
    return {
      ok: false,
      detail: `${bin.stdout.split('\n')[0]?.trim() ?? 'installed'} - not authenticated`,
      remedy: ['Run: gh auth login'],
    };
  }
  return { ok: true, detail: `${bin.stdout.split('\n')[0]?.trim() ?? 'installed'} - authenticated` };
}

// ── agent CLIs ───────────────────────────────────────────────────────────

function checkClaude(): CheckResult {
  const ver = tryRun('claude', ['--version']);
  if (!ver.ok) {
    return {
      ok: false,
      detail: 'claude CLI not found on PATH',
      remedy: [
        'Install: npm install -g @anthropic-ai/claude-code',
        'Then run `claude` once in any directory and follow the login prompt.',
      ],
    };
  }
  const help = tryRun('claude', ['--help']);
  const probed = probeAuthSubcommand('claude', help.ok ? help.stdout : '');
  if (probed) {
    if (probed.ok) return { ok: true, detail: `${ver.stdout.trim()} - ${probed.detail}` };
    return {
      ok: false,
      detail: `installed but not authenticated (${probed.detail})`,
      remedy: ['Run `claude` once in any directory and follow the login prompt.'],
    };
  }
  return {
    ok: true,
    detail: `${ver.stdout.trim()} - present (no auth-status subcommand found; auth is verified on first run)`,
  };
}

function checkCodex(): CheckResult {
  const ver = tryRun('codex', ['--version']);
  if (!ver.ok) {
    return {
      ok: false,
      detail: 'codex CLI not found on PATH',
      remedy: [
        'Install: npm install -g @openai/codex   (see https://github.com/openai/codex for the latest instructions)',
        'Then run: codex login',
      ],
    };
  }
  const status = tryRun('codex', ['login', 'status']);
  if (!status.ok) {
    return {
      ok: false,
      detail: 'installed but not authenticated',
      remedy: ['Run: codex login'],
    };
  }
  return { ok: true, detail: `${ver.stdout.trim()} - authenticated` };
}

function checkGemini(): CheckResult {
  const ver = tryRun('gemini', ['--version']);
  if (!ver.ok) {
    return {
      ok: false,
      detail: 'gemini CLI not found on PATH',
      remedy: [
        'Install: npm install -g @google/gemini-cli   (see https://github.com/google-gemini/gemini-cli for the latest instructions)',
        'Then run `gemini` once and follow the first-run login prompt.',
      ],
    };
  }
  const warnings: string[] = [];
  if (!process.env['GOOGLE_CLOUD_PROJECT']) {
    warnings.push(
      'GOOGLE_CLOUD_PROJECT is not set - required for API access on accounts that need one. Set it: export GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>',
    );
  }
  const help = tryRun('gemini', ['--help']);
  const probed = probeAuthSubcommand('gemini', help.ok ? help.stdout : '');
  if (probed) {
    if (probed.ok) return { ok: true, detail: `${ver.stdout.trim()} - ${probed.detail}`, warnings };
    return {
      ok: false,
      detail: `installed but not authenticated (${probed.detail})`,
      remedy: ['Run `gemini` once and follow the first-run login prompt.'],
      warnings,
    };
  }
  // No cheap auth-status subcommand exists on this version - fall back to
  // the known oauth credentials file the CLI writes on successful login.
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  if (existsSync(credsPath)) {
    return {
      ok: true,
      detail: `${ver.stdout.trim()} - present, oauth credentials found (no auth-status subcommand to verify further)`,
      warnings,
    };
  }
  return {
    ok: false,
    detail: 'installed but no auth-status subcommand and no oauth credentials file found',
    remedy: ['Run `gemini` once and follow the first-run login prompt.'],
    warnings,
  };
}

function checkAgent(name: string): CheckResult {
  switch (name) {
    case 'codex':
      return checkCodex();
    case 'gemini':
      return checkGemini();
    default:
      return checkClaude();
  }
}

// ── printing ─────────────────────────────────────────────────────────────

function printRow(label: string, r: CheckResult): void {
  const icon = r.ok ? '✔' : '✖';
  console.log(`  ${icon} ${label.padEnd(16)} ${r.detail}`);
  for (const w of r.warnings ?? []) console.log(`      ⚠ ${w}`);
  if (!r.ok) {
    for (const line of r.remedy ?? []) console.log(`      → ${line}`);
  }
}

/**
 * Runs every check and prints the checklist. Agent CLIs are checked once
 * PER DISTINCT NAME across all profiles (auth is a machine-level property,
 * not a per-profile one) and the result is fanned back out to every profile
 * using that agent.
 */
export function runPreflight(profiles: Config[]): PreflightOutcome {
  console.log('');
  console.log('Preflight checks');
  console.log('─'.repeat(64));

  const git = checkGit();
  printRow('git', git);

  const gh = checkGh();
  printRow('gh', gh);

  const agentResults = new Map<string, CheckResult>();
  for (const p of profiles) {
    if (!agentResults.has(p.agent.name)) {
      agentResults.set(p.agent.name, checkAgent(p.agent.name));
    }
  }
  for (const [name, result] of agentResults) {
    printRow(`agent:${name}`, result);
  }

  const healthyProfileIds = new Set<string>();
  for (const p of profiles) {
    const result = agentResults.get(p.agent.name)!;
    if (result.ok) {
      healthyProfileIds.add(p.runnerId);
    } else {
      console.warn(
        `  ⚠ profile "${p.runnerId}" SKIPPED - its agent CLI (${p.agent.name}) is not ready (see above)`,
      );
    }
  }

  console.log('─'.repeat(64));
  console.log('');

  return { gitOk: git.ok, ghOk: gh.ok, healthyProfileIds };
}
