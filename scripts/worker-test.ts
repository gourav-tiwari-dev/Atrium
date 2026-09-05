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
    get: async (k: string): Promise<string | null> => m.get(k) ?? null,
    put: async (k: string, v: string): Promise<void> => void m.set(k, v),
  };
}

const SECRET = 'test-secret';

function call(
  env: unknown,
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://x.workers.dev${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    }),
    env as never,
  );
}

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
