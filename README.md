# Atrium

**A live room for people and their AI agents.**

Four people, four different AI subscriptions, one project. Everybody's agent
knows only its owner's slice, so the team burns time sharing screens and
re-explaining the same context to each other's AI.

Atrium puts everyone in one room — agents included. Every prompt and every
agent response appears live for the whole team, the team's decisions sit on
screen where **the agents themselves can read them**, and people talk in the
same place.

```
┌──────────── each teammate's machine ─────────────┐
│  Claude Code / Codex ──writes──▶ session.jsonl   │
│         ▲                             │          │
│         │                          tail          │
│         │                             ▼          │
│         │                    ╔═════════════════╗ │
│         └─── MCP ────────────╢     BRIDGE      ║ │   atrium join
│      room_context            ║  tail + parse   ║ │
│      room_recent             ╚════════╤════════╝ │
│      room_inbox                       │          │
└───────────────────────────────────────┼──────────┘
                                        │ websocket
                    ┌───────────────────▼────────────────┐
                    │   SERVER   node + ws + sqlite      │
                    │  presence · append-only event log  │
                    └───────────────────┬────────────────┘
                                        │
                    ┌───────────────────▼────────────────┐
                    │   THE SCREEN   one html file       │
                    │  decisions · live lanes · people   │
                    └────────────────────────────────────┘
```

## Why it tails a file instead of using a hook

The obvious build is a `Stop` hook that posts each answer to the server. It
works on Codex and **silently fails on Claude Code**:

| | Claude Code | Codex CLI |
|---|---|---|
| `Stop` hands you the response text | no — [#10610](https://github.com/anthropics/claude-code/issues/10610) | yes, `last_assistant_message` |
| `Stop` timing | fires before the message reaches the transcript; `transcript_path` goes stale ([#8564](https://github.com/anthropics/claude-code/issues/8564)) | clean |

Both tools stream a JSONL transcript to disk in real time, so Atrium follows
that instead. Race-free, vendor-neutral, catches tool calls too, and needs zero
cooperation from the agent.

## Requirements

Node 24+ (TypeScript runs natively — there is no build step). That's it.

```bash
pnpm install
```

## Run it

**One person hosts the room and puts it on the internet:**

```bash
pnpm deploy
```

That starts the server, opens a Cloudflare quick tunnel in front of it (no
account needed), and prints the link, room and token to send the team. It also
writes them to `JOIN.txt`. The room and token are saved in `.atrium/room.json`
and survive restarts; the tunnel link is new each time.

`pnpm server` alone runs it on localhost only.

**Everyone — including the host — runs one command:**

```bash
pnpm bridge join --room echosphere --token OUR_SHARED_SECRET --name gourav
```

That's the whole setup. It finds Claude Code and Codex transcripts on that
machine by itself and starts streaming.

**Everyone opens the URL** and enters the same room + token.

## Let your agent read the room

This is the half that removes the re-explaining. Add Atrium as an MCP server and
your agent gets `room_context`, `room_recent` and `room_inbox`.

**Claude Code**

```bash
claude mcp add atrium -- node C:/Users/gourav/Projects/atrium/bridge/src/cli.ts mcp \
  --origin http://localhost:8787 --room echosphere --token OUR_SHARED_SECRET --name gourav
```

**Codex** — in `~/.codex/config.toml` (must be the **global** config; repo-local
hooks and servers do not fire in interactive sessions, [openai/codex#17532](https://github.com/openai/codex/issues/17532))

```toml
[mcp_servers.atrium]
command = "node"
args = [
  "C:/Users/gourav/Projects/atrium/bridge/src/cli.ts", "mcp",
  "--origin", "http://localhost:8787",
  "--room", "echosphere",
  "--token", "OUR_SHARED_SECRET",
  "--name", "meera",
]
```

Then ask a brand-new session *"what did the team decide about floor control?"*
and it answers without anyone re-typing anything.

| tool | gives the agent |
|---|---|
| `room_context` | the pinned decisions and who is in the room |
| `room_recent` | what everyone else's agent recently said and ran |
| `room_inbox` | messages other people addressed to this agent |

## Talking to someone else's agent

Type `@meera do X` (or `@meera-agent do X`) in the room.

| target runs | what happens |
|---|---|
| Codex | injected into the running session via `codex queue` — pass `--codex-session <name>` to the bridge |
| Claude Code | no cross-machine injection exists, so it waits in `room_inbox` and their agent picks it up on its next read |

Either way the message is in the room and nothing is lost.

## Typing to your agent from the browser

You don't have to go back to the terminal to talk to your own AI. Each person's
lane has an input box; whatever you type there runs through your agent, and the
answer appears in the room for everyone, exactly like an interactive turn.

It is **off by default**. Opt in when you start your bridge:

```bash
pnpm bridge join --room echosphere --token SECRET --name gourav --allow-ask
```

The reply is not captured by the runner. Both CLIs append the exchange to the
transcript the bridge is already tailing, so the answer reaches the room the
same way everything else does.

| flag | what it does | default |
|---|---|---|
| `--allow-ask` | let the room run prompts through your agent | off |
| `--ask-agent claude\|codex` | which CLI to drive | whichever spoke most recently |
| `--ask-cwd <path>` | folder the agent runs in | the folder of the session being tailed |
| `--ask-permission-mode <m>` | Claude Code permission mode | `auto` |
| `--full-auto` | Codex: allow writes and commands instead of read-only | off |
| `--fresh` | start a new conversation instead of continuing the last one | continues |

**Read this before turning it on.** With `--allow-ask`, a prompt typed in the
browser starts a real agent run on your machine, with whatever tool access the
permission mode grants. The server only routes a prompt to the bridge whose
`--name` matches the sender, but names are claimed, not proven — anyone holding
the room token can claim yours. That is acceptable for four teammates who trust
each other and is not acceptable for a room whose token has leaked. The prompt
is passed to the CLI on stdin, never on a command line, so its contents cannot
become shell commands.

## Privacy

The bridge broadcasts what your agent says, so this matters:

- **`Ctrl+P`** pauses streaming. Nothing leaves the machine until you press it again.
- Any prompt containing **`#private`** is never sent.
- API keys, tokens, JWTs and private keys are stripped before sending
  (`bridge/src/redact.ts`). It is a coarse net — a false positive costs a masked
  string, a false negative leaks a key, so it errs toward masking.
- Reasoning/thinking blocks are **off** by default (`--thinking` to include them).
- The server stores plaintext and the room token is the only gate. That is fine
  for four teammates. It is not a secrets vault.

## Commands

```
atrium join   --room R --token T [--name you] [--url ws://host/ws] [--allow-ask]
atrium mcp    --room R --token T [--origin http://host] [--name you]
atrium probe                      list every transcript on this machine
atrium probe --live               follow sessions locally, send nothing
atrium probe --file <path>        parse one transcript end to end
```

## Tests

```bash
pnpm test:tail    # the tailer: appends, partial lines, truncation
pnpm test:smoke   # the server protocol over real sockets
pnpm test:mcp     # an agent told nothing can read the team's decisions
pnpm test:ask     # browser -> your agent -> back into the room (calls the model once)
pnpm test:e2e     # your real live session -> server -> another client
pnpm demo         # a seeded room to look at
```

`test:e2e` needs a Claude Code or Codex session open and doing something while
it runs — it is watching your actual transcripts.

## Layout

```
server/src/index.ts        http + websocket + read API
server/src/db.ts           node:sqlite append-only event log
server/src/protocol.ts     wire format shared by all three parts
bridge/src/cli.ts          join / mcp / probe
bridge/src/bridge.ts       discover -> tail -> parse -> redact -> emit
bridge/src/tail.ts         follow a growing file without losing or repeating
bridge/src/parse/claude.ts Claude Code transcript -> Turn
bridge/src/parse/codex.ts  Codex rollout -> Turn
bridge/src/mcp.ts          room_context / room_recent / room_inbox
bridge/src/runner.ts       runs a browser-typed prompt through the local CLI
web/dist/index.html        the whole UI, one file, no build
```

### Parsing notes worth keeping

Both parsers were written against real transcripts, and both have a trap:

- **Claude Code**: a `type:"user"` record is usually *not* a human. In one real
  2.6 MB file, 205 user records were `tool_result` feedback and only 54 were
  actual prompts. Also skip `isSidechain: true` or every subagent floods the lane.
- **Codex**: `event_msg/agent_message` duplicates `response_item/message/assistant`
  exactly. Consume `response_item` only, or every answer appears twice.

## Known gaps

- A dropped mention to a Claude Code teammate is delivered lazily, not pushed.
- The first `test:e2e` run of a session reported zero turns once and every run
  since has passed; the cause was never pinned down, so the tailer has its own
  regression test (`test:tail`) to catch it if it is real.
- No auth beyond the shared room token, by choice.
#   A t r i u m 
 
 