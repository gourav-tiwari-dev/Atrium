/**
 * Project memory, and catching up on work done offline.
 *
 * The room's event log says what happened. Memory says what the project IS.
 * These check that an agent can read it, write it, and turn the raw feed into
 * it — and that a bridge which was closed for a while does not silently lose
 * everything that happened meanwhile.
 *
 * Run: node --no-warnings=ExperimentalWarning scripts/memory-test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Tailer } from '../bridge/src/tail.ts';
import type { ServerMessage, MemoryEntry } from '../server/src/protocol.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8795;
const DB = join(ROOT, 'memory-test.sqlite');
const ROOM = 'memtest';
const TOKEN = 'mem-token';

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
}

/** Minimal MCP stdio client, same shape as the real clients use. */
class Mcp {
  private buf = '';
  private id = 1;
  private readonly pending = new Map<number, (v: unknown) => void>();
  private readonly proc: ChildProcess;

  constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg.result);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.id++;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
      this.pending.set(id, (v) => { clearTimeout(t); resolve(v as T); });
    });
  }
  notify(method: string): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`);
  }
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

async function offlineCatchUp(): Promise<void> {
  console.log('\n  --- work done while the bridge was closed ---\n');

  const dir = mkdtempSync(join(tmpdir(), 'atrium-catchup-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{"a":1}\n{"b":2}\n');

  // run one: follow from the end, see nothing of what is already there
  const first: string[] = [];
  const t1 = new Tailer(file, (l) => first.push(l), { intervalMs: 60 });
  t1.start();
  await sleep(200);
  appendFileSync(file, '{"live":1}\n');
  await sleep(250);
  const savedOffset = t1.position;
  t1.stop();
  check('a fresh tailer ignores history', first.length === 1 && first[0] === '{"live":1}', `${first.length} line(s)`);

  // bridge is closed; work continues
  appendFileSync(file, '{"offline":1}\n{"offline":2}\n');

  // run two WITHOUT a saved offset: the old behaviour, which loses it
  const naive: string[] = [];
  const t2 = new Tailer(file, (l) => naive.push(l), { intervalMs: 60 });
  t2.start();
  await sleep(250);
  t2.stop();
  check('without a saved offset, offline work is lost', naive.length === 0, `${naive.length} line(s)`);

  // run three WITH the saved offset: it comes back
  const resumed: string[] = [];
  const t3 = new Tailer(file, (l) => resumed.push(l), { startAt: savedOffset, intervalMs: 60 });
  t3.start();
  await sleep(300);
  t3.stop();
  check(
    'resuming from the saved offset recovers it',
    resumed.length === 2 && resumed[0] === '{"offline":1}',
    resumed.join(' '),
  );

  // a rotated (shorter) file must not read from a stale offset
  writeFileSync(file, '{"rotated":1}\n');
  const after: string[] = [];
  const t4 = new Tailer(file, (l) => after.push(l), { startAt: savedOffset, intervalMs: 60 });
  t4.start();
  await sleep(250);
  t4.stop();
  check('a rotated file does not read garbage', after.every((l) => l.startsWith('{')), after.join(' ') || '(nothing)');

  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  cleanDb();
  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'ignore' },
  );

  let mcp: ChildProcess | null = null;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* wait */ }
      await sleep(150);
    }
    console.log('\n  atrium project-memory test\n');

    const a = new Client();
    const b = new Client();
    await a.connect();
    await b.connect();
    a.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'gourav', agent: 'claude', role: 'bridge' });
    await sleep(150);
    b.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'romit', role: 'viewer' });
    await sleep(200);

    check('a new room starts with empty memory', (a.of('welcome')[0]?.memory ?? []).length === 0);

    // some project activity to digest later
    a.send({ t: 'turn', kind: 'prompt', text: 'why did we drop the round robin?', id: 'm1' });
    a.send({ t: 'turn', kind: 'response', text: 'because all three agents fired at once on silence', id: 'm2' });
    a.send({ t: 'decision', text: 'the coordinator owns floor control' });
    await sleep(250);

    a.send({
      t: 'remember',
      key: 'Floor-Control',
      text: 'One coordinator holds the floor and grants turns. Nobody subscribes to "*".',
    });
    await sleep(300);

    const mem = b.of('memory').at(-1)?.memory ?? [];
    check('writing memory reaches everyone', mem.length === 1, JSON.stringify(mem.map((m) => m.key)));
    check('keys are normalised to lower case', mem[0]?.key === 'floor-control', mem[0]?.key ?? '');
    check('the author is recorded', mem[0]?.updatedBy === 'gourav');

    // overwrite the same key rather than piling up duplicates
    b.send({ t: 'remember', key: 'floor-control', text: 'Updated: the coordinator also handles barge-in.' });
    await sleep(300);
    const mem2 = b.of('memory').at(-1)?.memory ?? [];
    check('the same topic is overwritten, not duplicated', mem2.length === 1, `${mem2.length} entries`);
    check('the overwrite kept the new text', (mem2[0]?.text ?? '').startsWith('Updated:'));
    check('the overwrite recorded the new author', mem2[0]?.updatedBy === 'romit');

    b.send({ t: 'remember', key: 'lanes', text: 'A realtime, B coordinator, C brief, D surface.' });
    await sleep(250);

    // a late joiner gets memory in the welcome, not just the feed
    const late = new Client();
    await late.connect();
    late.send({ t: 'hello', room: ROOM, token: TOKEN, name: 'meera', role: 'viewer' });
    await sleep(300);
    const welcomeMem: MemoryEntry[] = late.of('welcome')[0]?.memory ?? [];
    check('a late joiner receives memory on arrival', welcomeMem.length === 2, welcomeMem.map((m) => m.key).join(','));

    // ---------- through MCP, the way an agent sees it -------------------
    mcp = spawn(
      process.execPath,
      [
        join(ROOT, 'bridge', 'src', 'cli.ts'), 'mcp',
        '--origin', `http://127.0.0.1:${PORT}`,
        '--room', ROOM, '--token', TOKEN, '--name', 'meera',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const client = new Mcp(mcp);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    client.notify('notifications/initialized');

    const tools = (await client.request<{ tools: Array<{ name: string }> }>('tools/list')).tools.map((t) => t.name).sort();
    check('memory tools are advertised', tools.join(',') === 'room_context,room_digest,room_inbox,room_memory,room_recent,room_remember', tools.join(','));

    const call = (name: string, args: unknown = {}) =>
      client.request<ToolResult>('tools/call', { name, arguments: args });

    const read = (await call('room_memory')).content[0]?.text ?? '';
    check('room_memory returns the project picture', read.includes('barge-in') && read.includes('lanes'));

    // an agent writing back is the whole point
    await call('room_remember', { key: 'why-agora', text: 'Agora is the only stack that puts several agents in ONE rtc channel.' });
    await sleep(250);
    const afterAgent = late.of('memory').at(-1)?.memory ?? [];
    check('an agent can write memory itself', afterAgent.some((m) => m.key === 'why-agora'), afterAgent.map((m) => m.key).join(','));

    const digest = (await call('room_digest')).content[0]?.text ?? '';
    check('room_digest reports what memory already covers', digest.includes('floor-control'));
    check('room_digest carries the raw activity to summarise', digest.includes('round robin') || digest.includes('fired at once'));

    const empty = (await call('room_memory')).content[0]?.text ?? '';
    check('room_memory names its author and time', empty.includes('last updated by'));

    a.close(); b.close(); late.close();
    await sleep(200);
  } finally {
    mcp?.kill();
    server.kill();
    await sleep(250);
    cleanDb();
  }

  await offlineCatchUp();

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('\n  memory test crashed:', e);
  process.exit(1);
});
