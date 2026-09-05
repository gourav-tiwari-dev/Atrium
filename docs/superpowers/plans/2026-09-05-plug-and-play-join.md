# Plug-and-Play Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teammate double-clicks one file and is in the room — no command, no
URL, no re-paste when the tunnel rotates.

**Architecture:** A Cloudflare Worker holds the permanent answer to "where is
lobby X". `pnpm deploy` posts the new tunnel URL to it. A new `atrium app`
subcommand remembers the person's name, resolves the lobby, joins, and — the
part that actually matters — re-resolves when the address it was given goes
dead.

**Tech Stack:** Node 24 native TypeScript (no build step), `ws`, Cloudflare
Workers + Workers KV, `wrangler` invoked via `npx` (never added to package deps).

**Spec:** `docs/superpowers/specs/2026-09-05-plug-and-play-join-design.md`

## Global Constraints

- **Node >= 24.** Native TypeScript, strip-only mode, **no build step**.
- **Node strip-only mode rejects TypeScript parameter properties.**
  `constructor(private x: T)` will not run. Declare fields explicitly.
- **No new runtime dependencies.** Runtime deps stay exactly `ws` and
  `@modelcontextprotocol/sdk`. `wrangler` is run through `npx` for deploying the
  Worker and is never added to `package.json`.
- **Tests are hand-rolled scripts** under `scripts/`, run by `node scripts/x.ts`,
  reporting via a local `check(label, ok, detail)` and exiting non-zero on
  failure. Follow `scripts/session-test.ts` exactly.
- **The 90 existing checks must stay green.** `pnpm test`.
- **Nothing fails silently.** Every failure path prints what happened and what to
  do. Rule set in Session 4; not optional.
- **The publish secret never enters the repo.** It lives in
  `ATRIUM_PUBLISH_SECRET` on Gourav's machine and as a Cloudflare Worker secret.
  A leaked credential in this repo's history is not a hypothetical — it happened
  on 31 Aug 2026.
- **The room token is unchanged.** The rendezvous stores an address, not a
  credential, and grants nothing.
- **On this machine, use the Edit tool, not bash heredocs,** for content
  containing backslashes or regex escapes — heredocs mangle them silently.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/src/index.ts` | **new** — the rendezvous: GET returns a lobby's address, POST stores it |
| `worker/wrangler.toml` | **new** — Worker name (`atrium-lobby`) and KV binding |
| `worker/README.md` | **new** — the one-time deploy steps, including the secret |
| `bridge/src/rendezvous.ts` | **new** — client side: `resolveLobby`, `publishLobby` |
| `bridge/src/profile.ts` | **new** — `{name, lobby, lastUrl}` in `~/.atrium/profile.json` |
| `bridge/src/join.ts` | **new** — `joinRoom(cfg)`: the join flow, lifted out of `cli.ts` so it has no top-level side effects |
| `bridge/src/app.ts` | **new** — the launcher: profile, resolve, join, re-resolve |
| `bridge/src/cli.ts` | modify — `join()` becomes argv → `JoinConfig`, plus the `app` subcommand |
| `Join Atrium.cmd` | **new** — repo root, double-clickable |
| `scripts/deploy.ts` | modify — publish the URL inside `raise()` |
| `scripts/worker-test.ts` | **new** — the Worker's routing and auth, no wrangler needed |
| `scripts/rendezvous-test.ts` | **new** — resolve/publish against a stub server |
| `scripts/app-test.ts` | **new** — profile persistence and **re-resolve on a moved room** |

---

### Task 1: The rendezvous Worker

A Worker is just `fetch(request, env)`. Node 24 has `Request`/`Response`
globals and KV can be a `Map`, so this is testable without wrangler or an
account.

**Files:**
- Create: `worker/src/index.ts`
- Create: `worker/wrangler.toml`
- Create: `worker/README.md`
- Create: `scripts/worker-test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Task 2 (as the HTTP contract, not an import):
  - `GET /lobby/:name` → `200 {"url": string, "updatedAt": number}` or `404 {"error": string}`
  - `POST /lobby/:name` with `Authorization: Bearer <secret>` and body `{"url": string}` → `204`, or `401`, or `400`
  - default export `{ fetch(request: Request, env: Env): Promise<Response> }`
  - `interface Env { LOBBIES: KVNamespace; PUBLISH_SECRET: string }`

- [ ] **Step 1: Write the failing test**

Create `scripts/worker-test.ts`:

```ts
/**
 * The rendezvous Worker: routing, auth, and what it stores.
 *
 * A Worker is just fetch(request, env), so this runs it directly with a Map
 * standing in for KV - no wrangler, no account, no network.
 *
 * Run: node scripts/worker-test.ts
 */
import worker from '../worker/src/index.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function fakeKv() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  };
}

const SECRET = 'test-secret';
const call = (env: any, method: string, path: string, body?: unknown, auth?: string) =>
  worker.fetch(
    new Request(`https://x.workers.dev${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    }),
    env,
  );

async function main(): Promise<void> {
  console.log('\n  atrium worker test\n');
  const kv = fakeKv();
  const env = { LOBBIES: kv, PUBLISH_SECRET: SECRET };

  const missing = await call(env, 'GET', '/lobby/echosphere');
  check('an unknown lobby is a 404, not a crash', missing.status === 404, String(missing.status));
  check('and it says which lobby', JSON.stringify(await missing.json()).includes('echosphere'));

  const noAuth = await call(env, 'POST', '/lobby/echosphere', { url: 'wss://a/ws' });
  check('publishing without the secret is refused', noAuth.status === 401, String(noAuth.status));
  check('and nothing was stored', kv.store.size === 0, String(kv.store.size));

  const wrongAuth = await call(env, 'POST', '/lobby/echosphere', { url: 'wss://a/ws' }, 'nope');
  check('a wrong secret is refused', wrongAuth.status === 401, String(wrongAuth.status));

  const bad = await call(env, 'POST', '/lobby/echosphere', { url: 'not-a-url' }, SECRET);
  check('a malformed url is rejected', bad.status === 400, String(bad.status));

  const ok = await call(env, 'POST', '/lobby/echosphere', { url: 'wss://a.example/ws' }, SECRET);
  check('publishing with the secret works', ok.status === 204, String(ok.status));

  const found = await call(env, 'GET', '/lobby/echosphere');
  const body = (await found.json()) as { url: string; updatedAt: number };
  check('the address reads back', body.url === 'wss://a.example/ws', body.url);
  check('with a timestamp', typeof body.updatedAt === 'number' && body.updatedAt > 0, String(body.updatedAt));

  await call(env, 'POST', '/lobby/echosphere', { url: 'wss://b.example/ws' }, SECRET);
  const moved = (await (await call(env, 'GET', '/lobby/echosphere')).json()) as { url: string };
  check('republishing moves the lobby', moved.url === 'wss://b.example/ws', moved.url);

  const other = await call(env, 'GET', '/lobby/weave');
  check('lobbies are independent', other.status === 404, String(other.status));

  const root = await call(env, 'GET', '/');
  check('an unrouted path is a 404, not a 500', root.status === 404, String(root.status));

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --no-warnings=ExperimentalWarning scripts/worker-test.ts`
Expected: FAIL — `Cannot find module '../worker/src/index.ts'`

- [ ] **Step 3: Write the Worker**

Create `worker/src/index.ts`:

```ts
/**
 * Where is lobby X right now?
 *
 * The room runs on a laptop behind a Cloudflare quick tunnel, and that
 * hostname is new on every deploy. Teammates were re-pasting a fresh join
 * command every session because of it. This is the one address that does not
 * move, so a lobby NAME can mean something.
 *
 * It stores an address, never a credential. Reading is public: knowing where
 * the room is gets you nothing without the room token.
 */

export interface Env {
  LOBBIES: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
  PUBLISH_SECRET: string;
}

interface Entry {
  url: string;
  updatedAt: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function lobbyFrom(pathname: string): string | null {
  const m = /^\/lobby\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const lobby = lobbyFrom(url.pathname);
    if (!lobby) return json({ error: 'not found' }, 404);

    if (request.method === 'GET') {
      const raw = await env.LOBBIES.get(lobby);
      if (!raw) return json({ error: `no lobby named "${lobby}" has been published` }, 404);
      return json(JSON.parse(raw) as Entry, 200);
    }

    if (request.method === 'POST') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      // Publishing moves where everyone connects, so it is the one thing that
      // needs a secret. Reading does not.
      if (!env.PUBLISH_SECRET || token !== env.PUBLISH_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
      let body: { url?: unknown };
      try {
        body = (await request.json()) as { url?: unknown };
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }
      const next = typeof body.url === 'string' ? body.url : '';
      if (!/^wss?:\/\/[^\s]+$/.test(next)) {
        return json({ error: 'url must be a ws:// or wss:// address' }, 400);
      }
      const entry: Entry = { url: next, updatedAt: Date.now() };
      await env.LOBBIES.put(lobby, JSON.stringify(entry));
      return new Response(null, { status: 204 });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning scripts/worker-test.ts`
Expected: 11 PASS, exit 0.

- [ ] **Step 5: Write the Worker config and deploy notes**

Create `worker/wrangler.toml`:

```toml
name = "atrium-lobby"
main = "src/index.ts"
compatibility_date = "2026-09-05"

[[kv_namespaces]]
binding = "LOBBIES"
id = "REPLACE_WITH_THE_ID_WRANGLER_PRINTS"
```

Create `worker/README.md`:

```markdown
# atrium-lobby

Answers "where is lobby X right now". The room's tunnel hostname changes every
deploy; this address does not, so `Join Atrium.cmd` never has to be re-issued.

## One-time deploy

    npx wrangler login
    npx wrangler kv namespace create LOBBIES

Put the printed id into `wrangler.toml` under `[[kv_namespaces]]`, then:

    npx wrangler secret put PUBLISH_SECRET
    npx wrangler deploy

Wrangler prints the address, e.g. `https://atrium-lobby.<account>.workers.dev`.

## Then, on the machine that runs `pnpm deploy`

    setx ATRIUM_RENDEZVOUS https://atrium-lobby.<account>.workers.dev
    setx ATRIUM_PUBLISH_SECRET <the same secret>

Both are read from the environment. **Neither belongs in this repo** - the
secret is what lets someone move where the whole team connects.
```

- [ ] **Step 6: Chain the test in and verify the suite**

Add to `package.json` and append to `"test"`:

```json
"test:worker": "node --no-warnings=ExperimentalWarning scripts/worker-test.ts",
```

Run: `pnpm test`
Expected: 101 PASS (90 + 11), exit 0.

- [ ] **Step 7: Commit**

```bash
git add worker/ scripts/worker-test.ts package.json
git commit -m "A permanent address that says where the lobby is"
```

---

### Task 2: The client side of the rendezvous

**Files:**
- Create: `bridge/src/rendezvous.ts`
- Create: `scripts/rendezvous-test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the HTTP contract from Task 1.
- Produces, used by Tasks 4 and 5:
  - `interface Lobby { url: string; updatedAt: number }`
  - `resolveLobby(base: string, lobby: string, timeoutMs?: number): Promise<Lobby>` — throws `Error` with a human-readable message
  - `publishLobby(base: string, lobby: string, url: string, secret: string, timeoutMs?: number): Promise<void>` — throws on failure
  - `DEFAULT_RENDEZVOUS: string` — read from `ATRIUM_RENDEZVOUS`, else `''`

- [ ] **Step 1: Write the failing test**

Create `scripts/rendezvous-test.ts`:

```ts
/**
 * Resolving and publishing a lobby address, against a real HTTP server
 * standing in for the Worker.
 *
 * Run: node scripts/rendezvous-test.ts
 */
import { createServer, type Server } from 'node:http';
import { resolveLobby, publishLobby } from '../bridge/src/rendezvous.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const SECRET = 'shh';
const store = new Map<string, { url: string; updatedAt: number }>();

function stub(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const m = /^\/lobby\/(.+)$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end('{}'); return; }
    const lobby = m[1];
    if (req.method === 'GET') {
      const hit = store.get(lobby);
      if (!hit) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'nope' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hit));
      return;
    }
    if (req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401).end('{}'); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        store.set(lobby, { url: JSON.parse(body).url, updatedAt: Date.now() });
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(405).end('{}');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      done({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function main(): Promise<void> {
  console.log('\n  atrium rendezvous test\n');
  const { server, base } = await stub();

  let threw = '';
  try { await resolveLobby(base, 'echosphere'); } catch (e) { threw = (e as Error).message; }
  check('an unpublished lobby throws a readable error', threw.length > 0 && threw.toLowerCase().includes('echosphere'), threw);

  let refused = '';
  try { await publishLobby(base, 'echosphere', 'wss://a.example/ws', 'wrong'); } catch (e) { refused = (e as Error).message; }
  check('publishing with a wrong secret throws', refused.length > 0, refused);

  await publishLobby(base, 'echosphere', 'wss://a.example/ws', SECRET);
  const got = await resolveLobby(base, 'echosphere');
  check('a published lobby resolves', got.url === 'wss://a.example/ws', got.url);

  await publishLobby(base, 'echosphere', 'wss://b.example/ws', SECRET);
  const moved = await resolveLobby(base, 'echosphere');
  check('resolving again sees the new address', moved.url === 'wss://b.example/ws', moved.url);

  let down = '';
  try { await resolveLobby('http://127.0.0.1:1', 'echosphere', 800); } catch (e) { down = (e as Error).message; }
  check('an unreachable rendezvous throws rather than hanging', down.length > 0, down.slice(0, 60));

  server.close();
  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --no-warnings=ExperimentalWarning scripts/rendezvous-test.ts`
Expected: FAIL — `Cannot find module '../bridge/src/rendezvous.ts'`

- [ ] **Step 3: Write the implementation**

Create `bridge/src/rendezvous.ts`:

```ts
/**
 * Asking a fixed address where the room currently is.
 *
 * The room's tunnel hostname changes on every deploy. Baking it into a join
 * command is why teammates had to be re-issued one every session. This is the
 * indirection that makes a lobby NAME work - and it keeps working when the room
 * moves to permanent hosting, because only the stored address changes.
 */

export interface Lobby {
  url: string;
  updatedAt: number;
}

/** Set on the machine that runs `pnpm deploy`, and in Join Atrium.cmd. */
export const DEFAULT_RENDEZVOUS = process.env.ATRIUM_RENDEZVOUS ?? '';

function endpoint(base: string, lobby: string): string {
  return `${base.replace(/\/+$/, '')}/lobby/${encodeURIComponent(lobby)}`;
}

export async function resolveLobby(base: string, lobby: string, timeoutMs = 8000): Promise<Lobby> {
  if (!base) throw new Error('no rendezvous address is configured (set ATRIUM_RENDEZVOUS)');

  let res: Response;
  try {
    res = await fetch(endpoint(base, lobby), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`could not reach the rendezvous at ${base}: ${(err as Error).message}`);
  }
  if (res.status === 404) {
    throw new Error(`the rendezvous has no lobby named "${lobby}" - has the room been deployed?`);
  }
  if (!res.ok) throw new Error(`the rendezvous answered ${res.status} for "${lobby}"`);

  const body = (await res.json()) as Partial<Lobby>;
  if (typeof body.url !== 'string' || !body.url) {
    throw new Error(`the rendezvous returned no address for "${lobby}"`);
  }
  return { url: body.url, updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now() };
}

export async function publishLobby(
  base: string,
  lobby: string,
  url: string,
  secret: string,
  timeoutMs = 8000,
): Promise<void> {
  if (!base) throw new Error('no rendezvous address is configured (set ATRIUM_RENDEZVOUS)');
  if (!secret) throw new Error('no publish secret is configured (set ATRIUM_PUBLISH_SECRET)');

  let res: Response;
  try {
    res = await fetch(endpoint(base, lobby), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`could not reach the rendezvous at ${base}: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new Error('the rendezvous refused the publish secret');
  if (!res.ok) throw new Error(`the rendezvous answered ${res.status} when publishing "${lobby}"`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning scripts/rendezvous-test.ts`
Expected: 5 PASS, exit 0.

- [ ] **Step 5: Chain in and commit**

Add `"test:rendezvous": "node --no-warnings=ExperimentalWarning scripts/rendezvous-test.ts",`
to `package.json` and append it to `"test"`.

```bash
pnpm test
git add bridge/src/rendezvous.ts scripts/rendezvous-test.ts package.json
git commit -m "Ask a fixed address where the room is"
```

---

### Task 3: The saved profile

**Files:**
- Create: `bridge/src/profile.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Task 4:
  - `interface Profile { name: string; lobby: string; lastUrl?: string }`
  - `loadProfile(dir?: string): Profile | undefined`
  - `saveProfile(p: Profile, dir?: string): void`

- [ ] **Step 1: Write the implementation**

This mirrors `bridge/src/offsets.ts` and `bridge/src/sessions.ts` exactly - same
home directory, same never-throw discipline. It is tested as part of Task 4,
where it is exercised through the app rather than in isolation; a getter/setter
pair with no behaviour of its own does not earn a separate test cycle.

Create `bridge/src/profile.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * What this person answered the first time they ran the launcher.
 *
 * The whole point is that they are asked once and never again - a teammate who
 * has to retype anything every session is back where they started.
 *
 * `lastUrl` is a fallback, not a cache: if the rendezvous is unreachable at
 * launch, the address that worked last time is a far better guess than failing.
 */

export interface Profile {
  name: string;
  lobby: string;
  /** the address that last worked, used only when the rendezvous is unreachable */
  lastUrl?: string;
}

function profilePath(dir?: string): string {
  return join(dir ?? join(homedir(), '.atrium'), 'profile.json');
}

export function loadProfile(dir?: string): Profile | undefined {
  try {
    const p = JSON.parse(readFileSync(profilePath(dir), 'utf8')) as Partial<Profile>;
    if (typeof p.name !== 'string' || !p.name) return undefined;
    if (typeof p.lobby !== 'string' || !p.lobby) return undefined;
    return { name: p.name, lobby: p.lobby, lastUrl: typeof p.lastUrl === 'string' ? p.lastUrl : undefined };
  } catch {
    return undefined; // first run, or the file was removed
  }
}

export function saveProfile(p: Profile, dir?: string): void {
  const path = profilePath(dir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(p, null, 2));
  } catch {
    // Losing the profile costs one question next launch, not data.
  }
}
```

- [ ] **Step 2: Verify it loads and round-trips**

Run:

```bash
node --no-warnings=ExperimentalWarning -e "
import('./bridge/src/profile.ts').then(({loadProfile,saveProfile})=>{
  const d=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'p-'));
  console.log('empty  ->', loadProfile(d));
  saveProfile({name:'Sahil',lobby:'echosphere'},d);
  console.log('saved  ->', JSON.stringify(loadProfile(d)));
});
"
```

Expected: `empty  -> undefined` then `saved  -> {"name":"Sahil","lobby":"echosphere"}`.

- [ ] **Step 3: Commit**

```bash
git add bridge/src/profile.ts
git commit -m "Remember what the launcher asked once"
```

---

### Task 4: Extract the join flow, then build the launcher on it

This is the task that decides whether the complaint comes back.

**Why the extraction comes first.** `join()` in `cli.ts` does the real work: it
starts the `Bridge` that tails transcripts, wires the `AgentRunner`, opens
offsets, and connects the socket. A launcher that only opened a `RoomClient`
would put a teammate in the room with **no lane and no working agent** — present,
but useless. So `join()`'s behaviour is extracted from its argv parsing, and both
the flag path and the launcher use it.

`pnpm test:ask` already drives `pnpm bridge join` end to end, so it is the
regression guard for this refactor.

**Files:**
- Create: `bridge/src/join.ts` (the extracted flow)
- Modify: `bridge/src/cli.ts` (`join()` becomes argv → `JoinConfig`)
- Create: `bridge/src/app.ts`
- Create: `scripts/app-test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `resolveLobby`, `Lobby` (Task 2); `loadProfile`, `saveProfile`, `Profile` (Task 3).
- Produces, used by Task 5:
  - `interface JoinConfig { url: string; room: string; token: string; name: string; allowAsk: boolean; allowMentions: boolean; askAgent?: 'claude' | 'codex'; askCwd?: string; permissionMode?: string; fullAuto?: boolean; codexLiveQueue?: boolean; session?: string; catchUp?: boolean; thinking?: boolean; quiet?: boolean; onStatus?: (s: 'connecting' | 'open' | 'closed') => void }`
  - `interface JoinHandle { stop(): void }`
  - `joinRoom(cfg: JoinConfig): JoinHandle` — exported from **`bridge/src/join.ts`**, NOT from `cli.ts`
  - `interface AppOptions { lobby: string; token: string; rendezvous: string; profileDir?: string; ask: (question: string) => Promise<string>; openBrowser: (url: string) => void; onLine: (text: string) => void; maxReconnectsBeforeReresolve?: number }`
  - `interface AppHandle { stop(): void; currentUrl(): string; resolveCount(): number }`
  - `startApp(opts: AppOptions): Promise<AppHandle>`
  - `openInBrowser(url: string): void`

- [ ] **Step 1: Extract `joinRoom` from `join()`**

Move the body of `join()` into a NEW file, `bridge/src/join.ts`. Everything it
does today stays exactly the same - only where the values come from changes.

**It must be a separate module, not an export from `cli.ts`.** `cli.ts` runs its
`switch (cmd)` at top level, so anything importing it would execute the CLI
dispatch as a side effect - which would make `app.ts` unimportable and break
`app-test.ts` before it ran a single check.

Export the config and the handle:

```ts
export interface JoinConfig {
  url: string;
  room: string;
  token: string;
  name: string;
  allowAsk: boolean;
  allowMentions: boolean;
  askAgent?: AgentKind;
  askCwd?: string;
  permissionMode?: string;
  fullAuto?: boolean;
  codexLiveQueue?: boolean;
  session?: string;
  catchUp?: boolean;
  thinking?: boolean;
  /** the launcher prints its own short status, so skip the banner and stats line */
  quiet?: boolean;
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void;
}

export interface JoinHandle {
  stop(): void;
}
```

In `join.ts`, name it `joinRoom(cfg: JoinConfig): JoinHandle` and replace every
`val('--x')` / `has('--x')` from the old body with the matching `cfg` field. It
imports what it needs directly (`Bridge`, `RoomClient`, `AgentRunner`,
`openOffsets`, `openPin`) rather than reaching back into `cli.ts`. Three specific changes beyond the mechanical substitution:

1. Guard the banner and the periodic stats line with `if (!cfg.quiet)`.
2. In the `onStatus` handler, call `cfg.onStatus?.(s)` as well as the existing
   console output.
3. Replace the `process.on('SIGINT', shutdown)` registration and the
   `--seconds` timer with a returned handle, so a caller can stop it:

```ts
  return {
    stop(): void {
      shutdown();
    },
  };
```

Then `join()` in `cli.ts` becomes only argv parsing, importing `joinRoom` from
the new module:

```ts
function join(): void {
  const url = val('--url') ?? 'ws://localhost:8787/ws';
  const room = val('--room') ?? 'atrium';
  const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';
  const name = val('--name') ?? (userInfo().username || hostname());

  if (!token) {
    console.error(C.red('\n  --token is required (or set ATRIUM_TOKEN).'));
    console.error(C.dim('  Everyone in the room uses the same one; it is what keeps the room private.\n'));
    process.exit(1);
  }

  const handle = joinRoom({
    url,
    room,
    token,
    name,
    allowAsk: has('--allow-ask'),
    allowMentions: has('--allow-mentions'),
    askAgent: val('--ask-agent') as AgentKind | undefined,
    askCwd: val('--ask-cwd'),
    permissionMode: val('--ask-permission-mode'),
    fullAuto: has('--full-auto'),
    codexLiveQueue: has('--codex-live-queue'),
    session: val('--session'),
    catchUp: !has('--no-catch-up'),
    thinking: has('--thinking'),
  });

  const seconds = Number(val('--seconds') ?? 0);
  if (seconds > 0) setTimeout(() => handle.stop(), seconds * 1000);
  process.on('SIGINT', () => handle.stop());
}
```

Note `shutdown()` currently ends with `process.exit(0)`. Keep that for the CLI
path, but move it out of `joinRoom` into the `join()` SIGINT handler — the
launcher stops and restarts a join without the process dying:

```ts
  process.on('SIGINT', () => {
    handle.stop();
    process.exit(0);
  });
```

- [ ] **Step 2: Prove the refactor changed nothing**

Run: `pnpm test` — expected: 101 PASS, exit 0.
Run: `pnpm test:ask` — expected: all checks pass, exit 0.

`test:ask` spawns the real `pnpm bridge join` and drives a real agent run
through it, so a green run here means the extraction preserved the behaviour.
If it fails, the refactor is wrong — fix it before continuing rather than
building the launcher on a broken join.

- [ ] **Step 3: Write the failing launcher test**

Create `scripts/app-test.ts`. The important case is the last one: the room
moves, and the launcher finds it without anyone being told anything.

```ts
/**
 * The launcher: asked once, then never again - and it survives the room moving.
 *
 * RoomClient reconnects to the URL it was handed. When the tunnel rotates that
 * URL is dead forever, so reconnecting alone would retry a corpse indefinitely
 * and the teammate would sit on "connecting..." - today's bug in a nicer
 * wrapper. The last two checks are the ones that prevent that.
 *
 * Run: node scripts/app-test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startApp } from '../bridge/src/app.ts';
import { loadProfile } from '../bridge/src/profile.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TOKEN = 'app-token';
const LOBBY = 'apptest';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** the stub rendezvous - one mutable answer */
function rendezvous(initial: string): Promise<{ server: Server; base: string; move: (u: string) => void }> {
  let current = initial;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: current, updatedAt: Date.now() }));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      done({ server, base: `http://127.0.0.1:${port}`, move: (u) => { current = u; } });
    });
  });
}

function startRoom(port: number, db: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(port), ATRIUM_DB: db }, stdio: 'ignore' },
  );
}

async function waitHealthy(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error(`room on ${port} never came up`);
}

async function main(): Promise<void> {
  console.log('\n  atrium app test\n');
  const dir = mkdtempSync(join(tmpdir(), 'atrium-app-'));
  const portA = 8791;
  const portB = 8792;

  const roomA = startRoom(portA, join(dir, 'a.sqlite'));
  await waitHealthy(portA);
  const rv = await rendezvous(`ws://127.0.0.1:${portA}/ws`);

  let asked: string[] = [];
  let opened: string[] = [];
  const app = await startApp({
    lobby: LOBBY,
    token: TOKEN,
    rendezvous: rv.base,
    profileDir: dir,
    ask: async (q) => { asked.push(q); return 'Sahil'; },
    openBrowser: (u) => opened.push(u),
    onLine: () => {},
    maxReconnectsBeforeReresolve: 2,
  });
  await sleep(1500);

  check('it asked for a name on the first run', asked.length === 1, JSON.stringify(asked));
  check('and saved it', loadProfile(dir)?.name === 'Sahil', JSON.stringify(loadProfile(dir)));
  check('it saved the lobby too', loadProfile(dir)?.lobby === LOBBY, String(loadProfile(dir)?.lobby));
  check('it opened the room in a browser', opened.length === 1 && opened[0].includes(String(portA)), JSON.stringify(opened));
  check('it connected to the address the rendezvous gave', app.currentUrl().includes(String(portA)), app.currentUrl());

  app.stop();
  await sleep(300);

  // second run: the profile exists, so nothing is asked
  asked = [];
  opened = [];
  const again = await startApp({
    lobby: LOBBY, token: TOKEN, rendezvous: rv.base, profileDir: dir,
    ask: async (q) => { asked.push(q); return 'ShouldNotBeAsked'; },
    openBrowser: (u) => opened.push(u),
    onLine: () => {},
    maxReconnectsBeforeReresolve: 2,
  });
  await sleep(1200);
  check('a second run asks nothing', asked.length === 0, JSON.stringify(asked));
  check('and still uses the saved name', loadProfile(dir)?.name === 'Sahil');

  // THE ONE THAT MATTERS: the room moves.
  const roomB = startRoom(portB, join(dir, 'b.sqlite'));
  await waitHealthy(portB);
  rv.move(`ws://127.0.0.1:${portB}/ws`);
  roomA.kill();

  const before = again.resolveCount();
  let landed = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (again.currentUrl().includes(String(portB))) { landed = true; break; }
  }
  check('the room moved and the launcher followed it', landed, again.currentUrl());
  check('because it asked the rendezvous again', again.resolveCount() > before,
    `${before} -> ${again.resolveCount()}`);

  again.stop();
  roomB.kill();
  await sleep(300);
  rv.server.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --no-warnings=ExperimentalWarning scripts/app-test.ts`
Expected: FAIL — `Cannot find module '../bridge/src/app.ts'`

- [ ] **Step 5: Write the launcher**

Create `bridge/src/app.ts`:

```ts
import { spawn } from 'node:child_process';
import { joinRoom, type JoinHandle } from './join.ts';
import { resolveLobby } from './rendezvous.ts';
import { loadProfile, saveProfile, type Profile } from './profile.ts';

/**
 * The launcher a teammate double-clicks.
 *
 * The complaint this exists to fix: "everytime they have to run terminal
 * commands". The cause was ours - `pnpm deploy` bakes a rotating tunnel host
 * into the join command, so every redeploy invalidated everyone's command.
 *
 * So the address is never typed. It is asked for, and - the part that actually
 * matters - asked for AGAIN when it stops working. RoomClient reconnects to the
 * URL it was handed; if the tunnel rotated, that URL is dead forever and it
 * would retry it until someone gives up and messages Gourav. Re-resolving is
 * what makes this a fix rather than a nicer wrapper around the same failure.
 *
 * It runs the SAME join flow the CLI does, so the person gets a real lane and a
 * working agent - not just a socket.
 */

export interface AppOptions {
  lobby: string;
  token: string;
  rendezvous: string;
  /** override the profile location; tests use this */
  profileDir?: string;
  ask: (question: string) => Promise<string>;
  openBrowser: (url: string) => void;
  onLine: (text: string) => void;
  /** consecutive drops before going back to the rendezvous */
  maxReconnectsBeforeReresolve?: number;
}

export interface AppHandle {
  stop(): void;
  currentUrl(): string;
  /** how many times the rendezvous has been asked - the re-resolve test reads this */
  resolveCount(): number;
}

/** the browser page for a ws address, with the room and token already in it */
export function pageFor(wsUrl: string, lobby: string, token: string): string {
  const http = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  return `${http}/?room=${encodeURIComponent(lobby)}&token=${encodeURIComponent(token)}`;
}

export function openInBrowser(url: string): void {
  // start "" is what opens the default browser on Windows; the empty title
  // argument is required or the URL is swallowed as the window title.
  const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    /* no shell association: the URL was printed too, so this is not fatal */
  });
  child.unref();
}

export async function startApp(opts: AppOptions): Promise<AppHandle> {
  const limit = opts.maxReconnectsBeforeReresolve ?? 4;

  let profile = loadProfile(opts.profileDir);
  if (!profile) {
    const answer = (await opts.ask('What should the room call you? ')).trim();
    profile = { name: answer || 'someone', lobby: opts.lobby };
    saveProfile(profile, opts.profileDir);
  } else if (profile.lobby !== opts.lobby) {
    profile = { ...profile, lobby: opts.lobby };
    saveProfile(profile, opts.profileDir);
  }
  const me: Profile = profile;

  let url = '';
  let resolves = 0;
  let stopped = false;
  let handle: JoinHandle | null = null;
  let drops = 0;
  let announced = false;

  async function findRoom(): Promise<string> {
    resolves++;
    try {
      const lobby = await resolveLobby(opts.rendezvous, opts.lobby);
      saveProfile({ ...me, lastUrl: lobby.url }, opts.profileDir);
      return lobby.url;
    } catch (err) {
      // A rendezvous outage should not strand someone whose room has not moved.
      if (me.lastUrl) {
        opts.onLine('could not reach the rendezvous — trying the address that worked last time');
        return me.lastUrl;
      }
      throw err;
    }
  }

  function reresolve(): void {
    void (async () => {
      if (stopped) return;
      try {
        const next = await findRoom();
        if (next === url) return; // same address; the client keeps retrying it
        opts.onLine('the room moved — reconnecting');
        url = next;
        connect();
      } catch (err) {
        opts.onLine(`still looking for the room: ${(err as Error).message}`);
      }
    })();
  }

  function connect(): void {
    if (stopped) return;
    handle?.stop();
    handle = joinRoom({
      url,
      room: opts.lobby,
      token: opts.token,
      name: me.name,
      // A teammate whose agent cannot be reached is not really in the room.
      allowAsk: true,
      allowMentions: true,
      catchUp: true,
      quiet: true,
      onStatus: (s) => {
        if (s === 'open') {
          drops = 0;
          if (!announced) {
            announced = true;
            const page = pageFor(url, opts.lobby, opts.token);
            opts.onLine(`connected as ${me.name}`);
            opts.onLine(page);
            opts.openBrowser(page);
          }
          return;
        }
        if (s === 'closed' && !stopped) {
          drops++;
          if (drops >= limit) {
            drops = 0;
            reresolve();
          }
        }
      },
    });
  }

  url = await findRoom();
  opts.onLine(`joining ${opts.lobby}…`);
  connect();

  return {
    stop(): void {
      stopped = true;
      handle?.stop();
    },
    currentUrl: () => url,
    resolveCount: () => resolves,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning scripts/app-test.ts`
Expected: 9 PASS, exit 0. The last two are the ones that matter — the room moved
from port 8791 to 8792 and the launcher followed it without being told.

If `the room moved and the launcher followed it` fails, do not raise the
timeout to make it pass. The failure means re-resolution is not firing, which is
the entire feature.

- [ ] **Step 7: Chain in and commit**

Add `"test:app": "node --no-warnings=ExperimentalWarning scripts/app-test.ts",`
to `package.json` and append it to `"test"`.

```bash
pnpm test
pnpm test:ask
git add bridge/src/join.ts bridge/src/cli.ts bridge/src/app.ts scripts/app-test.ts package.json
git commit -m "Follow the room when it moves, instead of retrying a dead address"
```

---

### Task 5: The double-click, and deploy publishing

**Files:**
- Modify: `bridge/src/cli.ts` (add the `app` subcommand + help)
- Create: `Join Atrium.cmd`
- Modify: `scripts/deploy.ts` (publish inside `raise()`)

**Interfaces:**
- Consumes: `startApp`, `openInBrowser` (Task 4); `publishLobby` (Task 2). `app.ts` and `cli.ts` both import `joinRoom` from `join.ts`, so neither imports the other and there is no cycle.
- Produces: the `app` subcommand.

- [ ] **Step 1: Add the `app` subcommand to the CLI**

In `bridge/src/cli.ts`, add this function next to `join()`:

```ts
async function app(): Promise<void> {
  const lobby = val('--lobby') ?? 'echosphere';
  const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';
  const rendezvous = val('--rendezvous') ?? process.env.ATRIUM_RENDEZVOUS ?? '';

  console.log(C.bold('\n  Atrium'));
  if (!token) {
    console.error(C.red('\n  This launcher is missing the room token.'));
    console.error(C.dim('  Ask Gourav for an updated "Join Atrium.cmd".\n'));
    process.exit(1);
  }
  if (!rendezvous) {
    console.error(C.red('\n  This launcher does not know where to look for the room.'));
    console.error(C.dim('  Ask Gourav for an updated "Join Atrium.cmd".\n'));
    process.exit(1);
  }

  const { startApp, openInBrowser } = await import('./app.ts');
  const { createInterface } = await import('node:readline/promises');

  const handle = await startApp({
    lobby,
    token,
    rendezvous,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`  ${question}`);
      rl.close();
      return answer;
    },
    openBrowser: openInBrowser,
    onLine: (text) => console.log(`  ${C.dim(text)}`),
  });

  console.log(C.dim('\n  Leave this window open. Close it when you are done.\n'));
  process.on('SIGINT', () => {
    handle.stop();
    console.log(C.dim('\n  left the room\n'));
    process.exit(0);
  });
}
```

Add to the `switch (cmd)` block, next to `case 'join'`:

```ts
  case 'app':
    await app();
    break;
```

And to the help text, above the `flags` block:

```
  ${C.bold('app')}                       join the lobby with one command - what Join Atrium.cmd runs
```

- [ ] **Step 2: Verify the guard rails fire**

Run: `node --no-warnings=ExperimentalWarning bridge/src/cli.ts app --lobby echosphere`
Expected: exits 1 with "missing the room token", because no token was given —
a plain sentence naming what to do, not a stack trace.

- [ ] **Step 3: Write the launcher**

Create `Join Atrium.cmd` at the repo root. `%~dp0` is the folder this file is
in, so it works wherever the repo was cloned:

```bat
@echo off
title Atrium
cd /d "%~dp0"
where node >nul 2>nul || (
  echo.
  echo   Atrium needs Node.js 24 or newer.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
set ATRIUM_RENDEZVOUS=https://atrium-lobby.REPLACE.workers.dev
node --no-warnings=ExperimentalWarning "bridge\src\cli.ts" app --lobby echosphere --token REPLACE_WITH_ROOM_TOKEN
echo.
pause
```

Two values must be filled in before sharing it: the Worker address printed by
`npx wrangler deploy`, and the room token from `.atrium/room.json`. This file
therefore carries the room token — it is the join credential, exactly as the old
join command was, and it is shared the same way. **It must not be committed.**

- [ ] **Step 4: Keep the launcher out of git**

Add to `.gitignore`:

```
Join Atrium.cmd
```

Then create `Join Atrium.cmd.template` with the same content and the two
`REPLACE` values left in place, and commit **that** instead. The template is
what lives in the repo; the filled-in copy is what gets shared with the team.

- [ ] **Step 5: Publish the address from deploy**

In `scripts/deploy.ts`, inside `raise()`, immediately after `banner(url, cfg, attempt);`:

```ts
      await announce(url, cfg);
```

And add this function above `main()`:

```ts
/**
 * Tell the rendezvous where the room is now.
 *
 * This is what stops teammates being re-issued a join command every deploy.
 * The supervisor calls raise() again when it replaces a dead tunnel, so a
 * replacement is announced the same way the first one is.
 */
async function announce(publicUrl: string, cfg: RoomConfig): Promise<void> {
  const base = process.env.ATRIUM_RENDEZVOUS ?? '';
  const secret = process.env.ATRIUM_PUBLISH_SECRET ?? '';
  if (!base || !secret) {
    console.log(C.dim('  (no rendezvous configured - teammates will need the link above)'));
    return;
  }
  const wsUrl = `${publicUrl.replace(/^http/, 'ws')}/ws`;
  try {
    const { publishLobby } = await import(join(ROOT, 'bridge', 'src', 'rendezvous.ts'));
    await publishLobby(base, cfg.room, wsUrl, secret);
    console.log(C.green(`  ● announced ${cfg.room} — Join Atrium.cmd will find it`));
  } catch (err) {
    // A room that is up but unannounced is recoverable. A deploy that dies
    // because a Worker was unreachable is not.
    console.log(C.yellow(`  ! could not announce the room: ${(err as Error).message}`));
    console.log(C.dim('    the room is running; share the link above until this is fixed'));
  }
}
```

- [ ] **Step 6: Verify end to end**

With `ATRIUM_RENDEZVOUS` and `ATRIUM_PUBLISH_SECRET` set, run `pnpm deploy`.
Expected: `● announced echosphere — Join Atrium.cmd will find it`. Then, in a
browser, `https://atrium-lobby.<account>.workers.dev/lobby/echosphere` returns
the current `wss://` address. Then double-click `Join Atrium.cmd`: it asks for a
name once, opens the room, and shows the lane. Run it a second time: no
question.

- [ ] **Step 7: Commit**

```bash
pnpm test
git add bridge/src/cli.ts scripts/deploy.ts .gitignore "Join Atrium.cmd.template"
git commit -m "Double-click to join, and announce where the room is"
```

---

## Self-review notes

**Spec coverage.** Rendezvous Worker → Task 1. Client resolve/publish → Task 2.
Profile → Task 3. `atrium app` + re-resolve + browser open → Task 4.
`Join Atrium.cmd` → Task 5. Deploy publishes, including on tunnel replacement →
Task 5. Failure modes: rendezvous unreachable → Task 4 (`lastUrl` fallback);
address rotated → Task 4 (the re-resolve test); unknown lobby → Task 2 (readable
error); publish fails → Task 5 (`announce` catches); no Node → Task 5 (the
`where node` guard in the `.cmd`).

**Not covered on purpose.** Publishing to npm so the launcher needs no clone —
the spec lists it as the next step, and `startApp` is unchanged by it. Moving the
room to permanent hosting — separate work; it becomes one `publishLobby` call
with a different URL.

**Secret handling.** `ATRIUM_PUBLISH_SECRET` is read from the environment in
both directions and never written to a repo file. `Join Atrium.cmd` carries the
room token and is gitignored; only the `.template` is committed.
