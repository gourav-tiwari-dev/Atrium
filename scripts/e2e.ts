/**
 * The whole pipe, for real: server -> bridge -> room -> viewer.
 *
 * Boots the server, starts a real `atrium join` against the transcripts this
 * machine is actually writing, and connects a viewer socket. Whatever the
 * agent does while this runs should show up in the viewer.
 *
 * Run: node --no-warnings=ExperimentalWarning scripts/e2e.ts [seconds]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, RoomEvent } from '../server/src/protocol.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8798;
const DB = join(ROOT, 'e2e.sqlite');
const ROOM = 'e2e';
const TOKEN = 'e2e-token';
const SECONDS = Number(process.argv[2] ?? 45);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cleanDb(): void {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
}

async function waitForServer(proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode})`);
    await sleep(150);
  }
  throw new Error('server never came up');
}

async function main(): Promise<void> {
  cleanDb();

  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'ignore' },
  );

  let bridge: ChildProcess | null = null;
  const received: RoomEvent[] = [];

  try {
    await waitForServer(server);
    console.log(bold(`\n  atrium end-to-end  (port ${PORT}, ${SECONDS}s)\n`));

    // the viewer: exactly what a browser tab will do
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('viewer failed to connect')), { once: true });
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.t === 'event') {
        received.push(msg.event);
        const when = new Date(msg.event.ts).toLocaleTimeString();
        const who = `${msg.event.member}/${msg.event.agent ?? '-'}`;
        const label = msg.event.kind === 'tool' ? `tool:${msg.event.tool}` : msg.event.kind;
        const text = msg.event.text.replace(/\s+/g, ' ').trim().slice(0, 110);
        console.log(`  ${dim(when)} ${cyan(who.padEnd(16))} ${green(label.padEnd(14))} ${text}`);
      }
      if (msg.t === 'presence') {
        console.log(dim(`  presence: ${msg.members.map((m) => `${m.name}(${m.role})`).join(', ')}`));
      }
    });
    ws.send(JSON.stringify({ t: 'hello', room: ROOM, token: TOKEN, name: 'viewer', role: 'viewer' }));
    await sleep(200);

    // the bridge: a real teammate running the real join command
    bridge = spawn(
      process.execPath,
      [
        join(ROOT, 'bridge', 'src', 'cli.ts'),
        'join',
        '--url', `ws://127.0.0.1:${PORT}/ws`,
        '--room', ROOM,
        '--token', TOKEN,
        '--name', 'gourav',
        '--seconds', String(SECONDS),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );

    await sleep(SECONDS * 1000 + 1500);
    ws.close();
  } finally {
    bridge?.kill();
    server.kill();
    await sleep(200);
    cleanDb();
  }

  const kinds = received.reduce<Record<string, number>>((a, e) => {
    a[e.kind] = (a[e.kind] ?? 0) + 1;
    return a;
  }, {});
  const agentTurns = received.filter((e) => ['prompt', 'response', 'tool'].includes(e.kind));

  console.log(bold(`\n  ${received.length} event(s) reached the viewer`));
  console.log(`  ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  console.log(
    agentTurns.length > 0
      ? green('\n  PASS  agent turns travelled machine -> server -> another client\n')
      : '\x1b[33m\n  no agent turns seen. Was an agent session active during the window?\n\x1b[0m',
  );
  process.exit(agentTurns.length > 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n  e2e crashed:', err);
  process.exit(1);
});
