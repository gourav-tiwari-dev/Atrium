/**
 * Can we actually launch the agent CLIs without a shell?
 *
 * `shell: true` concatenates argv without escaping (Node DEP0190), and
 * `codex queue` has to pass a teammate's message as an argument - so every
 * spawn is shell-free. On Windows that means resolving the npm .cmd shim
 * ourselves, and the two vendors ship DIFFERENT shim shapes:
 *
 *   codex.cmd  -> "%dp0%\...\codex.js"    a node script
 *   claude.cmd -> "%dp0%\...\claude.exe"  a native binary
 *
 * Handling only one of them silently breaks the other, which is exactly what
 * happened once: claude fell back to a bare name Node could not resolve, and
 * every ask failed with "not on PATH". This test costs no model calls and would
 * have caught it.
 *
 * Run: node scripts/launch-test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cliCommand } from '../bridge/src/launch.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\n  atrium launch test\n');

for (const name of ['claude', 'codex']) {
  const { cmd, prefix } = cliCommand(name);

  if (process.platform === 'win32') {
    // Either we resolved a real file, or we fell back to the bare name - and the
    // bare name is not spawnable without a shell, so it is a failure here.
    const target = prefix.length > 0 ? prefix[0] : cmd;
    check(`${name}: resolved to a real file`, existsSync(target), target);
  }

  // The real proof: it runs. --version touches no model and costs nothing.
  const r = spawnSync(cmd, [...prefix, '--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
  check(
    `${name}: spawns with no shell`,
    !r.error && r.status === 0,
    r.error ? String((r.error as NodeJS.ErrnoException).code) : out.slice(0, 40),
  );
}

// The message a teammate types must survive as one argument, whatever is in it.
const nasty = 'hello " & echo PWNED & rem ';
const echoed = spawnSync(
  process.execPath,
  ['-e', 'process.stdout.write(process.argv[1])', nasty],
  { encoding: 'utf8', shell: false },
);
check(
  'a hostile message survives as a single argument',
  echoed.stdout === nasty,
  JSON.stringify(echoed.stdout),
);

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
