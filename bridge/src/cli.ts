import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { Bridge } from './bridge.ts';
import { joinRoom } from './join.ts';
import { type AgentKind } from './runner.ts';
import { discover, activeSources, claudeRoot, codexRoot, type Source } from './discover.ts';
import { unknownShapes } from './parse/codex.ts';
import { C, oneLine } from './term.ts';
import type { Turn } from './types.ts';


const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) ?? 'probe';
const has = (f: string): boolean => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KIND_STYLE: Record<Turn['kind'], (s: string) => string> = {
  prompt: C.green,
  response: C.cyan,
  tool: C.dim,
  thinking: C.magenta,
};

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function size(n: number): string {
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function printTurn(turn: Turn, source: Source): void {
  const time = new Date(turn.ts).toLocaleTimeString();
  const label = turn.kind === 'tool' ? `tool:${turn.toolName}` : turn.kind;
  console.log(
    `${C.dim(time)} ${KIND_STYLE[turn.kind](label.padEnd(16))} ${C.dim(source.agent)}  ${oneLine(turn.text)}`,
  );
}

// ---------------------------------------------------------------- probe ----

function listSources(): void {
  const all = discover();
  const live = new Set(activeSources().map((s) => s.file));

  console.log(C.bold('\n  Transcript roots'));
  console.log(`  claude  ${C.dim(claudeRoot())}`);
  console.log(`  codex   ${C.dim(codexRoot())}\n`);

  if (all.length === 0) {
    console.log(C.red('  No transcripts found. Open a Claude Code or Codex session first.\n'));
    return;
  }

  const claude = all.filter((s) => s.agent === 'claude').length;
  const codex = all.filter((s) => s.agent === 'codex').length;
  console.log(
    C.bold(`  ${all.length} transcript(s)`) +
      C.dim(`   claude ${claude} · codex ${codex} · live ${live.size}\n`),
  );

  for (const s of all.slice(0, 12)) {
    const flag = live.has(s.file) ? C.green('● live') : C.dim('  idle');
    const agent = s.agent === 'claude' ? C.blue('claude') : C.yellow('codex ');
    console.log(
      `  ${flag} ${agent} ${C.dim(ago(s.mtimeMs).padStart(8))}  ${size(s.size).padStart(8)}  ${basename(s.file)}`,
    );
  }
  if (all.length > 12) console.log(C.dim(`  … and ${all.length - 12} more`));
  console.log();
}

function parseOneFile(file: string): void {
  const agent: Source['agent'] = /rollout-/.test(basename(file)) ? 'codex' : 'claude';
  const source: Source = { agent, file, mtimeMs: Date.now(), size: 0 };
  console.log(C.bold(`\n  Parsing ${basename(file)}  ${C.dim(`(as ${agent})`)}\n`));

  const turns: Turn[] = [];
  const bridge = new Bridge((t) => turns.push(t), { includeThinking: has('--thinking') });

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) bridge.handleLine(trimmed, source);
  }

  for (const t of has('--all') ? turns : turns.slice(-25)) printTurn(t, source);

  const counts = turns.reduce<Record<string, number>>((acc, t) => {
    acc[t.kind] = (acc[t.kind] ?? 0) + 1;
    return acc;
  }, {});

  const s = bridge.stats;
  console.log(`\n${C.bold('  Result')}`);
  console.log(`  lines read     ${s.lines}`);
  console.log(`  turns emitted  ${C.green(String(s.turns))}`);
  console.log(`  ignored        ${C.dim(String(s.dropped))} ${C.dim('(bookkeeping, tool results, sidechains)')}`);
  console.log(`  redacted       ${s.redacted > 0 ? C.yellow(String(s.redacted)) : '0'}`);
  console.log(`  kept private   ${s.private}`);
  console.log(`  by kind        ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ') || '-'}`);
  if (!has('--all') && turns.length > 25) {
    console.log(C.dim(`\n  (showing last 25 of ${turns.length}; --all for everything)`));
  }

  if (unknownShapes.size > 0) {
    console.log(C.yellow('\n  Unclassified record shapes (the codex parser needs these):'));
    for (const [sig, n] of [...unknownShapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(n).padStart(5)}  ${sig}`);
    }
  }
  console.log();
}

function live(): void {
  console.log(C.bold('\n  Atrium bridge — live probe'));
  console.log(C.dim('  Watching every active session on this machine. Nothing is sent anywhere.\n'));

  const bridge = new Bridge(printTurn, { includeThinking: has('--thinking') });
  bridge.onAttach = (s) => console.log(`${C.green('  + attached ')}${s.agent}  ${C.dim(basename(s.file))}`);
  bridge.start();

  if (bridge.watching.length === 0) {
    console.log(C.yellow('  No live session yet. Open a Claude Code or Codex session and type something.'));
    console.log(C.dim('  (a transcript counts as live if it was touched in the last 30 min)\n'));
  }

  const report = setInterval(() => {
    const s = bridge.stats;
    process.stderr.write(
      C.dim(`\r  ${bridge.watching.length} session(s) · ${s.lines} lines · ${s.turns} turns · ${s.redacted} redacted   `),
    );
  }, 2000);

  function shutdown(): void {
    clearInterval(report);
    bridge.stop();
    const s = bridge.stats;
    console.log(C.bold(`\n\n  ${s.turns} turns from ${s.lines} lines.`));
    console.log(C.dim(`  ignored ${s.dropped} · redacted ${s.redacted} · private ${s.private}\n`));
    process.exit(0);
  }

  const seconds = Number(val('--seconds') ?? 0);
  if (seconds > 0) setTimeout(shutdown, seconds * 1000);
  process.on('SIGINT', shutdown);
}

// ----------------------------------------------------------------- join ----

function join(): void {
  const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';

  if (!token) {
    console.error(C.red('\n  --token is required (or set ATRIUM_TOKEN).'));
    console.error(C.dim('  Everyone in the room uses the same one; it is what keeps the room private.\n'));
    process.exit(1);
  }

  const handle = joinRoom({
    url: val('--url') ?? 'ws://localhost:8787/ws',
    room: val('--room') ?? 'atrium',
    token,
    name: val('--name') ?? (userInfo().username || hostname()),
    allowAsk: has('--allow-ask'),
    allowMentions: has('--allow-mentions'),
    askAgent: val('--ask-agent') as AgentKind | undefined,
    askCwd: val('--ask-cwd'),
    permissionMode: val('--ask-permission-mode'),
    fullAuto: has('--full-auto'),
    codexLiveQueue: has('--codex-live-queue'),
    session: val('--session'),
    catchUp: !has('--no-catch-up'),
    thinking: has('--thinking'),
  });

  function shutdown(): void {
    handle.stop();
    process.exit(0);
  }

  const seconds = Number(val('--seconds') ?? 0);
  if (seconds > 0) setTimeout(shutdown, seconds * 1000);
  process.on('SIGINT', shutdown);
}

// ------------------------------------------------------------------ app ----

/**
 * What "Join Atrium.cmd" runs.
 *
 * No url, no name, no flags - the whole point is that a teammate types nothing.
 * The lobby and token are baked into the .cmd; the name is asked once and
 * saved; the address is looked up, and looked up AGAIN if it stops working.
 */
async function app(): Promise<void> {
  const lobby = val('--lobby') ?? 'echosphere';
  const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';
  const rendezvous = val('--rendezvous') ?? process.env.ATRIUM_RENDEZVOUS ?? '';

  console.log(C.bold('\n  Atrium'));

  // These are launcher-configuration problems, not user errors. Whoever sees
  // them has no terminal open and cannot fix it themselves, so say who can.
  if (!token) {
    console.error(C.red('\n  This launcher is missing the room token.'));
    console.error(C.dim('  Ask Gourav for an updated "Join Atrium.cmd".\n'));
    process.exit(1);
  }
  if (!rendezvous) {
    console.error(C.red('\n  This launcher does not know where to look for the room.'));
    console.error(C.dim('  Ask Gourav for an updated "Join Atrium.cmd".\n'));
    process.exit(1);
  }

  const { startApp, openInBrowser } = await import('./app.ts');
  const { createInterface } = await import('node:readline/promises');

  let handle;
  try {
    handle = await startApp({
      lobby,
      token,
      rendezvous,
      ask: async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`  ${question}`);
        rl.close();
        return answer;
      },
      openBrowser: openInBrowser,
      onLine: (text) => console.log(`  ${C.dim(text)}`),
    });
  } catch (err) {
    console.error(C.red(`\n  Could not join: ${(err as Error).message}`));
    console.error(C.dim('  If this keeps happening, ask Gourav whether the room is running.\n'));
    process.exit(1);
  }

  console.log(C.dim('\n  Leave this window open. Close it when you are done.\n'));
  process.on('SIGINT', () => {
    handle.stop();
    console.log(C.dim('\n  left the room\n'));
    process.exit(0);
  });
}

// ------------------------------------------------------------------------

switch (cmd) {
  case 'probe': {
    const file = val('--file');
    if (file) parseOneFile(file);
    else if (has('--live')) live();
    else listSources();
    break;
  }
  case 'live':
    live();
    break;
  case 'join':
    join();
    break;
  case 'app':
    await app();
    break;
  case 'mcp': {
    // stdio belongs to the MCP protocol here, so nothing may be printed
    const origin = val('--origin') ?? 'http://localhost:8787';
    const room = val('--room') ?? 'atrium';
    const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';
    const name = val('--name') ?? (userInfo().username || hostname());
    const { runMcpServer } = await import('./mcp.ts');
    await runMcpServer({ origin, room, token, name });
    break;
  }
  default:
    console.log(`
  ${C.bold('atrium')} — a live room for people and their AI agents

  ${C.bold('join')} --room <room> --token <token> [--name you] [--url ws://host/ws]
        stream this machine's agent turns into the room

  ${C.bold('mcp')}  --room <room> --token <token> [--origin http://host]
        expose the room to your agent as MCP tools (room_context, room_recent, room_inbox)

  ${C.bold('probe')}                     list every transcript on this machine
  ${C.bold('probe --live')}              follow live sessions locally, send nothing
  ${C.bold('probe --file <path>')}       parse one transcript end to end

  flags   --thinking          include reasoning blocks (off: noisy, often private)
          --all               print every turn, not just the last 25
          --seconds N         stop after N seconds
          --no-catch-up       ignore work done while the bridge was closed
          --allow-mentions    let a teammate's @you run your agent (implies --allow-ask)
          --session <uuid>    pin a specific conversation instead of the saved one
          --codex-live-queue  codex: deliver into the running app session

  The room talks to ONE pinned conversation per person, saved in
  ~/.atrium/session.json. If you have never started one, the first message from
  the room creates it - you never have to open a CLI first. Afterwards,
  'claude --resume <id>' in a terminal picks up everything the room did.

  While joined, Ctrl+P pauses streaming - nothing leaves the machine until you
  press it again. A prompt containing #private is never sent.
`);
}
