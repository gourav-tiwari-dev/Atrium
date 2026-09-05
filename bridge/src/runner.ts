import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRoomPrompt } from './roomprompt.ts';
import { liveClaudeSessions, livenessOf } from './sessions.ts';
import { cliCommand } from './launch.ts';

/**
 * Runs a prompt typed in the browser through the person's OWN conversation.
 *
 * Not a copy of it. `--continue` used to mean "the newest conversation in this
 * folder", which drifts - the room's exchange could land somewhere the person
 * never opens again. Now a pinned session id is resumed, so the room and their
 * terminal are one continuous session and `claude --resume <id>` afterwards
 * carries the whole room back to them.
 *
 * The reply is NOT captured here. Both CLIs append the whole exchange to the
 * transcript this bridge is already tailing, so the prompt and the answer reach
 * the room the same way an interactive turn does.
 *
 * The prompt is written to a temp file and handed over as stdin - verified on
 * both CLIs. It never appears on a command line, so no amount of quoting or
 * shell metacharacters in a teammate's message can turn into a command.
 */

export type AgentKind = 'claude' | 'codex';

export interface RunnerOptions {
  agent: AgentKind;
  /** where the agent runs; should be the project folder, not the atrium folder */
  cwd: string;
  /** claude only: auto | acceptEdits | dontAsk | plan */
  permissionMode: string;
  /** codex only: let it write and run commands instead of read-only */
  fullAuto: boolean;
  /**
   * The pinned conversation. Undefined means nobody on this machine has started
   * one yet - so the first message CREATES it rather than failing, and the id
   * comes back through onSessionCreated. The room is the only place anyone
   * types; it must not require a CLI to have been opened first.
   */
  sessionId?: string;
  /** room context for the header prepended to every prompt */
  room: string;
  owner: string;
  memberCount: () => number;
  /**
   * codex only: deliver into the RUNNING app session with `codex queue` rather
   * than spawning `codex exec resume`.
   *
   * ON by default, because `exec resume` appends to the thread behind the app's
   * back and a running process never re-reads its own transcript - so the room
   * got the answer and the teammate's Codex window showed nothing at all. That
   * is the same "a live process does not see outside appends" finding that
   * shaped the Claude side; Codex Desktop is just another running process.
   *
   * Verified 2026-09-05 on a teammate's Mac: a queued line appeared in the open
   * Codex app on its own. If a queue ever fails, the run falls through to
   * `exec resume` so the room still gets an answer.
   */
  codexLiveQueue: boolean;
  onSessionCreated: (sessionId: string) => void;
  /** told why a run could not start, so the room can say so instead of hanging */
  onBlocked: (reason: string) => void;
  onNotice: (text: string) => void;
  onState: (running: boolean) => void;
}

interface QueuedRun {
  from: string;
  text: string;
}

/**
 * `claude -p --output-format json` prints an envelope carrying session_id.
 * That is how a conversation we just created tells us its own id, so the next
 * message can resume it instead of starting another one.
 */
function sessionIdFrom(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const id = o.session_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null; // codex, or a non-JSON build: the tailer finds the session anyway
  }
}

export class AgentRunner {
  private readonly opts: RunnerOptions;
  private readonly queue: QueuedRun[] = [];
  private busy = false;
  private blockedNotified = false;
  private readonly dir: string;

  readonly stats = { started: 0, failed: 0 };

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.dir = mkdtempSync(join(tmpdir(), 'atrium-ask-'));
  }

  get running(): boolean {
    return this.busy;
  }
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Queue a prompt. One run at a time - two agents in one folder trip over each
   * other. `from` is who typed it in the room, which the agent needs in order to
   * tell its owner's question from a teammate's.
   */
  run(from: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push({ from, text: trimmed });
    if (!this.busy) void this.drain();
  }

  private argv(resume: boolean): { cmd: string; args: string[] } {
    const id = this.opts.sessionId;
    if (this.opts.agent === 'codex') {
      // `codex exec resume <id>` continues a thread; bare `codex exec` starts one.
      const args = resume && id ? ['exec', 'resume', id] : ['exec'];
      args.push('--skip-git-repo-check');
      if (this.opts.fullAuto) args.push('--full-auto');
      return { cmd: 'codex', args };
    }
    // --output-format json is what lets us read back the session id, which is
    // the only way to learn the id of a conversation we just created.
    const args = ['-p', '--output-format', 'json', '--permission-mode', this.opts.permissionMode];
    if (resume && id) args.push('--resume', id);
    return { cmd: 'claude', args };
  }

  private async drain(): Promise<void> {
    const job = this.queue.shift();
    if (job === undefined) return;

    // Claude accepts a concurrent resume into a live session and appends to the
    // same transcript - but the running process never sees those appends, and
    // the file branches. Verified 2026-09-05. So wait for them to finish their
    // turn rather than fork their conversation behind their back.
    if (this.opts.agent === 'claude' && this.opts.sessionId) {
      if (livenessOf(this.opts.sessionId, liveClaudeSessions()) === 'busy') {
        this.queue.unshift(job);
        // Say it once, not every five seconds. A silent wait is indistinguishable
        // from a hang; a repeating one is just noise in the room.
        if (!this.blockedNotified) {
          this.blockedNotified = true;
          this.opts.onBlocked(`${this.opts.owner} is mid-turn in their terminal — queued`);
        }
        setTimeout(() => {
          if (!this.busy) void this.drain();
        }, 5_000);
        return;
      }
    }
    this.blockedNotified = false;

    this.busy = true;
    this.opts.onState(true);
    this.stats.started++;

    const prompt = buildRoomPrompt(
      {
        room: this.opts.room,
        owner: this.opts.owner,
        from: job.from,
        members: this.opts.memberCount(),
      },
      job.text,
    );

    // Codex can take a message into a RUNNING session; Claude cannot. When this
    // works, the answer comes back through the rollout the tailer already
    // watches, so there is nothing further to do here.
    if (this.opts.agent === 'codex' && this.opts.codexLiveQueue && this.opts.sessionId) {
      if (await this.queueToCodex(prompt)) {
        this.busy = false;
        this.opts.onState(false);
        if (this.queue.length > 0) void this.drain();
        return;
      }
      this.opts.onNotice('codex queue did not deliver - running it instead');
    }

    try {
      const hadPin = Boolean(this.opts.sessionId);
      const ok = await this.once(prompt, hadPin);
      // A pinned id can go stale - the conversation was deleted, or it was never
      // on this machine. Starting a fresh one beats a dead lane, and
      // onSessionCreated repins it so this only happens once.
      if (!ok && hadPin) {
        this.opts.onNotice('the pinned session could not be resumed - starting a new one');
        await this.once(prompt, false);
      }
    } finally {
      this.busy = false;
      this.opts.onState(false);
      if (this.queue.length > 0) void this.drain();
    }
  }

  private once(prompt: string, resume: boolean): Promise<boolean> {
    const file = join(this.dir, `p-${Date.now()}.txt`);
    writeFileSync(file, prompt, 'utf8');

    const { cmd, args } = this.argv(resume);

    return new Promise<boolean>((resolve) => {
      let fd: number;
      try {
        fd = openSync(file, 'r');
      } catch {
        this.fail('could not stage the prompt for the agent');
        resolve(false);
        return;
      }

      // No shell: the npm .cmd shim is resolved to the script it wraps, so
      // arguments stay escaped rather than concatenated. See cliCommand.
      const launch = cliCommand(cmd);
      const child = spawn(launch.cmd, [...launch.prefix, ...args], {
        cwd: this.opts.cwd,
        shell: false,
        stdio: [fd, 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      // The answer itself reaches the room through the transcript. We read
      // stdout only for the small JSON envelope carrying session_id - and we
      // must keep reading it either way, or the pipe fills and stalls the child.
      let stdout = '';
      child.stdout?.on('data', (c: Buffer) => {
        if (stdout.length < 200_000) stdout += c.toString();
      });

      const cleanup = (): void => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
        rmSync(file, { force: true });
      };

      child.on('error', () => {
        cleanup();
        this.fail(`${cmd} is not on PATH on this machine`);
        resolve(false);
      });

      child.on('close', (code) => {
        cleanup();
        if (code === 0) {
          const created = sessionIdFrom(stdout);
          if (created && created !== this.opts.sessionId) {
            this.opts.sessionId = created;
            this.opts.onSessionCreated(created);
          }
          resolve(true);
          return;
        }
        const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
        // a failed resume is retried without it, so stay quiet about that one
        if (!resume) {
          this.fail(detail || `${cmd} exited with code ${code}`);
        }
        resolve(false);
      });
    });
  }

  /**
   * `codex queue --thread <id> --message <text>`.
   *
   * The old code called this with `--session` and the text as a positional
   * argument, neither of which exist, with stdio ignored and the error
   * swallowed - so it failed on every invocation and said nothing. Both flags
   * are required, the text is an argv value rather than a shell word, and a
   * failure is reported.
   */
  private queueToCodex(prompt: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { cmd, prefix } = cliCommand('codex');
      const child = spawn(
        cmd,
        [...prefix, 'queue', '--thread', String(this.opts.sessionId), '--message', prompt],
        { cwd: this.opts.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      child.stdout?.resume();
      child.on('error', () => {
        this.fail('codex is not on PATH on this machine');
        resolve(false);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(true);
          return;
        }
        const detail = stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200);
        this.fail(detail || `codex queue exited with code ${code}`);
        resolve(false);
      });
    });
  }

  private fail(text: string): void {
    this.stats.failed++;
    this.opts.onNotice(text);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
