# Your real session in the room

**Date:** 2026-09-05
**Status:** design, approved in outline — awaiting spec review
**Supersedes:** the one-shot `claude -p --continue` ask path added 2026-08-31

---

## The problem

Today, a prompt typed in the Atrium browser spawns a fresh agent process:

```
browser prompt → server → bridge → claude -p --continue   (new process, every time)
```

`--continue` means *"the most recent conversation in this folder"*. It drifts. It
can land in a different conversation than the one the person is actually working
in, and the room's exchange ends up somewhere they will never look again.

Gourav's words: *"i want people real llm to be present in the web not a copy of
them with no memory."*

The requirement, stated precisely:

> The session you talk to in your terminal gets a second front-end in the
> browser. Everything said in the room lands in that same conversation on your
> machine. When you leave the room and go back to your terminal, the whole
> session is there — because it was never a different agent.

---

## What we verified first

Every claim below was measured on this machine on 2026-09-05.
Claude Code **2.1.261**, Codex **0.153.4**.

| # | Question | Result |
|---|---|---|
| 1 | Does `claude -p --resume <id>` keep full context? | ✅ same `session_id`, answered `ZULU`; and carried a full 744 KB session |
| 2 | Does it append or fork? | ✅ **appends to the same file** — 30,556 → 44,916 B; no new transcript |
| 3 | Can it resume a **background** session that is live? | ❌ refused with a clear error, transcript untouched |
| 4 | Can it resume an **interactive** session that is live? | ✅ **yes** — 663,123 → 676,034 B, same file |
| 5 | Does the running process see those outside appends? | ❌ **no** — it never saw them |
| 6 | Does concurrent writing fork the transcript? | ⚠️ **yes** — 1 fork point, parent `0bc5c9a0` → 2 children |
| 7 | Is there a live session registry? | ✅ `claude agents --json` — pid, cwd, sessionId, status, kind |
| 8 | Is there a way to message a live session? | ⚠️ yes, an undocumented key-gated local pipe — **rejected**, see Non-goals |

**Finding 4 is what makes this design possible.** Finding 5 and 6 are what shape
its one rule.

The decisive asymmetry:

```
transcript file → NEW process      ✅ full context      (verified twice)
transcript file → RUNNING process  ❌ blind, and forks  (verified)
```

Which is exactly the shape of the requirement: leaving the room and coming back
to your terminal *is* a new process.

### Verified later the same day, on a teammate's machine

| # | Question | Result |
|---|---|---|
| 9 | Does **Codex Desktop** write rollouts to `~/.codex/sessions`? | ✅ yes — `originator: Codex desktop`, `source: vscode` |
| 10 | Does the existing parser handle them? | ✅ **no changes needed** — 36 found, 3 live, zero unclassified shapes, no doubled answers |

### Not verified

- `codex queue --thread <uuid> --message <text>` against a live Codex Desktop
  session, and whether the app registers with the `app-server` daemon at all.
  Decides live-vs-pinned delivery for Sahil and romit; both branches work.
- Which leaf `--resume` follows once a transcript has branched.

---

## The team this is for

| Person | Tool | Lane in the room | Ask + be cross-questioned |
|---|---|---|---|
| gourav | Claude Code CLI | ✅ | ✅ |
| Arihant | Claude Code CLI | ✅ | ✅ |
| Sahil | Codex Desktop | ✅ verified 2026-09-05 | ✅ after `npm i -g @openai/codex` |
| romit | Codex Desktop | ✅ verified 2026-09-05 | ✅ after `npm i -g @openai/codex` |

**Everyone types to their own agent, and anyone can cross-question anyone
else's.** That is the point of the room; a read-only lane for half the team
would defeat it. The Codex CLI is a prerequisite for the ask path, not an
optional extra — it is a one-command npm global install, and both Codex users
already have Node 24 and pnpm.

Four people, one private room. Privacy between them is not a concern; leaking
a machine's private contents into the room is (see *Lobby awareness*).

---

## Design

### 1. Pin the session

Replace *"whatever was newest in this folder"* with *"this exact conversation"*.

```diff
- claude -p --continue
+ claude -p --resume <pinned-session-id>
```

The bridge already has the ids — for Claude the session id **is** the transcript
filename, and `parse/codex.ts` already exposes `sessionIdFromPath`.

**New module: `bridge/src/sessions.ts`**

```
pin = { room, name, agent, sessionId, cwd, pinnedAt }
```

| Concern | Rule |
|---|---|
| Default pin | newest live session from `claude agents --json`, falling back to newest transcript by mtime |
| Persisted | `~/.atrium/session.json`, keyed by room + member name |
| Stable | survives bridge restart — same agent tomorrow as today |
| Override | `--session <uuid>` |
| Pin is gone | repin to newest, post a `system` event saying so |
| **No session exists at all** | **create one**, then pin what it produced |

**Streaming is unchanged.** All active sessions keep flowing into the person's
lane — that is how the room sees everything they do. Only *asks* are pinned, and
the lane header names the session that answers.

**The browser must be self-sufficient.** The room is the only place anyone
types — nobody opens a CLI or a desktop app to take part. So a person who has
never started a session must still be able to open Atrium, type, and get an
answer. If nothing is pinned, the bridge **starts a conversation** rather than
failing:

| | first message | every message after |
|---|---|---|
| Claude | `claude -p` (no `--resume`) | `claude -p --resume <pinned>` |
| Codex | `codex exec` | `codex exec resume <pinned>` or `codex queue` |

The id that first run produces becomes the pin, and from then on it is one
continuous conversation. Later, if that person opens their own CLI or app and
resumes that session, the entire room conversation is already in it — the
handoff in §3 works in both directions from day one.

The only local step left for anyone is starting the bridge once
(`pnpm bridge join …`). Everything else happens in the browser.

### 2. One writer at a time

Finding 6 says two processes writing one transcript branches it. Gourav has
confirmed nobody will type in both places at once, so this is a guard rail, not
a scheduler.

Before every run, read `claude agents --json`:

```
room message arrives
   │
   ├─ pinned session listed with status "busy"?      → queue, post to room:
   │                                                    "gourav is mid-turn — queued"
   │
   ├─ pinned session alive but idle?                 → run (normal case)
   │
   └─ pinned session not running at all?             → run
```

The queue already exists in `AgentRunner`. This only adds the liveness check in
front of it.

### 3. Room → terminal handoff

**This is the headline feature and the thing Gourav actually asked for.**

A room exchange appends to the pinned session, but a terminal process that was
already open will not see it (finding 5). So Atrium makes the handoff explicit
instead of leaving it to chance.

When a person has room activity their terminal has not picked up, the room shows:

```
  3 room messages went into your session.
  An already-open terminal won't have them.

  Pick them up:   claude --resume 11952de6-6cca-4807-a5bd-f58d8cf1cc3a
```

- The bridge prints the same line on exit.
- If the pinned session is still open in a terminal, it says to close that first,
  because a stale process keeps writing its own branch.
- Counter resets once a new process is seen reading that session.

Continuity for a terminal the person *keeps* open is served by the MCP tools
already built in Session 3 — `room_recent`, `room_memory`, `room_digest`. The
live agent pulls the room on demand rather than needing the file to sync. No new
mechanism required.

### 4. Lobby awareness and attribution

Two requests, one mechanism: wrap the message with who is asking and where the
answer goes.

Today the asker's name reaches the machine and is **thrown away**:
`bridge/src/cli.ts:218` receives `onRun(from, text)`, prints `from` to the
console, then `:253` calls `runner.run(text)` — without it. The agent cannot
tell Gourav's question from Arihant's.

The prompt handed to the agent on stdin becomes:

```
[Atrium · room "echosphere" · 4 people will see your reply]
[From: Arihant Kumar — a teammate, NOT your owner gourav]
[Shared lobby. Your reply is posted publicly to the room. Do not reveal
 file contents, credentials, or personal memory from this machine unless
 gourav asks for it himself, here, in this room.]

Arihant Kumar asks:
<their message>
```

When the owner asks, line 2 reads `[From: gourav — your owner]`.

**Honest limit:** this is a behavioural steer, not a security boundary. It shapes
behaviour reliably in normal use; a determined prompt can talk an agent around
its own instructions. A real boundary is `--room-deny <tools>`, dropping Read and
Bash outside the project folder for room-driven runs. Not built now — four
trusted people — and recorded here as the upgrade path if the room ever opens up.

### 5. Presence is unchanged, and already correct

Verified in `server/src/index.ts:46` and `:286`: members merge **by name**, a
`bridge` role outranks a `viewer`, and `leave` only fires when no connection with
that name remains.

```
                    close tab?   laptop off?
browser tab          gone          gone        ← just a window
bridge (terminal)    ALIVE         gone        ← this is the seat in the room
session file         ALIVE         ALIVE       ← this is the agent's memory
```

So closing the browser does not remove anyone's agent from the room. Documented
here because it was asked, and because the handoff copy depends on it being true.

### 6. Codex

**Reading their work is solved.** Verified 2026-09-05 on a teammate's machine at
commit `b26d60a`, Node 24.19, pnpm 11.19: the existing parser handles Codex
Desktop rollouts with **no changes**. 36 rollouts discovered, 3 live, no
unclassified payload shapes, and — critically — **no doubled answers**, so the
`event_msg` trap holds for the desktop format too.

Two probes, both coherent:

```
newest rollout:   26 lines →  4 turns   prompt=2  response=2
larger rollout:  138 lines → 23 turns   prompt=2  response=4  tool=17
```

⚠️ **This compatibility is empirical, not contractual.** OpenAI does not document
the rollout format. A desktop app update could change it without warning, and the
symptom would be a lane that quietly goes wrong rather than an error. The
`unknownShapes` diagnostic in the parser is what catches that; `pnpm probe --file`
is the tool to re-run when anything looks off.

**One real bug the probe surfaced.** Codex Desktop injects
`<recommended_plugins>` as its own user record, so it posts as a junk prompt at
the start of every session — visible in that `prompt=2` where only one prompt was
a person. `cleanPrompt` (`bridge/src/parse/codex.ts:52`) already strips three
such blobs but not this one, and `:107` drops a prompt whose cleaned text is
empty. So one added `.replace()` removes the turn entirely.

Paired form only — `<recommended_plugins>…</recommended_plugins>` — never a
greedy match to end of string, which would silently eat a real prompt if anyone
ever typed that tag.

**Writing to them: same pinning, different verb.**

| | Claude | Codex |
|---|---|---|
| Prerequisite | already installed | `npm i -g @openai/codex` |
| Pinned send | `claude -p --resume <id>` | `codex exec resume <id>` |
| Live send | not available | `codex queue --thread <id> --message <text>` |

`codex queue` is documented as *"Queue a message for an existing session"* and, if
it reaches a live Codex Desktop session, gives Codex users something Claude Code
cannot do: a message typed in Atrium appears **in their running app**, they watch
it answered there, and the reply streams back through the rollout the bridge is
already tailing. That is the strongest form of "the real agent, present in the
web" available to anyone on this team.

Whether the app's sessions register with the shared `app-server` daemon that
`codex queue` and `codex agents` talk to is **unverified**. Test order once the
CLI is installed:

1. `codex agents` — do the desktop app's live sessions appear?
2. if yes → `codex queue --thread <uuid> --message "test"` — does it land in the app?
3. if no → fall back to `codex exec resume <id>`, which gives them exactly the
   pinned-session behaviour Claude users get.

Either branch delivers the requirement. Only the liveness is at stake.

---

## Non-goals

- **The undocumented messaging pipe.** Every non-`--bare` session publishes a
  `messagingSocketPath` and a key file. It would allow true live delivery into a
  running Claude session. Rejected: undocumented, credential-gated, and
  version-fragile across four machines. Revisit only if `--resume` proves
  insufficient in real use.
- **`--fork-session`.** A fork is precisely the "copy with no memory" this design
  removes.
- **A pty-hosted session.** Would work, needs `node-pty`, and breaks the
  zero-native-deps property that makes Atrium install cleanly for teammates.
- **Durable hosting.** The room still dies with Gourav's laptop. Next problem,
  explicitly deferred.

---

## Failure modes

| Situation | What the room shows |
|---|---|
| Pinned session mid-turn | "gourav is mid-turn — queued" |
| Pinned session deleted | "session gone — repinned to <new>", as a `system` event |
| `claude` not on PATH | existing notice, unchanged |
| Room messages unread by an open terminal | the handoff banner with the exact `--resume` command |
| Transcript already branched | log it once; do not attempt a merge |

Nothing fails silently. That rule was set in Session 4 after @mentions failed
quietly, and it holds here.

---

## Testing

Existing **52 checks must stay green.**

New:

| Test | Asserts |
|---|---|
| pin persistence | a pin survives a bridge restart |
| pin override | `--session <uuid>` wins |
| pin recovery | a deleted pinned session repins and posts a notice |
| liveness | `claude agents --json` is parsed correctly; busy → queued |
| **append, not fork** | a resumed ask lands in the **same** transcript and creates no new file |
| attribution | `from` reaches the prompt — regression guard, it is dropped today |
| header shape | owner vs teammate render differently |

The append-not-fork test is the feature itself, so it asserts on real bytes and
real file counts, not a smoke check.

---

## Open questions

1. ~~Does `codex queue` reach a live Codex Desktop session?~~ **Closed
   2026-09-05 — yes.** Verified on a teammate's Mac: a queued line appeared in
   the open Codex app on its own. It is now the default for Codex, with
   `codex exec resume` as the fallback if a queue fails.

   The bug that forced the test is worth recording: `exec resume` appends to the
   thread behind the app's back, and a running process never re-reads its own
   transcript - so a teammate's mention was answered into the room while their
   Codex window showed nothing at all. That is the same finding that shaped the
   Claude side; Codex Desktop is just another running process.
2. ~~Does the Codex app write to `~/.codex/sessions`?~~ **Closed 2026-09-05** —
   yes, and the existing parser reads them unchanged. See *Verified later the
   same day*.
3. Once a transcript has branched, which leaf does `--resume` follow? Matters
   only if the one-writer rule is broken.
