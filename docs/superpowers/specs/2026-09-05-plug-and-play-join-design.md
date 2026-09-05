# Joining should be a double-click

**Date:** 2026-09-05
**Status:** design approved in outline — awaiting spec review
**Follows:** `2026-09-05-live-session-in-the-room-design.md`

---

## The problem

In the team's words: *"the setup is too complex and bad, everytime they have to
run terminal commands in vs code and all that hassle."* What they want is *"a
standard app where they just put my lobby name and should be able to join"* — a
one-time setup, plug and play.

Today a teammate does this:

| Step | How often |
|---|---|
| install Node 24 + pnpm | once |
| clone the repo, `pnpm install` | once |
| paste a 140-character join command | **every session** |
| keep a terminal open | every session |

Four of the five are one-time. The one that repeats is the one that *changes*.

## The root cause is ours, not theirs

`scripts/deploy.ts:103` builds the join command with the tunnel host baked in:

```
pnpm bridge join --url wss://<host>/ws --room echosphere --token <token> --name YOURNAME --allow-ask
```

`<host>` is a Cloudflare quick tunnel, and it is new on every `pnpm deploy`. So
every redeploy invalidates every teammate's command and someone has to
redistribute it. The team is not doing something wrong; they are absorbing a
defect.

**"Put in the lobby name" requires a fixed place that knows where the lobby is.**
A name cannot resolve to a moving target. So the rendezvous is not a nicety
bolted onto the launcher — it is the thing that makes the launcher possible.

## Why not just host the room somewhere permanent

Checked 2026-09-05, because this was the obvious alternative:

| Option | Finding |
|---|---|
| Render free | ephemeral filesystem; the `node:sqlite` room file is wiped on every spin-down (15 min idle). Fixing it means moving storage to Postgres, and free Render Postgres expires after 30 days |
| Fly.io | free tier is gone — a 2 VM-hour / 7-day trial, then usage billing, ~$2–5/mo minimum plus $0.15/GB for the volume |
| ngrok free | cut in early 2026 to 2-hour sessions and random URLs; static domains are now paid |

Permanent hosting is still the right end state and is planned separately. It is
**not** a faster route to working-today, and it does not remove any of the work
below. The rendezvous makes that migration a one-line config change rather than
another round of redistributing links.

---

## Design

```
  teammate double-clicks "Join Atrium.cmd"
              │
              │  first run only: "what should the room call you?"
              ▼
     ask the rendezvous: where is "echosphere"?
              │
              ▼
     join that address, open the room in the browser
              │
     address changed later? re-ask, reconnect. Nobody is told anything.
```

### 1. The rendezvous — a Cloudflare Worker

A permanent `*.workers.dev` address that answers one question: where is lobby X
right now.

```
GET  /lobby/echosphere        -> { "url": "wss://<host>/ws", "updatedAt": … }
POST /lobby/echosphere        -> stores it   (requires a publish secret)
```

Backed by Workers KV. Free tier is 100,000 requests/day and, for KV, 100,000
reads and 1,000 writes per day. A write happens once per `pnpm deploy`; a read
happens when someone launches or reconnects. Four people will not come close.

The publish secret is a Worker secret (`wrangler secret put`), separate from the
room token, and lives only on Gourav's machine and in Cloudflare. **It never goes
in the repo** — the 31 Aug incident was exactly this class of mistake.

Chosen over a file in the public repo because `raw.githubusercontent.com` caches
for ~5 minutes: teammates would get a dead address right after a redeploy, which
recreates "it doesn't work, ask gourav" — the precise thing being removed.

### 2. `atrium app` — a new bridge subcommand

```
node bridge/src/cli.ts app
```

- Reads `~/.atrium/profile.json` (`{ name, lobby }`). On first run, asks for a
  display name and saves it. Never asks again.
- Resolves the lobby through the rendezvous.
- Joins with `--allow-ask --allow-mentions` already on, because a teammate whose
  agent cannot be reached is not in the room in any useful sense.
- Opens the room in the default browser.
- Prints a short, calm status. This console window IS the app; it should read
  like one, not like a build log.

**The rule that matters: re-resolve on repeated failure.** The existing
`RoomClient` reconnects to the URL it was given. If the address has rotated,
that address is dead forever and it will retry it until the heat death of the
universe. So after N consecutive failures the app must go back to the rendezvous
and ask again. Without this the launcher is today's bug in a nicer wrapper — the
teammate sees "connecting…" forever instead of a stale command, and still ends
up messaging Gourav.

Re-resolve backs off (and is capped) so a rendezvous outage cannot turn four
laptops into a retry storm.

### 3. `Join Atrium.cmd`

A short file at the repo root that runs the subcommand. Double-clickable,
pinnable to the taskbar. It lives in the repo the team already cloned, so today
needs no new infrastructure.

Publishing to npm so the launcher becomes `npx -y atrium-bridge join` — no clone,
no `pnpm install`, auto-updating — is the natural next step and reuses the same
subcommand unchanged.

### 4. `pnpm deploy` publishes

A final step in `scripts/deploy.ts`: after the tunnel is up and health-checked,
POST the new URL to the rendezvous. The existing supervisor already replaces a
dead tunnel, so it publishes again whenever it does.

If publishing fails, deploy **says so loudly and keeps running**. A room that is
up but unannounced is recoverable; a deploy that dies because a Worker was
unreachable is not. Nothing fails silently — the Session 4 rule.

---

## Non-goals

- **A packaged desktop app.** The team explicitly does not care: *"they don't
  care about an app, it just needs to save them the hassle."*
- **Removing local software.** The bridge must read local transcripts and start
  local agents; a web page can do neither. The goal is no *terminal*, not no
  local process.
- **Moving the room off the laptop.** Tracked separately; the rendezvous is what
  makes that migration invisible to teammates.
- **Replacing the room token.** Auth is unchanged. The rendezvous stores an
  address, not a credential.

## Failure modes

| Situation | What happens |
|---|---|
| Rendezvous unreachable at launch | falls back to the last address in the profile, and says it is doing so |
| Address rotated mid-session | re-resolves after repeated failure, reconnects, stays quiet about it |
| Lobby unknown to the rendezvous | plain message naming the lobby it asked for — not a stack trace |
| Publish fails during deploy | deploy continues, prints the address to share manually |
| No Node on the machine | the `.cmd` says what to install rather than flashing a black window |

## Testing

The suite is at 90 checks and must stay green.

| Test | Asserts |
|---|---|
| profile persistence | a name is asked once and never again |
| resolve | a lobby maps to its stored address |
| **re-resolve** | repeated connect failure triggers a fresh lookup, not infinite retries against a dead URL |
| backoff cap | re-resolution is bounded, so a rendezvous outage cannot become a retry storm |
| publish failure | deploy survives and reports it |

The re-resolve test is the one that prevents the complaint recurring, so it
asserts on real behaviour rather than a mock returning success.

## Decided

1. **Worker name: `atrium-lobby`.** So the rendezvous lives at
   `https://atrium-lobby.<account>.workers.dev`, where `<account>` is whatever
   subdomain Cloudflare assigns on signup. Boring and descriptive on purpose —
   it is a permanent address that will be read far more often than it is typed.
2. **The lobby is baked into `Join Atrium.cmd`** (`--lobby echosphere`). A
   teammate types nothing at all after the first run, which is the whole point.
   The profile still stores a lobby, so a second room later is a second `.cmd`
   rather than a redesign.

## Open questions

None blocking. The Cloudflare account subdomain is only knowable once the
account exists, so the resolver reads its base URL from a constant that is set
when the Worker is first deployed.
