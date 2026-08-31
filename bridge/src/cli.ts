import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { hostname, userInfo, homedir } from 'node:os';
import { Bridge } from './bridge.ts';
import { RoomClient } from './client.ts';
import { AgentRunner, type AgentKind } from './runner.ts';
import { openOffsets } from './offsets.ts';
import { discover, activeSources, claudeRoot, codexRoot, type Source } from './discover.ts';
import { unknownShapes } from './parse/codex.ts';
import type { Turn } from './types.ts';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

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

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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
  const url = val('--url') ?? 'ws://localhost:8787/ws';
  const room = val('--room') ?? 'atrium';
  const token = val('--token') ?? process.env.ATRIUM_TOKEN ?? '';
  const name = val('--name') ?? (userInfo().username || hostname());

  if (!token) {
    console.error(C.red('\n  --token is required (or set ATRIUM_TOKEN).'));
    console.error(C.dim('  Everyone in the room uses the same one; it is what keeps the room private.\n'));
    process.exit(1);
  }

  console.log(C.bold('\n  Atrium bridge'));
  console.log(`  room    ${C.bold(room)}`);
  console.log(`  as      ${C.bold(name)}`);
  console.log(`  server  ${C.dim(url)}\n`);

  const allowAsk = has('--allow-ask');
  // mentions imply asking: a teammate driving your agent is strictly more than
  // you driving it yourself, so the narrower permission comes along for free.
  const allowMentions = has('--allow-mentions');
  console.log(
    `  asking  ${
      allowAsk
        ? C.yellow('ON — the room can run prompts through your agent')
        : C.dim('off (--allow-ask lets the browser drive your agent)')
    }`,
  );
  if (allowMentions) {
    console.log(C.yellow('  mentions ON — a teammate @naming you starts a run on THIS machine'));
  }

  let status: 'connecting' | 'open' | 'closed' = 'connecting';
  let runner: AgentRunner | null = null;
  let bridgeRef: Bridge | null = null;

  const client = new RoomClient({
    url,
    room,
    token,
    name,
    agent: 'mixed', // per-turn agent is what the UI actually displays
    codexSession: val('--codex-session'),
    canAsk: allowAsk || allowMentions,
    canMention: allowMentions,
    onRun: (from, text) => {
      if (!allowAsk && !allowMentions) return;
      // Built on first use: which CLI to drive and which folder to run in are
      // learned from the transcripts, not guessed at startup.
      if (!runner) {
        const agent = (val('--ask-agent') as AgentKind | undefined) ?? bridgeRef?.lastAgent ?? 'claude';
        const cwd = val('--ask-cwd') ?? bridgeRef?.lastCwd ?? process.cwd();
        console.log(C.dim(`\n  running asks through ${agent} in ${cwd}`));

        // Claude Code keeps its saved memory per working directory. Running an
        // ask from the home folder loads whatever personal memory lives there,
        // and the answer goes to the whole room. Worth saying out loud once.
        if (agent === 'claude' && resolve(cwd) === resolve(homedir())) {
          console.log(
            C.yellow('  ! this is your home folder, so your personal saved memory is in scope'),
          );
          console.log(
            C.dim('    answers go to everyone. Use --ask-cwd <project folder> to avoid it.'),
          );
        }
        runner = new AgentRunner({
          agent,
          cwd,
          permissionMode: val('--ask-permission-mode') ?? 'auto',
          fullAuto: has('--full-auto'),
          continueSession: !has('--fresh'),
          onNotice: (t) => {
            console.log(C.yellow(`  ! agent run failed: ${t}`));
            client.notice(`agent run failed: ${t}`);
          },
          onState: (busy) => {
            if (busy) console.log(C.magenta(`\n  > ${from} asked your agent: `) + oneLine(text, 100));
          },
        });
      }
      runner.run(text);
    },
    onStatus: (s) => {
      status = s;
      if (s === 'open') console.log(C.green('  ● connected'));
      if (s === 'closed') console.log(C.yellow('  ○ disconnected — queueing turns, will retry'));
    },
    onDeliver: (from, text) => {
      console.log(`\n${C.magenta('  ✉ ')}${C.bold(from)} → your agent:  ${oneLine(text, 120)}`);
      console.log(C.dim('    (waiting in room_inbox; your agent picks it up on its next read)\n'));
    },
  });
  client.connect();

  // Resuming from where the last run stopped is what carries work you did with
  // the bridge closed into the room, instead of losing it.
  const offsets = has('--no-catch-up') ? null : openOffsets(room, name);

  const bridge = new Bridge((turn) => client.send(turn), {
    includeThinking: has('--thinking'),
    resumeFrom: offsets ? (file) => offsets.get(file) : undefined,
    onProgress: offsets ? (file, at) => offsets.set(file, at) : undefined,
  });
  bridgeRef = bridge;
  bridge.onAttach = (s) => console.log(`${C.green('  + streaming ')}${s.agent}  ${C.dim(basename(s.file))}`);
  bridge.start();

  if (bridge.caughtUp.length > 0) {
    const kb = Math.round(bridge.caughtUp.reduce((n, c) => n + c.bytes, 0) / 1024);
    console.log(
      C.cyan(`  ↺ catching up on ${kb} KB of work done while the bridge was closed`),
    );
  }

  // `atrium pause` is not a daemon command yet; the local toggle is Ctrl+P here
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      const key = buf.toString();
      if (key === '\u0003') shutdown(); // Ctrl+C
      if (key === '\u0010') {
        // Ctrl+P
        if (bridge.isPaused) {
          bridge.resume();
          console.log(C.green('\n  ▶ resumed — turns are streaming again\n'));
        } else {
          bridge.pause();
          console.log(C.yellow('\n  ⏸ paused — nothing leaves this machine until you press Ctrl+P again\n'));
        }
      }
    });
  }

  const report = setInterval(() => {
    bridge.reportProgress();
    offsets?.save();
    const b = bridge.stats;
    const c = client.stats;
    const dot = status === 'open' ? C.green('●') : C.yellow('○');
    const paused = bridge.isPaused ? C.yellow(' [paused]') : '';
    process.stderr.write(
      C.dim(`\r  ${dot} ${bridge.watching.length} session(s) · ${c.sent} sent · ${c.queued} queued · ${b.redacted} redacted${paused}   `),
    );
  }, 2000);

  function shutdown(): void {
    clearInterval(report);
    bridge.stop();
    offsets?.save();
    runner?.dispose();
    client.close();
    console.log(C.bold(`\n\n  ${client.stats.sent} turns sent to ${room}.`));
    console.log(C.dim(`  redacted ${bridge.stats.redacted} · kept private ${bridge.stats.private} · reconnects ${client.stats.reconnects}\n`));
    process.exit(0);
  }

  const seconds = Number(val('--seconds') ?? 0);
  if (seconds > 0) setTimeout(shutdown, seconds * 1000);
  process.on('SIGINT', shutdown);
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
          --codex-session S   deliver mentions into a running Codex session

  While joined, Ctrl+P pauses streaming - nothing leaves the machine until you
  press it again. A prompt containing #private is never sent.
`);
}
