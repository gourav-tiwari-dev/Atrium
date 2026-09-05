# atrium-lobby

Answers one question: **where is lobby X right now.**

The room runs on a laptop behind a Cloudflare quick tunnel, and that hostname is
new on every `pnpm deploy`. That is why teammates had to be re-issued a join
command every session. This address does not move, so `Join Atrium.cmd` is
handed out once and keeps working.

It stores an address, not a credential. Reading is public — knowing where the
room is gets you nothing without the room token. Writing needs a secret, because
publishing moves where the whole team connects.

## API

```
GET  /lobby/echosphere    ->  200 {"url":"wss://…/ws","updatedAt":1788…}
                              404 {"error":"no lobby named \"echosphere\"…"}

POST /lobby/echosphere    ->  204
     Authorization: Bearer <PUBLISH_SECRET>
     {"url":"wss://…/ws"}   401 wrong or missing secret
                            400 malformed url
```

## One-time deploy

```
npx wrangler login
npx wrangler kv namespace create LOBBIES
```

Paste the printed id into `wrangler.toml` under `[[kv_namespaces]]`, then:

```
npx wrangler secret put PUBLISH_SECRET
npx wrangler deploy
```

Wrangler prints the address, e.g. `https://atrium-lobby.<account>.workers.dev`.

## Then, on the machine that runs `pnpm deploy`

```
setx ATRIUM_RENDEZVOUS https://atrium-lobby.<account>.workers.dev
setx ATRIUM_PUBLISH_SECRET <the same secret you just set>
```

Open a new terminal afterwards — `setx` only affects new ones.

Both are read from the environment. **Neither belongs in this repo.** The secret
is what lets someone move where the entire team connects, and a credential has
already been committed to this repository's history once, on 31 Aug 2026.

## Free tier

Workers allow 100,000 requests/day; KV allows 100,000 reads and 1,000 writes per
day. A write happens once per deploy, a read once per launch or reconnect. Four
people are nowhere near any of it.

## Tests

`node scripts/worker-test.ts` runs the Worker directly with a `Map` in place of
KV — no wrangler, no account, no network. `pnpm test` includes it.
