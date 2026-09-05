import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * How to launch an agent CLI without a shell.
 *
 * `shell: true` concatenates arguments without escaping them - that is Node's
 * own DEP0190, and it is not theoretical: a message containing `"` and `&`
 * broke the command outright when tested. `codex queue` has to put a teammate's
 * message in argv rather than on stdin, so a shell is not an option there, and
 * there is no reason to keep one anywhere else either.
 *
 * On Windows npm installs these as .cmd shims and Node refuses to spawn a .cmd
 * without a shell, so resolve the shim to whatever it wraps. The two vendors
 * ship DIFFERENT shapes, and handling only one silently breaks the other:
 *
 *   codex.cmd  -> "%dp0%\...\codex.js"    a node script, run under this node
 *   claude.cmd -> "%dp0%\...\claude.exe"  a native binary, run directly
 *
 * Falls back to the bare name if nothing resolves, so the caller gets a real,
 * reported failure rather than silence.
 */

export interface Launch {
  cmd: string;
  /** goes in front of the real arguments - the script path, for a node shim */
  prefix: string[];
}

const cache = new Map<string, Launch>();

export function cliCommand(name: string): Launch {
  const hit = cache.get(name);
  if (hit) return hit;

  let resolved: Launch = { cmd: name, prefix: [] };
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(';')) {
      if (!dir) continue;

      let text: string | null = null;
      try {
        text = readFileSync(join(dir, `${name}.cmd`), 'utf8');
      } catch {
        text = null; // no shim in this PATH entry
      }

      // A shim names %dp0% more than once - codex's starts with
      // `IF EXIST "%dp0%\node.exe"`, which is the interpreter, not the tool.
      // So take every candidate and pick the first real, non-interpreter one.
      let found = false;
      for (const m of text ? text.matchAll(/"%dp0%[\\/]+(.+?)"/g) : []) {
        const target = join(dir, m[1]);
        if (/[\\/]node\.exe$/i.test(target)) continue;
        if (!existsSync(target)) continue;
        resolved = target.toLowerCase().endsWith('.js')
          ? { cmd: process.execPath, prefix: [target] }
          : { cmd: target, prefix: [] };
        found = true;
        break;
      }
      if (found) break;

      // No shim, but a plain .exe on PATH is spawnable as-is. Node does not do
      // PATHEXT resolution without a shell, so name it in full.
      const exe = join(dir, `${name}.exe`);
      if (existsSync(exe)) {
        resolved = { cmd: exe, prefix: [] };
        break;
      }
    }
  }
  cache.set(name, resolved);
  return resolved;
}

const installed = new Map<string, boolean>();

/**
 * Is this CLI actually usable on this machine?
 *
 * Needed because the agent used to default to "claude" whenever it could not
 * tell - which on a teammate's Codex-only Mac produced "claude is not on PATH"
 * for every question anyone asked them. Guessing the wrong vendor is worse than
 * asking the machine.
 */
export function hasCli(name: string): boolean {
  const hit = installed.get(name);
  if (hit !== undefined) return hit;

  const { cmd, prefix } = cliCommand(name);
  let ok = false;
  try {
    const r = spawnSync(cmd, [...prefix, '--version'], {
      timeout: 20_000,
      shell: false,
      stdio: 'ignore',
    });
    ok = !r.error && r.status === 0;
  } catch {
    ok = false;
  }
  installed.set(name, ok);
  return ok;
}

/**
 * Which agent CLI to drive when nothing else has said. Prefers whatever is
 * actually installed; falls back to claude only so the failure names something.
 */
export function detectAgent(): 'claude' | 'codex' {
  if (hasCli('claude')) return 'claude';
  if (hasCli('codex')) return 'codex';
  return 'claude';
}
