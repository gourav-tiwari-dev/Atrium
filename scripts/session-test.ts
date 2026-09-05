/**
 * The pinned session: does it persist, and can we tell if it is live?
 *
 * Pinning is what makes the room talk to YOUR conversation rather than
 * "whatever was newest in this folder", which drifts. Liveness is what stops
 * two processes writing one transcript and branching it.
 *
 * Run: node scripts/session-test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPin, livenessOf, type LiveSession } from '../bridge/src/sessions.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\n  atrium session-pin test\n');

const dir = mkdtempSync(join(tmpdir(), 'atrium-pin-'));

const store = openPin('echosphere', 'gourav', dir);
check('a fresh store has no pin', store.get() === undefined);

store.set({ agent: 'claude', sessionId: 'abc-123', cwd: 'C:/proj', pinnedAt: 1000 });
check('the pin reads back', store.get()?.sessionId === 'abc-123', String(store.get()?.sessionId));

const reopened = openPin('echosphere', 'gourav', dir);
check('the pin survives a bridge restart', reopened.get()?.sessionId === 'abc-123', String(reopened.get()?.sessionId));

const other = openPin('echosphere', 'arihant', dir);
check('another member has their own pin', other.get() === undefined);

const otherRoom = openPin('weave', 'gourav', dir);
check('another room has its own pin', otherRoom.get() === undefined);

other.set({ agent: 'codex', sessionId: 'zzz-999', cwd: 'C:/other', pinnedAt: 2000 });
check(
  'one member cannot clobber another',
  openPin('echosphere', 'gourav', dir).get()?.sessionId === 'abc-123',
  String(openPin('echosphere', 'gourav', dir).get()?.sessionId),
);

reopened.clear();
check('clearing removes it', openPin('echosphere', 'gourav', dir).get() === undefined);
check(
  'clearing one leaves the others',
  openPin('echosphere', 'arihant', dir).get()?.sessionId === 'zzz-999',
  String(openPin('echosphere', 'arihant', dir).get()?.sessionId),
);

const live: LiveSession[] = [
  { pid: 1, sessionId: 'busy-one', cwd: 'C:/a', kind: 'interactive', status: 'busy', name: 'a' },
  { pid: 2, sessionId: 'idle-one', cwd: 'C:/b', kind: 'interactive', status: 'idle', name: 'b' },
];
check('a busy session reads busy', livenessOf('busy-one', live) === 'busy', livenessOf('busy-one', live));
check('an idle session reads idle', livenessOf('idle-one', live) === 'idle', livenessOf('idle-one', live));
check('an unlisted session reads gone', livenessOf('nope', live) === 'gone', livenessOf('nope', live));
check('no live sessions at all reads gone', livenessOf('busy-one', []) === 'gone', livenessOf('busy-one', []));

rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
