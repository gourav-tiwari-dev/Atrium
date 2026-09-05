import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cliCommand } from './launch.ts';

/**
 * Which conversation the room talks to for one person.
 *
 * `claude -p --continue` means "the newest conversation in this folder", which
 * drifts: the room's exchange can land in a conversation the person will never
 * open again. Pinning an id is what makes it THEIR session instead of a
 * lookalike, and what lets `claude --resume <id>` afterwards carry the whole
 * room back into their terminal.
 *
 * Scoped by room and name, and kept in the home folder, for the same reason
 * offsets are: a teammate may run the bridge from anywhere.
 */

export interface Pin {
  agent: 'claude' | 'codex';
  sessionId: string;
  cwd: string;
  pinnedAt: number;
}

export interface PinStore {
  get(): Pin | undefined;
  set(pin: Pin): void;
  clear(): void;
}

type Saved = Record<string, Pin>;

function storePath(dir?: string): string {
  return join(dir ?? join(homedir(), '.atrium'), 'session.json');
}

export function openPin(room: string, name: string, storeDir?: string): PinStore {
  const path = storePath(storeDir);
  const scope = `${room}::${name}`;

  // Re-read on every access rather than caching. Two bridges for two rooms can
  // share this file, and a stale in-memory copy would silently drop one of them
  // the next time either wrote.
  function readAll(): Saved {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Saved;
    } catch {
      return {}; // first run, or the file was removed: start clean
    }
  }

  function writeAll(all: Saved): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(all, null, 2));
    } catch {
      // Losing the pin costs one repin, not data. Never take the bridge down.
    }
  }

  return {
    get() {
      return readAll()[scope];
    },
    set(pin) {
      const all = readAll();
      all[scope] = pin;
      writeAll(all);
    },
    clear() {
      const all = readAll();
      delete all[scope];
      writeAll(all);
    },
  };
}

/** One live Claude Code session as the CLI reports it. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string;
  status: string;
  name: string;
}

/**
 * Every live session on this machine, straight from the CLI.
 *
 * `claude agents --json` lists interactive sessions as well as background ones,
 * with pid, cwd, session id and status. That is far more reliable than guessing
 * liveness from a transcript's mtime, which is all discover.ts can do.
 *
 * Returns [] when the CLI is missing or the shape is unexpected: a bridge that
 * cannot ask is not a bridge that should crash.
 */
export function liveClaudeSessions(): LiveSession[] {
  let raw: string;
  try {
    const { cmd, prefix } = cliCommand('claude');
    raw = execFileSync(cmd, [...prefix, 'agents', '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
      // no shell - see launch.ts. These args are literals, but a shell here
      // would still emit Node's DEP0190 on every liveness check.
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        pid: Number(r.pid ?? 0),
        sessionId: String(r.sessionId ?? ''),
        cwd: String(r.cwd ?? ''),
        kind: String(r.kind ?? ''),
        // background sessions report `state`, interactive ones report `status`
        status: String(r.status ?? r.state ?? ''),
        name: String(r.name ?? ''),
      }))
      .filter((s) => s.sessionId !== '');
  } catch {
    return [];
  }
}

/**
 * 'busy'  the person is mid-turn in that session - queue behind them
 * 'idle'  running but waiting - safe to resume
 * 'gone'  no live process - safe to resume
 *
 * Claude accepts a concurrent `-p --resume` into a live interactive session and
 * appends to the same file, but the running process never sees those appends
 * and the transcript branches. Verified 2026-09-05. So 'busy' means wait.
 */
export function livenessOf(
  sessionId: string,
  sessions: LiveSession[],
): 'busy' | 'idle' | 'gone' {
  const found = sessions.find((s) => s.sessionId === sessionId);
  if (!found) return 'gone';
  return found.status === 'busy' ? 'busy' : 'idle';
}
