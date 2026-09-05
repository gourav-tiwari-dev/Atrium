/**
 * The room -> terminal handoff.
 *
 * A room message goes into someone's pinned conversation, but a terminal they
 * already had open never sees it - a running agent process does not notice
 * appends made behind its back (verified 2026-09-05). So the room has to tell
 * them, with the exact command that picks it up.
 *
 * No model calls: this drives the server directly with sockets standing in for
 * a bridge and a browser.
 *
 * Run: node scripts/pickup-test.ts
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage, Member } from '../server/src/protocol.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8795;
const DB = join(ROOT, 'pickup-test.sqlite');
const ROOM = 'pickuptest';
const TOKEN = 'pickup-token';
const RESUME = 'claude --resume 11111111-2222-3333-4444-555555555555';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cleanDb = (): void => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
};

class Client {
  readonly received: ServerMessage[] = [];
  private ws!: WebSocket;

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.addEventListener('message', (e) =>
      this.received.push(JSON.parse(String(e.data)) as ServerMessage),
    );
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  close(): void {
    this.ws.close();
  }
  /** the newest roster this client was told about */
  latestMembers(): Member[] {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i];
      if (m.t === 'presence' || m.t === 'welcome') return m.members;
    }
    return [];
  }
  me(name: string): Member | undefined {
    return this.latestMembers().find((m) => m.name === name);
  }
}

async function main(): Promise<void> {
  cleanDb();
  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'ignore' },
  );

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }

    console.log('\n  atrium pickup test\n');

    // a bridge that accepts prompts and knows how to be picked up
    const bridge = new Client();
    await bridge.connect();
    bridge.send({
      t: 'hello', room: ROOM, token: TOKEN, name: 'gourav',
      role: 'bridge', canAsk: true, resumeCommand: RESUME,
    });
    await sleep(150);

    const viewer = new Client();
    await viewer.connect();
    viewer.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'gourav', role: 'viewer' });
    await sleep(200);

    check('nothing to pick up before anything is asked', viewer.me('gourav')?.pickup === undefined,
      JSON.stringify(viewer.me('gourav')?.pickup));

    viewer.send({ t: 'ask', text: 'first question' });
    await sleep(250);
    check('one ask counts as one pickup', viewer.me('gourav')?.pickup?.count === 1,
      String(viewer.me('gourav')?.pickup?.count));
    check('and it carries the exact command', viewer.me('gourav')?.pickup?.command === RESUME,
      String(viewer.me('gourav')?.pickup?.command));

    viewer.send({ t: 'ask', text: 'second question' });
    viewer.send({ t: 'ask', text: 'third question' });
    await sleep(300);
    check('they accumulate', viewer.me('gourav')?.pickup?.count === 3,
      String(viewer.me('gourav')?.pickup?.count));

    // a bridge reconnecting means a fresh process read the transcript
    bridge.close();
    await sleep(200);
    const back = new Client();
    await back.connect();
    back.send({
      t: 'hello', room: ROOM, token: TOKEN, name: 'gourav',
      role: 'bridge', canAsk: true, resumeCommand: RESUME,
    });
    await sleep(300);
    check('a bridge reconnect clears the backlog', viewer.me('gourav')?.pickup === undefined,
      JSON.stringify(viewer.me('gourav')?.pickup));

    // someone with no bridge has no command to offer, so no banner
    const lonely = new Client();
    await lonely.connect();
    lonely.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'romit', role: 'viewer' });
    await sleep(200);
    check('a viewer with no bridge is never told to pick anything up',
      lonely.me('romit')?.pickup === undefined, JSON.stringify(lonely.me('romit')?.pickup));

    viewer.close();
    back.close();
    lonely.close();
  } finally {
    server.kill();
    await sleep(200);
    cleanDb();
  }

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
