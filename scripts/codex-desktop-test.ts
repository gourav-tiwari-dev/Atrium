/**
 * Codex Desktop rollouts, verified against a teammate's machine 2026-09-05.
 *
 * The desktop app injects <recommended_plugins> as its own user record, so
 * without cleaning it every Codex teammate posts a plugins blob into the room
 * at the start of each session. A real probe showed prompt=2 where only one
 * prompt was a person.
 *
 * Run: node scripts/codex-desktop-test.ts
 */
import { parseCodexLine } from '../bridge/src/parse/codex.ts';
import { DEFAULT_PARSE_CONTEXT } from '../bridge/src/types.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function userRecord(text: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: { type: 'message', role: 'user', id: 'x1', content: [{ type: 'input_text', text }] },
  });
}

console.log('\n  atrium codex-desktop test\n');

const ctx = DEFAULT_PARSE_CONTEXT;
const blob = '<recommended_plugins>\nplugin list the app injected\n</recommended_plugins>';
const real = 'how do we handle floor control?';

const onlyBlob = parseCodexLine(userRecord(blob), ctx);
check('an injected plugins record produces no turn', onlyBlob.length === 0, `${onlyBlob.length} turn(s)`);

const realOnly = parseCodexLine(userRecord(real), ctx);
check(
  'a real prompt still comes through',
  realOnly.length === 1 && realOnly[0].text === real,
  JSON.stringify(realOnly.map((t) => t.text)),
);

const mixed = parseCodexLine(userRecord(`${blob}\n\n${real}`), ctx);
check(
  'the blob is stripped from a mixed record',
  mixed.length === 1 && mixed[0].text === real,
  JSON.stringify(mixed.map((t) => t.text)),
);

const prose = 'I was reading about <recommended_plugins> in the docs';
const proseTurns = parseCodexLine(userRecord(prose), ctx);
check(
  'an unpaired tag in prose is not eaten',
  proseTurns.length === 1 && proseTurns[0].text === prose,
  JSON.stringify(proseTurns.map((t) => t.text)),
);

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
