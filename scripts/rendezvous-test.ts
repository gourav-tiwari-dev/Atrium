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
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const lobby = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const hit = store.get(lobby);
      if (!hit) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'nope' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hit));
      return;
    }
    if (req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += String(c);
      });
      req.on('end', () => {
        store.set(lobby, { url: (JSON.parse(body) as { url: string }).url, updatedAt: Date.now() });
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(405, { 'content-type': 'application/json' }).end('{}');
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
  try {
    await resolveLobby(base, 'echosphere');
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    'an unpublished lobby throws a readable error',
    threw.length > 0 && threw.includes('echosphere'),
    threw,
  );

  let refused = '';
  try {
    await publishLobby(base, 'echosphere', 'wss://a.example/ws', 'wrong');
  } catch (e) {
    refused = (e as Error).message;
  }
  check('publishing with a wrong secret throws', refused.length > 0, refused);

  await publishLobby(base, 'echosphere', 'wss://a.example/ws', SECRET);
  const got = await resolveLobby(base, 'echosphere');
  check('a published lobby resolves', got.url === 'wss://a.example/ws', got.url);

  await publishLobby(base, 'echosphere', 'wss://b.example/ws', SECRET);
  const moved = await resolveLobby(base, 'echosphere');
  check('resolving again sees the new address', moved.url === 'wss://b.example/ws', moved.url);

  let noBase = '';
  try {
    await resolveLobby('', 'echosphere');
  } catch (e) {
    noBase = (e as Error).message;
  }
  check('an unconfigured rendezvous says so', noBase.includes('ATRIUM_RENDEZVOUS'), noBase);

  let down = '';
  try {
    await resolveLobby('http://127.0.0.1:1', 'echosphere', 800);
  } catch (e) {
    down = (e as Error).message;
  }
  check('an unreachable rendezvous throws rather than hanging', down.length > 0, down.slice(0, 50));

  server.close();
  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
