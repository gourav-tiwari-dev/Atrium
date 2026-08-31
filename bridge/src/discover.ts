import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Source {
  agent: 'claude' | 'codex';
  file: string;
  mtimeMs: number;
  size: number;
}

function walk(dir: string, match: (name: string) => boolean, depth: number, out: string[]): void {
  if (depth < 0 || !existsSync(dir)) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir is not fatal - just not a source
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, match, depth - 1, out);
    else if (e.isFile() && match(e.name)) out.push(full);
  }
}

function stat(file: string, agent: Source['agent']): Source | null {
  try {
    const s = statSync(file);
    return { agent, file, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export function claudeRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function codexRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

/** Every transcript on this machine, newest first. */
export function discover(): Source[] {
  const found: Source[] = [];

  const claudeFiles: string[] = [];
  walk(claudeRoot(), (n) => n.endsWith('.jsonl'), 2, claudeFiles);
  for (const f of claudeFiles) {
    const s = stat(f, 'claude');
    if (s) found.push(s);
  }

  const codexFiles: string[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl -> 4 levels of nesting
  walk(codexRoot(), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 4, codexFiles);
  for (const f of codexFiles) {
    const s = stat(f, 'codex');
    if (s) found.push(s);
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The sessions worth streaming: touched recently enough to be live.
 * A person can have several terminals open, so this returns all of them,
 * not just the single newest.
 */
export function activeSources(withinMs = 30 * 60 * 1000, now = Date.now()): Source[] {
  return discover().filter((s) => now - s.mtimeMs <= withinMs);
}
