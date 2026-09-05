import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Bridge } from './bridge.ts';
import { RoomClient } from './client.ts';
import { AgentRunner, type AgentKind } from './runner.ts';
import { openOffsets } from './offsets.ts';
import { openPin } from './sessions.ts';
import { C, oneLine } from './term.ts';
import { detectAgent, hasCli } from './launch.ts';

/**
 * Joining a room: tail this machine's agent sessions, stream them to the room,
 * and run prompts the room sends back.
 *
 * This is the whole behaviour of `atrium join`, lifted out of the CLI so that
 * the double-click launcher can use it too. A launcher that only opened a
 * socket would put someone in the room with no lane and no working agent -
 * present, but useless.
 *
 * It lives in its own module rather than being exported from cli.ts, because
 * cli.ts runs its command switch at module top level and importing it would
 * fire that as a side effect.
 */

export interface JoinConfig {
  url: string;
  room: string;
  token: string;
  name: string;
  allowAsk: boolean;
  allowMentions: boolean;
  askAgent?: AgentKind;
  askCwd?: string;
  permissionMode?: string;
  fullAuto?: boolean;
  codexLiveQueue?: boolean;
  session?: string;
  catchUp?: boolean;
  thinking?: boolean;
  /** the launcher prints its own short status, so skip the banner and stats line */
  quiet?: boolean;
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void;
}

export interface JoinHandle {
  stop(): void;
}

export function resumeCommandFor(agent: AgentKind, sessionId: string): string {
  return agent === 'claude' ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
}

export function joinRoom(cfg: JoinConfig): JoinHandle {
  const quiet = cfg.quiet === true;
  const say = (line: string): void => {
    if (!quiet) console.log(line);
  };

  say(C.bold('\n  Atrium bridge'));
  say(`  room    ${C.bold(cfg.room)}`);
  say(`  as      ${C.bold(cfg.name)}`);
  say(`  server  ${C.dim(cfg.url)}\n`);

  // mentions imply asking: a teammate driving your agent is strictly more than
  // you driving it yourself, so the narrower permission comes along for free.
  const allowAsk = cfg.allowAsk || cfg.allowMentions;
  const allowMentions = cfg.allowMentions;
  say(
    `  asking  ${
      allowAsk
        ? C.yellow('ON — the room can run prompts through your agent')
        : C.dim('off (--allow-ask lets the browser drive your agent)')
    }`,
  );
  if (allowMentions) {
    say(C.yellow('  mentions ON — a teammate @naming you starts a run on THIS machine'));
  }

  // Which conversation this room talks to. Persisted, so tomorrow's bridge
  // reaches the same agent as today's.
  const pins = openPin(cfg.room, cfg.name);
  const pinned = pins.get();
  if (pinned) say(`  session ${C.dim(pinned.sessionId)}`);

  let status: 'connecting' | 'open' | 'closed' = 'connecting';
  let runner: AgentRunner | null = null;
  let bridgeRef: Bridge | null = null;
  let stopped = false;

  const client = new RoomClient({
    url: cfg.url,
    room: cfg.room,
    token: cfg.token,
    name: cfg.name,
    agent: 'mixed', // per-turn agent is what the UI actually displays
    canAsk: allowAsk,
    canMention: allowMentions,
    resumeCommand: pinned ? resumeCommandFor(pinned.agent, pinned.sessionId) : undefined,
    onRun: (from, text) => {
      if (!allowAsk) return;
      // Built on first use: which CLI to drive and which folder to run in are
      // learned from the transcripts, not guessed at startup.
      if (!runner) {
        // Ask the machine rather than assuming. Defaulting to claude meant a
        // Codex-only teammate got "claude is not on PATH" for every question
        // anyone asked them - the agent was never reachable, and the message
        // named the wrong tool.
        const agent = cfg.askAgent ?? pinned?.agent ?? bridgeRef?.lastAgent ?? detectAgent();
        const cwd = cfg.askCwd ?? pinned?.cwd ?? bridgeRef?.lastCwd ?? process.cwd();
        const sessionId = cfg.session ?? pinned?.sessionId;

        say(C.dim(`\n  running asks through ${agent} in ${cwd}`));
        say(
          sessionId
            ? C.dim(`  pinned session ${sessionId}`)
            : C.yellow('  no pinned session yet — the first message will start one'),
        );
        // Say this once, at setup, rather than once per question as a failure.
        if (!hasCli(agent)) {
          const other = agent === 'claude' ? 'codex' : 'claude';
          const advice = hasCli(other)
            ? `${agent} is not installed here, but ${other} is — restart with --ask-agent ${other}`
            : 'neither claude nor codex is installed here, so nobody can ask this agent anything';
          say(C.yellow(`  ! ${advice}`));
          client.notice(advice);
        }

        if (agent === 'claude' && resolve(cwd) === resolve(homedir())) {
          say(C.dim('  note: home folder, so your saved memory is in scope; answers go to the room'));
        }

        runner = new AgentRunner({
          agent,
          cwd,
          permissionMode: cfg.permissionMode ?? 'auto',
          fullAuto: cfg.fullAuto === true,
          sessionId,
          room: cfg.room,
          owner: cfg.name,
          memberCount: () => client.memberCount,
          codexLiveQueue: cfg.codexLiveQueue === true,
          onSessionCreated: (id) => {
            pins.set({ agent, sessionId: id, cwd, pinnedAt: Date.now() });
            say(C.green(`\n  ● this room is now pinned to session ${id}`));
            say(C.dim(`    pick it up in a terminal with:  ${resumeCommandFor(agent, id)}`));
          },
          onBlocked: (why) => {
            say(C.yellow(`  … ${why}`));
            client.notice(why);
          },
          onNotice: (t) => {
            say(C.yellow(`  ! agent run failed: ${t}`));
            client.notice(`agent run failed: ${t}`);
          },
          onState: (busy) => {
            if (busy) say(C.magenta(`\n  > ${from} asked your agent: `) + oneLine(text, 100));
          },
        });
      }
      runner.run(from, text);
    },
    onStatus: (s) => {
      status = s;
      if (s === 'open') say(C.green('  ● connected'));
      if (s === 'closed') say(C.yellow('  ○ disconnected — queueing turns, will retry'));
      cfg.onStatus?.(s);
    },
    onDeliver: (from, text) => {
      say(`\n${C.magenta('  ✉ ')}${C.bold(from)} → your agent:  ${oneLine(text, 120)}`);
      say(C.dim('    (waiting in room_inbox; your agent picks it up on its next read)\n'));
    },
  });
  client.connect();

  // Resuming from where the last run stopped is what carries work you did with
  // the bridge closed into the room, instead of losing it.
  const offsets = cfg.catchUp === false ? null : openOffsets(cfg.room, cfg.name);

  const bridge = new Bridge((turn) => client.send(turn), {
    includeThinking: cfg.thinking === true,
    resumeFrom: offsets ? (file) => offsets.get(file) : undefined,
    onProgress: offsets ? (file, at) => offsets.set(file, at) : undefined,
  });
  bridgeRef = bridge;
  bridge.onAttach = (s) => say(`${C.green('  + streaming ')}${s.agent}  ${C.dim(basename(s.file))}`);
  bridge.start();

  if (bridge.caughtUp.length > 0) {
    const kb = Math.round(bridge.caughtUp.reduce((n, c) => n + c.bytes, 0) / 1024);
    say(C.cyan(`  ↺ catching up on ${kb} KB of work done while the bridge was closed`));
  }

  // `atrium pause` is not a daemon command yet; the local toggle is Ctrl+P here
  if (!quiet && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      const key = buf.toString();
      if (key === '\u0003') stop(); // Ctrl+C
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
    if (quiet) return;
    const b = bridge.stats;
    const c = client.stats;
    const dot = status === 'open' ? C.green('●') : C.yellow('○');
    const paused = bridge.isPaused ? C.yellow(' [paused]') : '';
    process.stderr.write(
      C.dim(`\r  ${dot} ${bridge.watching.length} session(s) · ${c.sent} sent · ${c.queued} queued · ${b.redacted} redacted${paused}   `),
    );
  }, 2000);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(report);
    bridge.stop();
    offsets?.save();
    runner?.dispose();
    client.close();
    if (quiet) return;

    console.log(C.bold(`\n\n  ${client.stats.sent} turns sent to ${cfg.room}.`));
    console.log(
      C.dim(`  redacted ${bridge.stats.redacted} · kept private ${bridge.stats.private} · reconnects ${client.stats.reconnects}`),
    );

    // Whatever the room asked went into this conversation. A terminal that was
    // already open never saw it, so hand over the command that picks it up.
    const p = pins.get();
    if (p) {
      console.log(C.dim('\n  pick this room up in a terminal with:'));
      console.log(`  ${C.bold(resumeCommandFor(p.agent, p.sessionId))}`);
    }
    console.log();
  }

  return { stop };
}
