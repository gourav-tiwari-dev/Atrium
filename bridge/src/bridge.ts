import { Tailer } from './tail.ts';
import { activeSources, type Source } from './discover.ts';
import { parseClaudeLine } from './parse/claude.ts';
import { parseCodexLine, sessionIdFromPath } from './parse/codex.ts';
import { redact, isPrivate } from './redact.ts';
import { DEFAULT_PARSE_CONTEXT, type Turn, type ParseContext } from './types.ts';

export interface BridgeOptions {
  includeThinking?: boolean;
  /** how far back a transcript can have been touched and still count as live */
  activeWithinMs?: number;
  /** how often to look for newly opened sessions */
  rescanMs?: number;
  /** replay a file from byte 0 instead of following from the end */
  fromStart?: boolean;
  /**
   * Where a previous run stopped, per file. Supplying this is what makes work
   * done while the bridge was closed reach the room instead of vanishing.
   */
  resumeFrom?: (file: string) => number | undefined;
  /** called with each tailer's current byte position, so a caller can persist it */
  onProgress?: (file: string, offset: number) => void;
}

/**
 * Watches every live agent session on this machine and emits vendor-neutral
 * Turns. Knows nothing about the network - M2 wires the emitter to a socket.
 */
export class Bridge {
  private readonly tailers = new Map<string, Tailer>();
  private readonly ctx: ParseContext;
  private readonly opts: Required<BridgeOptions>;
  private rescanTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private started = false;
  private seen = new Set<string>();

  /**
   * The folder the newest session is running in. A prompt typed in the browser
   * should run where the person is actually working, not where they happened to
   * start the bridge.
   */
  lastCwd: string | null = null;

  /** vendor of the most recent turn, so an ask goes to the right CLI */
  lastAgent: 'claude' | 'codex' | null = null;
  /** rollout filenames carry the session id; the records inside do not */
  private readonly sessionIds = new Map<string, string>();

  /** counters worth showing a human who is wondering whether this thing works */
  readonly stats = { lines: 0, turns: 0, dropped: 0, redacted: 0, private: 0 };

  /** files that had unseen bytes from before this run - i.e. offline work */
  readonly caughtUp: Array<{ file: string; bytes: number }> = [];

  private readonly onTurn: (turn: Turn, source: Source) => void;

  constructor(onTurn: (turn: Turn, source: Source) => void, opts: BridgeOptions = {}) {
    this.onTurn = onTurn;
    this.opts = {
      includeThinking: opts.includeThinking ?? false,
      activeWithinMs: opts.activeWithinMs ?? 30 * 60 * 1000,
      rescanMs: opts.rescanMs ?? 5000,
      fromStart: opts.fromStart ?? false,
      resumeFrom: opts.resumeFrom ?? (() => undefined),
      onProgress: opts.onProgress ?? (() => {}),
    };
    this.ctx = { ...DEFAULT_PARSE_CONTEXT, includeThinking: this.opts.includeThinking };
  }

  /** Nothing leaves the machine while paused. */
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  get isPaused(): boolean {
    return this.paused;
  }

  get watching(): string[] {
    return [...this.tailers.keys()];
  }

  start(): this {
    this.scan();
    this.started = true;
    this.rescanTimer = setInterval(() => this.scan(), this.opts.rescanMs);
    return this;
  }

  stop(): void {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    this.reportProgress();
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  /** Hand every tailer's position to the caller so it can be persisted. */
  reportProgress(): void {
    for (const [file, tailer] of this.tailers) this.opts.onProgress(file, tailer.position);
  }

  /** Attach to any live session we are not already following. */
  private scan(): void {
    for (const source of activeSources(this.opts.activeWithinMs)) {
      if (this.tailers.has(source.file)) continue;
      // Files already on disk when we started are history - follow them from the
      // end. A file that shows up later is a session that just began (including
      // a headless run we launched ourselves), so read it from the top or its
      // opening turns are lost.
      const resumeAt = this.opts.resumeFrom(source.file);
      const fromStart = this.opts.fromStart || this.started;
      const tailer = new Tailer(
        source.file,
        (line) => this.handleLine(line, source),
        resumeAt !== undefined ? { startAt: resumeAt } : { fromStart },
      );
      if (resumeAt !== undefined && source.size > resumeAt) {
        this.caughtUp.push({ file: source.file, bytes: source.size - resumeAt });
      }
      this.tailers.set(source.file, tailer.start());
      this.onAttach?.(source);
    }
  }

  /** Optional hook so a CLI can announce newly discovered sessions. */
  onAttach?: (source: Source) => void;

  /** Feed one raw transcript line through parse -> privacy -> emit. */
  handleLine(line: string, source: Source): void {
    this.stats.lines++;
    let turns;
    if (source.agent === 'claude') {
      turns = parseClaudeLine(line, this.ctx);
    } else {
      let sid = this.sessionIds.get(source.file);
      if (sid === undefined) {
        sid = sessionIdFromPath(source.file);
        this.sessionIds.set(source.file, sid);
      }
      turns = parseCodexLine(line, this.ctx, sid);
    }

    if (turns.length === 0) {
      this.stats.dropped++;
      return;
    }

    for (const turn of turns) {
      const key = `${source.agent}:${turn.id}`;
      if (this.seen.has(key)) continue; // a replayed file must not double-post
      this.seen.add(key);

      if (isPrivate(turn.text)) {
        this.stats.private++;
        continue;
      }

      const clean = redact(turn.text);
      if (clean !== turn.text) this.stats.redacted++;

      this.stats.turns++;
      if (turn.cwd) this.lastCwd = turn.cwd;
      this.lastAgent = turn.agent;
      if (!this.paused) this.onTurn({ ...turn, text: clean }, source);
    }
  }
}
