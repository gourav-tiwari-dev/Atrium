# Your Real Session In The Room — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every room message run through the person's own pinned agent
conversation, so the room and their terminal are one continuous session — and
make the browser the only place anyone types.

**Architecture:** Replace the drifting `claude -p --continue` ask with a pinned
`--resume <session-id>` per person, persisted in `~/.atrium/session.json`. The
bridge creates a conversation when none exists, checks liveness before running,
prepends a room-context header naming the asker, and tells people what to run to
carry the room into their terminal.

**Tech Stack:** Node 24 native TypeScript (no build step), `ws`,
`@modelcontextprotocol/sdk`, `node:sqlite`. Claude Code CLI 2.1.261, Codex CLI
0.153.4.

**Spec:** `docs/superpowers/specs/2026-09-05-live-session-in-the-room-design.md`

## Global Constraints

- **Node >= 24.** Native TypeScript, strip-only mode, **no build step**.
- **Node strip-only mode rejects TypeScript parameter properties.**
  `constructor(private x: T)` will not run. Declare fields explicitly.
- **No new dependencies.** Runtime deps stay exactly `ws` and
  `@modelcontextprotocol/sdk`. No `node-pty`, no test framework.
- **Tests are hand-rolled scripts** under `scripts/`, run by `node scripts/x.ts`,
  reporting via a local `check(label, ok, detail)` and exiting non-zero on
  failure. Follow `scripts/tail-test.ts` exactly.
- **The 52 existing checks must stay green.** `pnpm test` runs tail, smoke, mcp
  and memory suites.
- **Nothing fails silently.** Every failure path posts a `system` event or a
  console notice saying what happened and why. This rule was set in Session 4
  after @mentions failed quietly; it is not optional.
- **Never spawn with the prompt on a command line.** Prompts go on stdin (Claude)
  or through `--message` (Codex). A teammate's text must never reach a shell.
- **On this machine, use the Edit tool, not bash heredocs,** for any content
  containing backslashes or regex escapes — heredocs mangle them silently.

---

## File Structure

| File | Responsibility |
|---|---|
| `bridge/src/sessions.ts` | **new** — resolve, persist and check liveness of the pinned session |
| `bridge/src/roomprompt.ts` | **new** — build the room-context header prepended to every asked prompt |
| `bridge/src/runner.ts` | modify — pinned resume, create-if-none, Codex verbs, report new session ids |
| `bridge/src/client.ts` | modify — delete the broken `tryCodexInject` |
| `bridge/src/cli.ts` | modify — `--session` flag, wire the pin, print the handoff line |
| `bridge/src/parse/codex.ts` | already modified — strip `<recommended_plugins>` |
| `server/src/index.ts` | modify — count unpicked-up room messages per member |
| `server/src/protocol.ts` | modify — carry the pin and the pickup count to the browser |
| `web/src/*` | modify — lane header names the answering session; handoff banner |
| `scripts/session-test.ts` | **new** — pin persistence, liveness, create-if-none |
| `scripts/roomprompt-test.ts` | **new** — header shape, owner vs teammate |
| `scripts/codex-desktop-test.ts` | **new** — `<recommended_plugins>` stripping |

---

### Task 1: Land the Codex Desktop parser fix

The parser change is already written (`bridge/src/parse/codex.ts`) and verified
by hand. This task puts a test around it and commits it.

**Why:** Codex Desktop injects `<recommended_plugins>` as its own user record, so
every Codex teammate posts a plugins blob into the room at the start of each
session. Verified on a teammate's machine 2026-09-05: a probe showed `prompt=2`
where only one prompt was a person.

**Files:**
- Modify: `bridge/src/parse/codex.ts:52-60` (already done — verify it is present)
- Create: `scripts/codex-desktop-test.ts`
- Modify: `package.json` (add `test:codex` and chain it into `test`)

**Interfaces:**
- Consumes: `parseCodexLine(line: string, ctx: ParseContext, defaultSessionId?: string): Turn[]` from `bridge/src/parse/codex.ts`
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `scripts/codex-desktop-test.ts`:

```ts
/**
 * Codex Desktop rollouts, verified against a teammate's machine 2026-09-05.
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
check('a real prompt still comes through', realOnly.length === 1 && realOnly[0].text === real, JSON.stringify(realOnly.map((t) => t.text)));

const mixed = parseCodexLine(userRecord(`${blob}\n\n${real}`), ctx);
check('the blob is stripped from a mixed record', mixed.length === 1 && mixed[0].text === real, JSON.stringify(mixed.map((t) => t.text)));

const prose = 'I was reading about <recommended_plugins> in the docs';
const proseTurns = parseCodexLine(userRecord(prose), ctx);
check('an unpaired tag in prose is not eaten', proseTurns.length === 1 && proseTurns[0].text === prose, JSON.stringify(proseTurns.map((t) => t.text)));

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it and confirm all four pass**

Run: `node --no-warnings=ExperimentalWarning scripts/codex-desktop-test.ts`
Expected: 4 PASS, `all checks passed`, exit 0.

If `an injected plugins record produces no turn` FAILS, the `.replace()` for
`<recommended_plugins>` is missing from `cleanPrompt` — add it back:

```ts
    // Codex Desktop only. Paired form on purpose - a greedy match to end of
    // string would silently eat a real prompt that mentioned the tag.
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, '')
```

- [ ] **Step 3: Chain it into the suite**

In `package.json`, add the script and append it to `test`:

```json
"test:codex": "node --no-warnings=ExperimentalWarning scripts/codex-desktop-test.ts",
```

Append ` && node --no-warnings=ExperimentalWarning scripts/codex-desktop-test.ts`
to the end of the existing `"test"` value.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: 56 PASS lines total (52 existing + 4 new), exit 0.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/parse/codex.ts scripts/codex-desktop-test.ts package.json docs/
git commit -m "Read Codex Desktop rollouts without posting its plugins blob"
```

---

### Task 2: The session pin

**Files:**
- Create: `bridge/src/sessions.ts`
- Create: `scripts/session-test.ts`
- Modify: `package.json` (add `test:session`, chain into `test`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, used by Tasks 3, 5 and 6:
  - `interface Pin { agent: 'claude' | 'codex'; sessionId: string; cwd: string; pinnedAt: number }`
  - `interface LiveSession { pid: number; sessionId: string; cwd: string; kind: string; status: string; name: string }`
  - `interface PinStore { get(): Pin | undefined; set(pin: Pin): void; clear(): void }`
  - `openPin(room: string, name: string, storeDir?: string): PinStore`
  - `liveClaudeSessions(): LiveSession[]`
  - `livenessOf(sessionId: string, sessions: LiveSession[]): 'busy' | 'idle' | 'gone'`

- [ ] **Step 1: Write the failing test**

Create `scripts/session-test.ts`:

```ts
/**
 * The pinned session: does it persist, and can we tell if it is live?
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

reopened.clear();
check('clearing removes it', openPin('echosphere', 'gourav', dir).get() === undefined);

const live: LiveSession[] = [
  { pid: 1, sessionId: 'busy-one', cwd: 'C:/a', kind: 'interactive', status: 'busy', name: 'a' },
  { pid: 2, sessionId: 'idle-one', cwd: 'C:/b', kind: 'interactive', status: 'idle', name: 'b' },
];
check('a busy session reads busy', livenessOf('busy-one', live) === 'busy', livenessOf('busy-one', live));
check('an idle session reads idle', livenessOf('idle-one', live) === 'idle', livenessOf('idle-one', live));
check('an unlisted session reads gone', livenessOf('nope', live) === 'gone', livenessOf('nope', live));

rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --no-warnings=ExperimentalWarning scripts/session-test.ts`
Expected: FAIL — `Cannot find module '../bridge/src/sessions.ts'`

- [ ] **Step 3: Write the implementation**

Create `bridge/src/sessions.ts`. Mirror `offsets.ts`: same `~/.atrium` home,
same room+name scoping, same never-throw discipline.

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
 * liveness from a transcript's mtime.
 *
 * Returns [] when the CLI is missing or the shape is unexpected: a bridge that
 * cannot ask is not a bridge that should crash.
 */
export function liveClaudeSessions(): LiveSession[] {
  let raw: string;
  try {
    raw = execFileSync('claude', ['agents', '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
      shell: true, // the npm shim on Windows is a .cmd
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
 */
export function livenessOf(
  sessionId: string,
  sessions: LiveSession[],
): 'busy' | 'idle' | 'gone' {
  const found = sessions.find((s) => s.sessionId === sessionId);
  if (!found) return 'gone';
  return found.status === 'busy' ? 'busy' : 'idle';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning scripts/session-test.ts`
Expected: 9 PASS, exit 0.

- [ ] **Step 5: Sanity-check liveness against the real CLI**

Run: `node --no-warnings=ExperimentalWarning -e "import('./bridge/src/sessions.ts').then(m=>console.log(m.liveClaudeSessions()))"`
Expected: an array containing at least the session you are running in, each with
a non-empty `sessionId` and a `kind` of `interactive` or `bg`. An empty array
means `claude` is not resolving on PATH from a spawned process — fix that before
continuing, because Task 5 depends on it.

- [ ] **Step 6: Chain into the suite and commit**

Add to `package.json`:

```json
"test:session": "node --no-warnings=ExperimentalWarning scripts/session-test.ts",
```

Append it to `"test"` as in Task 1.

```bash
pnpm test
git add bridge/src/sessions.ts scripts/session-test.ts package.json
git commit -m "Pin one conversation per person, and read liveness from the CLI"
```

---

### Task 3: The room-context header

**Files:**
- Create: `bridge/src/roomprompt.ts`
- Create: `scripts/roomprompt-test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, used by Task 4:
  - `interface RoomContext { room: string; owner: string; from: string; members: number }`
  - `buildRoomPrompt(ctx: RoomContext, text: string): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/roomprompt-test.ts`:

```ts
/**
 * The header that tells an agent it is in a shared lobby and who is asking.
 * Run: node scripts/roomprompt-test.ts
 */
import { buildRoomPrompt } from '../bridge/src/roomprompt.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\n  atrium room-prompt test\n');

const base = { room: 'echosphere', owner: 'gourav', members: 4 };

const teammate = buildRoomPrompt({ ...base, from: 'Arihant Kumar' }, 'why Whittle?');
check('the asker is named', teammate.includes('Arihant Kumar'), '');
check('a teammate is marked as not the owner', /NOT your owner/i.test(teammate));
check('the owner is still named for reference', teammate.includes('gourav'));
check('the room is named', teammate.includes('echosphere'));
check('the audience size is stated', teammate.includes('4'));
check('the lobby rule is present', /do not reveal/i.test(teammate));
check('the message survives verbatim', teammate.includes('why Whittle?'));

const owner = buildRoomPrompt({ ...base, from: 'gourav' }, 'status?');
check('the owner is marked as the owner', /your owner/i.test(owner) && !/NOT your owner/i.test(owner), '');

const messy = buildRoomPrompt({ ...base, from: 'x' }, 'line one\nline two');
check('multi-line messages are preserved', messy.includes('line one\nline two'));

const header = teammate.slice(0, teammate.indexOf('why Whittle?'));
check('the header comes before the message', header.length > 0 && header.includes('Atrium'));

console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --no-warnings=ExperimentalWarning scripts/roomprompt-test.ts`
Expected: FAIL — `Cannot find module '../bridge/src/roomprompt.ts'`

- [ ] **Step 3: Write the implementation**

Create `bridge/src/roomprompt.ts`:

```ts
/**
 * What an agent needs to know before it answers a room message.
 *
 * Two things it cannot work out for itself:
 *
 *  1. WHO ASKED. The room hands the bridge the asker's name and the bridge used
 *     to print it to a console and throw it away, so an agent could not tell its
 *     owner's question from a teammate's. That produced answers addressed to the
 *     wrong person.
 *
 *  2. WHERE THE ANSWER GOES. A reply here is posted to everyone in the room, not
 *     back to one person in private.
 *
 * This is a behavioural steer, not a security boundary. It shapes behaviour
 * reliably in normal use; a determined prompt can talk an agent around its own
 * instructions. A real boundary is a restricted tool set for room-driven runs -
 * recorded in the spec as the upgrade path if the room ever opens beyond the
 * people who already trust each other.
 */

export interface RoomContext {
  room: string;
  /** whose machine this agent runs on */
  owner: string;
  /** who typed the message */
  from: string;
  /** how many people can see the reply */
  members: number;
}

export function buildRoomPrompt(ctx: RoomContext, text: string): string {
  const isOwner = ctx.from === ctx.owner;
  const who = isOwner
    ? `[From: ${ctx.from} — your owner]`
    : `[From: ${ctx.from} — a teammate, NOT your owner ${ctx.owner}]`;

  return [
    `[Atrium · room "${ctx.room}" · ${ctx.members} people will see your reply]`,
    who,
    `[Shared lobby. Your reply is posted publicly to the room. Do not reveal file`,
    ` contents, credentials, or personal memory from this machine unless`,
    ` ${ctx.owner} asks for it himself, here, in this room.]`,
    '',
    `${ctx.from} asks:`,
    text,
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning scripts/roomprompt-test.ts`
Expected: 10 PASS, exit 0.

- [ ] **Step 5: Chain into the suite and commit**

Add `"test:prompt": "node --no-warnings=ExperimentalWarning scripts/roomprompt-test.ts",`
to `package.json` and append it to `"test"`.

```bash
pnpm test
git add bridge/src/roomprompt.ts scripts/roomprompt-test.ts package.json
git commit -m "Tell the agent which room it is in and who is asking"
```

---

### Task 4: Runner — pinned resume, create-if-none, attribution

**Files:**
- Modify: `bridge/src/runner.ts` (rewrite `RunnerOptions`, `argv()`, `once()`)

**Interfaces:**
- Consumes: `Pin` from `bridge/src/sessions.ts` (Task 2);
  `buildRoomPrompt`, `RoomContext` from `bridge/src/roomprompt.ts` (Task 3).
- Produces, used by Tasks 5 and 6:
  - `AgentRunner.run(from: string, text: string): void` — note the **two**
    arguments; the old single-argument form is gone.
  - `RunnerOptions.sessionId?: string` — the pinned conversation; `undefined`
    means create one.
  - `RunnerOptions.onSessionCreated: (sessionId: string) => void`

- [ ] **Step 1: Replace the options and the queue entry point**

In `bridge/src/runner.ts`, replace the `RunnerOptions` interface and the `run`
method. Remove `continueSession` entirely.

```ts
export interface RunnerOptions {
  agent: AgentKind;
  /** where the agent runs; should be the project folder, not the atrium folder */
  cwd: string;
  /** claude only: auto | acceptEdits | dontAsk | plan */
  permissionMode: string;
  /** codex only: let it write and run commands instead of read-only */
  fullAuto: boolean;
  /**
   * The pinned conversation. Undefined means nobody on this machine has started
   * one yet - so the first message CREATES it rather than failing, and the id
   * comes back through onSessionCreated. The room is the only place anyone
   * types; it must not require a CLI to have been opened first.
   */
  sessionId?: string;
  /** room context for the header prepended to every prompt */
  room: string;
  owner: string;
  memberCount: () => number;
  onSessionCreated: (sessionId: string) => void;
  onNotice: (text: string) => void;
  onState: (running: boolean) => void;
}

interface QueuedRun {
  from: string;
  text: string;
}
```

Change the queue field and `run`:

```ts
  private readonly queue: QueuedRun[] = [];

  /** Queue a prompt. One run at a time - two agents in one folder trip over each other. */
  run(from: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push({ from, text: trimmed });
    if (!this.busy) void this.drain();
  }
```

- [ ] **Step 2: Rewrite `argv()` for pinned resume and create-if-none**

```ts
  private argv(resume: boolean): { cmd: string; args: string[] } {
    const id = this.opts.sessionId;
    if (this.opts.agent === 'codex') {
      // `codex exec resume <id>` continues a thread; bare `codex exec` starts one.
      const args = resume && id ? ['exec', 'resume', id] : ['exec'];
      args.push('--skip-git-repo-check');
      if (this.opts.fullAuto) args.push('--full-auto');
      return { cmd: 'codex', args };
    }
    // --output-format json is what lets us read back the session id, which is
    // the only way to learn the id of a conversation we just created.
    const args = ['-p', '--output-format', 'json', '--permission-mode', this.opts.permissionMode];
    if (resume && id) args.push('--resume', id);
    return { cmd: 'claude', args };
  }
```

- [ ] **Step 3: Rewrite `drain()` to build the header and fall back once**

```ts
  private async drain(): Promise<void> {
    const job = this.queue.shift();
    if (job === undefined) return;

    this.busy = true;
    this.opts.onState(true);
    this.stats.started++;

    const prompt = buildRoomPrompt(
      {
        room: this.opts.room,
        owner: this.opts.owner,
        from: job.from,
        members: this.opts.memberCount(),
      },
      job.text,
    );

    try {
      const hadPin = Boolean(this.opts.sessionId);
      const ok = await this.once(prompt, hadPin);
      // A pinned id can go stale - the person deleted the conversation, or it
      // was never on this machine. Starting a fresh one is better than a dead
      // lane, and onSessionCreated repins it.
      if (!ok && hadPin) {
        this.opts.onNotice('the pinned session could not be resumed - starting a new one');
        await this.once(prompt, false);
      }
    } finally {
      this.busy = false;
      this.opts.onState(false);
      if (this.queue.length > 0) void this.drain();
    }
  }
```

Add the import at the top of the file:

```ts
import { buildRoomPrompt } from './roomprompt.ts';
```

- [ ] **Step 4: Fix the `once()` signature, then capture the session id**

`once()` currently takes `continueSession` and does a save/restore dance around
the old `argv()`:

```ts
    const saved = this.opts.continueSession;
    this.opts.continueSession = continueSession;
    const { cmd, args } = this.argv();
    this.opts.continueSession = saved;
```

`continueSession` no longer exists, so delete all four lines. Change the
signature to `private once(prompt: string, resume: boolean): Promise<boolean>`
and call the new form directly:

```ts
    const { cmd, args } = this.argv(resume);
```

Then, in the same method, replace `child.stdout?.resume();` with a collector and
report the id on success:

```ts
      let stdout = '';
      child.stdout?.on('data', (c: Buffer) => {
        // Cap it: we only need the small JSON envelope, not a long answer.
        if (stdout.length < 200_000) stdout += c.toString();
      });
```

and inside `child.on('close', ...)`, before `resolve(true)`:

```ts
        if (code === 0) {
          const created = sessionIdFrom(stdout);
          if (created && created !== this.opts.sessionId) {
            this.opts.sessionId = created;
            this.opts.onSessionCreated(created);
          }
          resolve(true);
          return;
        }
```

Add this helper above the class:

```ts
/**
 * `claude -p --output-format json` prints an envelope carrying session_id.
 * That is how a conversation we just created tells us its own id, so the next
 * message can resume it instead of starting another one.
 */
function sessionIdFrom(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const id = o.session_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null; // codex, or a non-JSON build: the tailer finds the session anyway
  }
}
```

- [ ] **Step 5: Verify by hand against the real CLI**

Run this from the repo root. It creates a conversation, then continues it, and
proves the second message lands in the same session:

```bash
node --no-warnings=ExperimentalWarning -e "
import('./bridge/src/runner.ts').then(async ({AgentRunner})=>{
  let created=null;
  const r=new AgentRunner({agent:'claude',cwd:process.cwd(),permissionMode:'auto',fullAuto:false,
    sessionId:undefined,room:'test',owner:'gourav',memberCount:()=>2,
    onSessionCreated:(id)=>{created=id;console.log('CREATED',id)},
    onNotice:(t)=>console.log('NOTICE',t),
    onState:(b)=>{ if(!b && created) console.log('done, pinned to',created) }});
  r.run('gourav','Remember the codeword TANGO. Reply: ok');
});
"
```

Expected: one `CREATED <uuid>` line. Then run it again with
`sessionId: '<that uuid>'` and the prompt `What codeword? Reply with just the
word.` — the answer must be `TANGO`, and `claude agents --json` must **not**
show a second session for the same conversation.

- [ ] **Step 6: Commit**

```bash
pnpm test
git add bridge/src/runner.ts
git commit -m "Run room messages through the pinned conversation, creating one if needed"
```

---

### Task 5: Liveness gate, Codex verbs, and the broken inject

**Files:**
- Modify: `bridge/src/runner.ts` (liveness gate + Codex queue path)
- Modify: `bridge/src/client.ts:165-181` (delete `tryCodexInject` and its call site)

**Interfaces:**
- Consumes: `liveClaudeSessions`, `livenessOf` from `bridge/src/sessions.ts` (Task 2);
  `AgentRunner.run(from, text)` from Task 4.
- Produces: `RunnerOptions.onBlocked: (reason: string) => void`

- [ ] **Step 1: Delete the Codex inject that has never worked**

`bridge/src/client.ts:170` spawns:

```js
['queue', '--session', this.opts.codexSession, `[atrium] ${from}: ${text}`]
```

The real signature is `codex queue --thread <THREAD> --message <TEXT>`. That call
passes `--session`, which is not a flag, and the text as a positional argument.
It has failed on every invocation, with `stdio: 'ignore'` and the error swallowed
— a silent failure of exactly the kind Session 4 outlawed.

Delete the whole `tryCodexInject` method and every call to it. Codex delivery now
goes through the runner like every other agent, with the correct flags and a
visible failure path.

- [ ] **Step 2: Add the liveness gate**

In `runner.ts`, add to `RunnerOptions`:

```ts
  /** told why a run could not start, so the room can say so instead of hanging */
  onBlocked: (reason: string) => void;
```

At the top of `drain()`, after taking the job off the queue and before running,
gate on liveness — Claude only, since the check reads `claude agents --json`:

```ts
    if (this.opts.agent === 'claude' && this.opts.sessionId) {
      const state = livenessOf(this.opts.sessionId, liveClaudeSessions());
      if (state === 'busy') {
        // Mid-turn in their own terminal. Two writers on one transcript branches
        // it, so wait rather than fork - but say so, because a silent wait is
        // indistinguishable from a hang.
        this.queue.unshift(job);
        this.busy = false;
        this.opts.onState(false);
        this.opts.onBlocked(`${this.opts.owner} is mid-turn in their terminal — queued`);
        setTimeout(() => { if (!this.busy) void this.drain(); }, 5_000);
        return;
      }
    }
```

Add the import:

```ts
import { liveClaudeSessions, livenessOf } from './sessions.ts';
```

- [ ] **Step 3: Add the Codex live-queue path behind a flag**

Add to `RunnerOptions`:

```ts
  /**
   * codex only: deliver into the RUNNING app session with `codex queue` instead
   * of spawning `codex exec resume`. Verified locally that `codex queue` works
   * on Windows without --remote; whether it reaches a live Codex Desktop session
   * is the one open question in the spec. Off until that is confirmed.
   */
  codexLiveQueue: boolean;
```

In `drain()`, before the normal spawn path:

```ts
    if (this.opts.agent === 'codex' && this.opts.codexLiveQueue && this.opts.sessionId) {
      const ok = await this.queueToCodex(prompt);
      if (ok) { /* the answer arrives through the rollout the tailer watches */ }
      else this.opts.onNotice('codex queue failed - falling back to a fresh run');
      if (ok) { this.busy = false; this.opts.onState(false); if (this.queue.length) void this.drain(); return; }
    }
```

And the method:

```ts
  /** `codex queue --thread <id> --message <text>` - the text is an argv value, never a shell word. */
  private queueToCodex(prompt: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = spawn(
        'codex',
        ['queue', '--thread', String(this.opts.sessionId), '--message', prompt],
        { cwd: this.opts.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      child.stdout?.resume();
      child.on('error', () => { this.fail('codex is not on PATH on this machine'); resolve(false); });
      child.on('close', (code) => {
        if (code === 0) { resolve(true); return; }
        this.fail(stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) || `codex queue exited ${code}`);
        resolve(false);
      });
    });
  }
```

Note `shell: false` here — unlike the Claude path, no `.cmd` shim indirection is
needed for an argv-only call, and it keeps the prompt out of shell parsing
entirely.

- [ ] **Step 4: Verify the gate by hand**

With this session open and busy, run the Task 4 harness against **this** session
id. Expected: no run starts, and `onBlocked` prints
`gourav is mid-turn in their terminal — queued`. Then run it against a session id
that is not in `claude agents --json`. Expected: it runs normally.

- [ ] **Step 5: Commit**

```bash
pnpm test
git add bridge/src/runner.ts bridge/src/client.ts
git commit -m "Queue behind a busy terminal, and fix the Codex send that never ran"
```

---

### Task 6: Wire the bridge CLI

**Files:**
- Modify: `bridge/src/cli.ts:190-260` (the `onRun` handler and runner construction)
- Modify: `bridge/src/cli.ts` help text (around line 371-380)

**Interfaces:**
- Consumes: `openPin`, `Pin` (Task 2); `AgentRunner` with the Task 4/5 options.
- Produces: the `--session <uuid>` flag.

- [ ] **Step 1: Open the pin and pass it to the runner**

Near the other option reads, add:

```ts
  const pins = openPin(room, name);
  const pinned = pins.get();
  const forcedSession = val('--session');
```

Replace the runner construction inside `onRun` so it uses the pin, passes `from`
through, and repins whatever gets created:

```ts
    onRun: (from, text) => {
      if (!allowAsk && !allowMentions) return;
      if (!runner) {
        const agent = (val('--ask-agent') as AgentKind | undefined) ?? pinned?.agent ?? bridgeRef?.lastAgent ?? 'claude';
        const cwd = val('--ask-cwd') ?? pinned?.cwd ?? bridgeRef?.lastCwd ?? process.cwd();
        const sessionId = forcedSession ?? pinned?.sessionId;

        console.log(C.dim(`\n  running asks through ${agent} in ${cwd}`));
        console.log(
          sessionId
            ? C.dim(`  pinned session ${sessionId}`)
            : C.yellow('  no pinned session yet — the first message will start one'),
        );
        if (agent === 'claude' && resolve(cwd) === resolve(homedir())) {
          console.log(C.dim('  note: home folder, so your saved memory is in scope; answers go to the room'));
        }

        runner = new AgentRunner({
          agent,
          cwd,
          permissionMode: val('--ask-permission-mode') ?? 'auto',
          fullAuto: has('--full-auto'),
          sessionId,
          room,
          owner: name,
          memberCount: () => client.memberCount,
          codexLiveQueue: has('--codex-live-queue'),
          onSessionCreated: (id) => {
            pins.set({ agent, sessionId: id, cwd, pinnedAt: Date.now() });
            console.log(C.green(`  ● pinned this room to session ${id}`));
            console.log(C.dim(`    pick it up in a terminal with:  ${agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`}`));
          },
          onBlocked: (why) => {
            console.log(C.yellow(`  … ${why}`));
            client.notice(why);
          },
          onNotice: (t) => {
            console.log(C.yellow(`  ! agent run failed: ${t}`));
            client.notice(`agent run failed: ${t}`);
          },
          onState: (busy) => {
            if (busy) console.log(C.magenta(`\n  > ${from} asked your agent: `) + oneLine(text, 100));
          },
        });
      }
      runner.run(from, text);
    },
```

Note the last line: `from` is now passed through instead of dropped.

- [ ] **Step 2: Expose `memberCount` on the client**

In `bridge/src/client.ts`, add a public field updated whenever a `presence`
message arrives:

```ts
  /** how many people are in the room, for the lobby header */
  memberCount = 1;
```

and in the `presence` branch of the message handler:

```ts
      this.memberCount = msg.members.length;
```

- [ ] **Step 3: Document the flags**

In the help text, add:

```
  ${C.bold('--session <uuid>')}          pin a specific conversation instead of the saved one
  ${C.bold('--codex-live-queue')}        codex only: deliver into the running app session
```

- [ ] **Step 4: Verify end to end**

Start the server and a bridge, open the room, type a message in the browser.
Expected, in order: the console prints either `pinned session <id>` or
`no pinned session yet`; the answer appears in the lane; `~/.atrium/session.json`
contains a pin for `echosphere::<name>`; a second message reuses the same id.

- [ ] **Step 5: Commit**

```bash
pnpm test
git add bridge/src/cli.ts bridge/src/client.ts
git commit -m "Pin the room to one conversation, and pass the asker's name through"
```

---

### Task 7: The room → terminal handoff

**Files:**
- Modify: `server/src/protocol.ts` (add `pickup` to `Member`)
- Modify: `server/src/index.ts` (count room-driven turns per member)
- Modify: `web/src/` (banner in the person's own lane)
- Modify: `bridge/src/cli.ts` (print the same line on exit)

**Interfaces:**
- Consumes: `Pin` (Task 2), `onSessionCreated` (Task 4).
- Produces: `Member.pickup?: { count: number; command: string }`

- [ ] **Step 1: Carry the pickup hint on the wire**

In `server/src/protocol.ts`, extend `Member`:

```ts
export interface Member {
  name: string;
  agent: string | null;
  role: 'bridge' | 'viewer';
  canAsk: boolean;
  canMention: boolean;
  online: boolean;
  lastSeen: number;
  /**
   * Room messages that went into this person's session but that an already-open
   * terminal will not have seen. A running agent process does not notice
   * appends made behind its back - verified 2026-09-05 - so the handoff has to
   * be explicit rather than assumed.
   */
  pickup?: { count: number; command: string };
}
```

Extend the bridge's hello so the server knows the command to print:

```ts
  | { t: 'hello'; room: string; token: string; name: string; agent?: string; role: 'bridge' | 'viewer'; canAsk?: boolean; canMention?: boolean; resumeCommand?: string }
```

Then actually send it. Add `resumeCommand?: string` to `ClientOptions` in
`bridge/src/client.ts:16`, include it in the `hello` payload the client sends on
connect, and pass it from `cli.ts` where the `RoomClient` is constructed:

```ts
    resumeCommand: pinned
      ? (pinned.agent === 'claude' ? `claude --resume ${pinned.sessionId}` : `codex resume ${pinned.sessionId}`)
      : undefined,
```

A pin created later, by `onSessionCreated`, will be picked up on the next
reconnect. That is good enough: until a session exists there is nothing to pick
up, so the banner has nothing to show anyway.

- [ ] **Step 2: Count them on the server**

In `server/src/index.ts`, keep a per-room, per-name counter. Increment it in the
`ask` and `mention` handlers where a `run` is dispatched; reset it when that
member's bridge reconnects (a reconnect means a fresh process read the file).

```ts
const pickups = new Map<string, number>(); // `${room}::${name}` -> unread count

function bumpPickup(room: string, name: string): void {
  const k = `${room}::${name}`;
  pickups.set(k, (pickups.get(k) ?? 0) + 1);
}
```

The `Conn` interface at `server/src/index.ts:19` has no `resumeCommand` field —
add one, populated from the `hello` message, or the snippet below will not
compile:

```ts
  /** what this person types to pick the room up in a terminal, from their bridge */
  resumeCommand?: string;
```

and where the connection is registered from `hello`:

```ts
    resumeCommand: msg.resumeCommand,
```

`members()` builds each entry inline with `byName.set(c.name, {...})`. Attach the
hint in that same object literal, and again in the `if (existing)` branch where a
bridge overrides a viewer — a viewer connection has no `resumeCommand`, so only
the bridge's value is meaningful:

```ts
      // inside the bridge-wins branch
      const n = pickups.get(`${room}::${c.name}`) ?? 0;
      existing.pickup = n > 0 && c.resumeCommand ? { count: n, command: c.resumeCommand } : undefined;
```

```ts
      // inside byName.set({...}), as a property
      pickup: (() => {
        const n = pickups.get(`${room}::${c.name}`) ?? 0;
        return n > 0 && c.resumeCommand ? { count: n, command: c.resumeCommand } : undefined;
      })(),
```

Note `room` is the function's own parameter — do not write `c.room` here.

- [ ] **Step 3: Show it in the browser**

In the web UI, when the current viewer's own member entry has `pickup`, render a
banner above their lane:

```
  3 room messages went into your session.
  An already-open terminal won't have them.

  claude --resume 11952de6-6cca-4807-a5bd-f58d8cf1cc3a
```

Make the command selectable text. Do not add a copy button that depends on
clipboard permissions — a room opened over a tunnel may not have them.

- [ ] **Step 4: Print the same line when the bridge exits**

In `bridge/src/cli.ts`, in the existing shutdown path, print:

```ts
  const p = pins.get();
  if (p) {
    console.log(C.dim(`\n  pick this room up in a terminal with:`));
    console.log(`  ${p.agent === 'claude' ? `claude --resume ${p.sessionId}` : `codex resume ${p.sessionId}`}\n`);
  }
```

- [ ] **Step 5: Verify**

Ask your agent twice from the browser with no terminal open on that session.
Expected: the banner reads `2 room messages…`. Then run the printed command.
Expected: the new process knows what was discussed in the room, and after the
bridge reconnects the banner is gone.

- [ ] **Step 6: Commit**

```bash
pnpm test
git add server/src/protocol.ts server/src/index.ts web/src bridge/src/cli.ts
git commit -m "Hand the room's work back to the terminal instead of losing it"
```

---

## Self-review notes

**Spec coverage.** §1 pinning → Task 2 and 6. §1 create-if-none → Task 4.
§2 one writer → Task 5. §3 handoff → Task 7. §4 header and attribution →
Tasks 3, 4 and 6. §5 presence → no change needed; already correct and
documented. §6 Codex → Tasks 1 and 5.

**Not covered on purpose.** `--room-deny <tools>` — the spec records it as the
upgrade path if the room ever opens beyond the four people, not as work now.

**Open question carried in.** Whether `codex queue` reaches a live Codex Desktop
session is still unverified, which is why Task 5 puts it behind
`--codex-live-queue`, defaulting off, with `codex exec resume` as the path that
runs by default. Confirming it flips a default, not an architecture.
