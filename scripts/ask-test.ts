/**
 * Typing to your own agent from the browser.
 *
 * Two halves:
 *   1. routing - cheap, no model calls. Who may drive whose agent.
 *   2. one real run - starts a bridge with --allow-ask, sends a prompt the way
 *      the browser does, and waits for the answer to come back through the
 *      transcript into the room.
 *
 * Run: node --no-warnings=ExperimentalWarning scripts/ask-test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, RoomEvent } from '../server/src/protocol.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8796;
const DB = join(ROOT, 'ask-test.sqlite');
const ROOM = 'asktest';
const TOKEN = 'ask-token';
const MARKER = 'ATRIUM_ASK_OK';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cleanDb = () => { for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true }); };

class Client {
  readonly received: ServerMessage[] = [];
  private ws!: WebSocket;

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.addEventListener('message', (e) => this.received.push(JSON.parse(String(e.data)) as ServerMessage));
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  close(): void { this.ws.close(); }
  of<K extends ServerMessage['t']>(t: K): Extract<ServerMessage, { t: K }>[] {
    return this.received.filter((m) => m.t === t) as Extract<ServerMessage, { t: K }>[];
  }
  events(): RoomEvent[] { return this.of('event').map((m) => m.event); }
}

async function main(): Promise<void> {
  cleanDb();
  const workdir = mkdtempSync(join(tmpdir(), 'atrium-askrun-'));

  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'ignore' },
  );

  let bridge: ChildProcess | null = null;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* wait */ }
      await sleep(150);
    }
    console.log('\n  atrium ask test\n');

    // ---------- 1. routing, no model calls -------------------------------
    const viewer = new Client();
    await viewer.connect();
    viewer.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'gourav', role: 'viewer' });
    await sleep(200);

    viewer.send({ t: 'ask', text: 'this should be refused' });
    await sleep(300);
    check(
      'asking with no bridge is refused, not silently dropped',
      viewer.of('error').some((e) => e.message.includes('--allow-ask')),
      viewer.of('error')[0]?.message ?? '(no error)',
    );

    // a bridge that did NOT opt in must still be refused
    const plain = new Client();
    await plain.connect();
    plain.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'gourav', agent: 'claude', role: 'bridge' });
    await sleep(250);
    const errsBefore = viewer.of('error').length;
    viewer.send({ t: 'ask', text: 'still refused' });
    await sleep(300);
    check('a bridge without --allow-ask still refuses', viewer.of('error').length === errsBefore + 1);
    check('presence reports canAsk = false', viewer.of('presence').at(-1)?.members.some((m) => m.name === 'gourav' && !m.canAsk) === true);

    // an opted-in bridge receives the run, and only for its own owner
    const opted = new Client();
    await opted.connect();
    opted.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'meera', agent: 'codex', role: 'bridge', canAsk: true });
    await sleep(250);

    const meera = new Client();
    await meera.connect();
    meera.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'meera', role: 'viewer' });
    await sleep(200);
    meera.send({ t: 'ask', text: 'run this please' });
    await sleep(300);
    check('an opted-in bridge receives the run', opted.of('run').some((r) => r.text === 'run this please'));

    const runsBefore = opted.of('run').length;
    viewer.send({ t: 'ask', text: 'gourav must not drive meera' });
    await sleep(300);
    check("one person's ask never reaches another person's agent", opted.of('run').length === runsBefore);

    plain.close(); opted.close(); meera.close();
    await sleep(200);

    // ---------- 2. one real run through the local agent ------------------
    console.log('\n  running one real agent invocation (this calls the model once)…\n');

    bridge = spawn(
      process.execPath,
      [
        join(ROOT, 'bridge', 'src', 'cli.ts'), 'join',
        '--url', `ws://127.0.0.1:${PORT}/ws`,
        '--room', ROOM, '--token', TOKEN, '--name', 'runner',
        '--allow-ask', '--fresh',
        '--ask-agent', 'claude',
        '--ask-cwd', workdir,
        '--ask-permission-mode', 'dontAsk',
        '--seconds', '210',
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    await sleep(3500);

    const driver = new Client();
    await driver.connect();
    driver.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'runner', role: 'viewer' });
    await sleep(400);
    check('the bridge advertises that it accepts prompts',
      driver.of('presence').at(-1)?.members.some((m) => m.name === 'runner' && m.canAsk) === true);

    driver.send({ t: 'ask', text: `Reply with exactly the word ${MARKER} and nothing else.` });

    // the reply comes back the long way: agent -> transcript -> tail -> room
    let answered = false;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      if (driver.events().some((e) => e.kind === 'response' && e.text.includes(MARKER))) {
        answered = true;
        break;
      }
      const failed = driver.events().find((e) => e.kind === 'system');
      if (failed) { console.log(`  (bridge reported: ${failed.text})`); break; }
    }

    check('the agent answered, and the answer reached the room', answered);
    const prompt = driver.events().find((e) => e.kind === 'prompt' && e.text.includes(MARKER));
    check('the prompt itself also appeared in the lane', !!prompt);

    driver.close(); viewer.close();
    await sleep(200);
  } finally {
    bridge?.kill();
    server.kill();
    await sleep(300);
    cleanDb();
    rmSync(workdir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('\n  ask test crashed:', e);
  process.exit(1);
});
