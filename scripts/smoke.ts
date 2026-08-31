/**
 * End-to-end check of the room server: boots it on a scratch port with a
 * throwaway database, then drives the real protocol over real sockets.
 *
 * Uses the WebSocket client built into Node 24, so the test pulls in nothing
 * the product does not already depend on.
 *
 * Run: pnpm smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, ClientMessage } from '../server/src/protocol.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8799;
const DB = join(ROOT, 'smoke.sqlite');
const URL_WS = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A tiny client that records every server message for later assertions. */
class Client {
  readonly received: ServerMessage[] = [];
  private ws!: WebSocket;

  async connect(): Promise<void> {
    this.ws = new WebSocket(URL_WS);
    this.ws.addEventListener('message', (e) => {
      this.received.push(JSON.parse(String(e.data)) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  of<K extends ServerMessage['t']>(t: K): Extract<ServerMessage, { t: K }>[] {
    return this.received.filter((m) => m.t === t) as Extract<ServerMessage, { t: K }>[];
  }

  events() {
    return this.of('event').map((m) => m.event);
  }
}

async function waitForServer(proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    await sleep(150);
  }
  throw new Error('server did not come up');
}

async function main(): Promise<void> {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });

  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'ignore' },
  );

  try {
    await waitForServer(server);
    console.log(`\n  atrium smoke test  (port ${PORT})\n`);

    // --- two people join the same room ---------------------------------
    const gourav = new Client();
    const viewer = new Client();
    await gourav.connect();
    await viewer.connect();

    gourav.send({ t: 'hello', room: 'echosphere', token: 's3cret', name: 'gourav', agent: 'claude', role: 'bridge' });
    await sleep(120);
    viewer.send({ t: 'hello', room: 'echosphere', token: 's3cret', name: 'meera', role: 'viewer' });
    await sleep(150);

    check('both clients get a welcome', gourav.of('welcome').length === 1 && viewer.of('welcome').length === 1);
    const presence = viewer.of('presence').at(-1);
    check('presence lists both members', presence?.members.length === 2, presence?.members.map((m) => m.name).join(', ') ?? '');
    check('bridge role is recorded', presence?.members.find((m) => m.name === 'gourav')?.role === 'bridge');

    // --- an agent turn reaches the other person ------------------------
    gourav.send({ t: 'turn', kind: 'prompt', text: 'how do we do floor control?', id: 'turn-1' });
    gourav.send({ t: 'turn', kind: 'response', text: 'use a coordinator that owns the floor', id: 'turn-2' });
    await sleep(200);

    const seen = viewer.events();
    check('viewer received the prompt', seen.some((e) => e.kind === 'prompt' && e.text.includes('floor control')));
    check('viewer received the response', seen.some((e) => e.kind === 'response' && e.text.includes('coordinator')));
    check('turns are attributed', seen.find((e) => e.kind === 'response')?.member === 'gourav');
    check('agent is tagged', seen.find((e) => e.kind === 'response')?.agent === 'claude');

    // --- a replayed turn must not double-post --------------------------
    const before = viewer.events().length;
    gourav.send({ t: 'turn', kind: 'response', text: 'use a coordinator that owns the floor', id: 'turn-2' });
    await sleep(200);
    check('replayed turn is deduped', viewer.events().length === before, `${before} -> ${viewer.events().length}`);

    // --- humans and decisions ------------------------------------------
    viewer.send({ t: 'chat', text: 'agreed, lane B owns it' });
    viewer.send({ t: 'decision', text: 'coordinator owns floor control' });
    await sleep(200);
    check('chat is broadcast', gourav.events().some((e) => e.kind === 'chat' && e.text.includes('lane B')));
    check('decision is broadcast', gourav.events().some((e) => e.kind === 'decision'));

    // --- a mention is delivered to that person's bridge -----------------
    viewer.send({ t: 'mention', target: 'gourav', text: 'can your agent reuse my parser?' });
    await sleep(200);
    check('mention reaches the target bridge', gourav.of('deliver').some((m) => m.text.includes('parser')));
    check('mention is also logged for everyone', viewer.events().some((e) => e.kind === 'mention' && e.target === 'gourav'));

    // --- a wrong token is refused ---------------------------------------
    const intruder = new Client();
    await intruder.connect();
    intruder.send({ t: 'hello', room: 'echosphere', token: 'wrong', name: 'nope', role: 'viewer' });
    await sleep(200);
    check('wrong token is rejected', intruder.of('error').length === 1, intruder.of('error')[0]?.message ?? '');
    check('rejected client gets no history', intruder.of('welcome').length === 0);

    // --- a late joiner replays everything --------------------------------
    const late = new Client();
    await late.connect();
    late.send({ t: 'hello', room: 'echosphere', token: 's3cret', name: 'arjun', role: 'viewer' });
    await sleep(250);
    const history = late.of('welcome')[0]?.history ?? [];
    check('late joiner replays the log', history.length >= 6, `${history.length} events`);
    check('replay includes the decision', history.some((e) => e.kind === 'decision'));
    check('replay is in order', history.every((e, i) => i === 0 || history[i - 1].seq < e.seq));

    // --- leaving updates presence ----------------------------------------
    gourav.close();
    await sleep(300);
    const after = late.of('presence').at(-1);
    check('presence drops the departed member', !after?.members.some((m) => m.name === 'gourav'), after?.members.map((m) => m.name).join(', ') ?? '');

    viewer.close();
    late.close();
    intruder.close();
    await sleep(100);
  } finally {
    server.kill();
    await sleep(200);
    rmSync(DB, { force: true });
    rmSync(`${DB}-wal`, { force: true });
    rmSync(`${DB}-shm`, { force: true });
  }

  console.log(
    failures === 0
      ? '\n  \x1b[32mall checks passed\x1b[0m\n'
      : `\n  \x1b[31m${failures} check(s) failed\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\n  smoke test crashed:', err);
  process.exit(1);
});
