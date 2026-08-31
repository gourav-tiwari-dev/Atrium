/**
 * The point of the whole project, as a test.
 *
 * Seeds a room with real decisions and activity, then talks to `atrium mcp`
 * over stdio exactly the way Claude Code or Codex would - and checks that an
 * agent which was told nothing can read what the team decided.
 *
 * Run: node --no-warnings=ExperimentalWarning scripts/mcp-test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8797;
const DB = join(ROOT, 'mcp-test.sqlite');
const ROOM = 'echosphere';
const TOKEN = 'mcp-token';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cleanDb = () => { for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true }); };

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
class McpClient {
  private buf = '';
  private nextId = 1;
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
    const id = this.nextId++;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8000);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v as T);
      });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

async function seedRoom(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('seed socket failed')), { once: true });
  });
  const say = (m: unknown) => ws.send(JSON.stringify(m));

  say({ t: 'hello', room: ROOM, token: TOKEN, name: 'gourav', agent: 'claude', role: 'bridge' });
  await sleep(150);
  say({ t: 'decision', text: 'the coordinator owns floor control; agents never subscribe to "*"' });
  say({ t: 'decision', text: 'BRIEF is one shared JSON object built from the live transcript' });
  say({ t: 'turn', kind: 'prompt', text: 'how should the panel decide who speaks next?', id: 't1' });
  say({ t: 'turn', kind: 'response', text: 'a single coordinator holds the floor and grants turns', id: 't2' });
  say({ t: 'mention', target: 'meera', text: 'can your agent reuse my transcript parser?' });
  await sleep(300);
  ws.close();
  await sleep(150);
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
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
      } catch { /* not up */ }
      await sleep(150);
    }
    console.log('\n  atrium MCP test\n');
    await seedRoom();

    // meera's agent - a session that has been told nothing at all
    mcp = spawn(
      process.execPath,
      [
        join(ROOT, 'bridge', 'src', 'cli.ts'), 'mcp',
        '--origin', `http://127.0.0.1:${PORT}`,
        '--room', ROOM,
        '--token', TOKEN,
        '--name', 'meera',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const client = new McpClient(mcp);

    const init = await client.request<{ serverInfo: { name: string } }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '0' },
    });
    client.notify('notifications/initialized');
    check('MCP handshake', init.serverInfo.name === 'atrium', init.serverInfo.name);

    const tools = await client.request<{ tools: Array<{ name: string }> }>('tools/list');
    const names = tools.tools.map((t) => t.name).sort();
    check('tools are advertised', names.join(',') === 'room_context,room_inbox,room_recent', names.join(','));

    type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const call = (name: string, args: unknown = {}) =>
      client.request<ToolResult>('tools/call', { name, arguments: args });

    const ctx = await call('room_context');
    const ctxText = ctx.content[0]?.text ?? '';
    check('room_context returns decisions', ctxText.includes('coordinator owns floor control'));
    check('room_context includes both decisions', ctxText.includes('BRIEF is one shared JSON'));
    check('room_context lists who is in the room', ctxText.includes('gourav'));

    const recent = await call('room_recent', { limit: 20 });
    const recentText = recent.content[0]?.text ?? '';
    check("room_recent shows another agent's answer", recentText.includes('holds the floor and grants turns'));
    check('room_recent attributes the agent', recentText.includes('gourav/claude'));

    const filtered = await call('room_recent', { kinds: 'decision' });
    const filteredText = filtered.content[0]?.text ?? '';
    check('room_recent filters by kind', filteredText.includes('decision') && !filteredText.includes('how should the panel'));

    const inbox = await call('room_inbox');
    check('room_inbox shows a message addressed to me', (inbox.content[0]?.text ?? '').includes('transcript parser'));

    // a wrong token must fail loudly, not look like an empty room
    const rogue = spawn(
      process.execPath,
      [
        join(ROOT, 'bridge', 'src', 'cli.ts'), 'mcp',
        '--origin', `http://127.0.0.1:${PORT}`, '--room', ROOM, '--token', 'wrong', '--name', 'x',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const rogueClient = new McpClient(rogue);
    await rogueClient.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    rogueClient.notify('notifications/initialized');
    const denied = await rogueClient.request<ToolResult>('tools/call', { name: 'room_context', arguments: {} });
    check('a wrong token errors instead of returning nothing', denied.isError === true, denied.content[0]?.text ?? '');
    rogue.kill();
  } finally {
    mcp?.kill();
    server.kill();
    await sleep(200);
    cleanDb();
  }

  console.log(failures === 0 ? '\n  \x1b[32mall checks passed\x1b[0m\n' : `\n  \x1b[31m${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('\n  mcp test crashed:', e);
  process.exit(1);
});
