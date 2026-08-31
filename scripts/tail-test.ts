/**
 * Isolates the tailer: does appending to a file actually produce lines?
 * Run: node scripts/tail-test.ts
 */
import { appendFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tailer } from '../bridge/src/tail.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-tail-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{"seed":1}\n');

  const got: string[] = [];
  const tailer = new Tailer(file, (l) => got.push(l), { intervalMs: 80 });
  tailer.start();
  await sleep(200);

  check('existing content is not replayed', got.length === 0, `${got.length} line(s)`);

  appendFileSync(file, '{"a":1}\n');
  await sleep(300);
  check('a new line is delivered', got.length === 1, JSON.stringify(got));

  appendFileSync(file, '{"b":2}\n{"c":3}\n');
  await sleep(300);
  check('several lines in one append', got.length === 3, `${got.length}`);

  // a half-written line must wait for its newline
  appendFileSync(file, '{"d":4');
  await sleep(250);
  check('partial line is withheld', got.length === 3, `${got.length}`);
  appendFileSync(file, '}\n');
  await sleep(250);
  check('partial line completes', got.length === 4 && got[3] === '{"d":4}', got[3] ?? '(none)');

  // truncation resets cleanly
  writeFileSync(file, '{"fresh":1}\n');
  await sleep(300);
  check('truncation is handled', got.length === 5 && got[4] === '{"fresh":1}', got[4] ?? '(none)');

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });

  console.log(failures === 0 ? '\n  \x1b[32mtailer ok\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
