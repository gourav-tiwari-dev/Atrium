/**
 * The launcher: asked once, then never again - and it survives the room moving.
 *
 * RoomClient reconnects to the URL it was handed. When the tunnel rotates, that
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
import { startApp, browserOpener } from '../bridge/src/app.ts';
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
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`room on ${port} never came up`);
}

async function main(): Promise<void> {
  console.log('\n  atrium app test\n');
  // Opening the room is per-platform. Getting this wrong on a teammate's Mac
  // means they connect and nothing appears, which reads as "it is broken".
  const win = browserOpener('http://x/', 'win32');
  check('windows uses start with an empty title',
    win.cmd === 'cmd' && win.args.join('|') === '/c|start||http://x/', `${win.cmd} ${win.args.join(' ')}`);
  const mac = browserOpener('http://x/', 'darwin');
  check('mac uses open', mac.cmd === 'open' && mac.args[0] === 'http://x/', `${mac.cmd} ${mac.args.join(' ')}`);
  const nix = browserOpener('http://x/', 'linux');
  check('linux uses xdg-open', nix.cmd === 'xdg-open' && nix.args[0] === 'http://x/', `${nix.cmd} ${nix.args.join(' ')}`);

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
  await sleep(400);

  // second run: the profile exists, so nothing is asked
  asked = [];
  opened = [];
  const again = await startApp({
    lobby: LOBBY,
    token: TOKEN,
    rendezvous: rv.base,
    profileDir: dir,
    ask: async (q) => { asked.push(q); return 'ShouldNotBeAsked'; },
    openBrowser: (u) => opened.push(u),
    onLine: () => {},
    maxReconnectsBeforeReresolve: 2,
  });
  await sleep(1500);
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
    if (again.currentUrl().includes(String(portB))) {
      landed = true;
      break;
    }
  }
  check('the room moved and the launcher followed it', landed, again.currentUrl());
  check('because it asked the rendezvous again', again.resolveCount() > before, `${before} -> ${again.resolveCount()}`);

  again.stop();
  roomB.kill();
  await sleep(300);
  rv.server.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
