import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Runs a prompt typed in the browser through the local agent.
 *
 * The reply is NOT captured here. Both CLIs append the whole exchange to the
 * transcript this bridge is already tailing, so the prompt and the answer reach
 * the room the same way an interactive turn does. This only has to start the
 * run and report when starting it failed.
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
  /** continue the most recent conversation instead of starting a fresh one */
  continueSession: boolean;
  onNotice: (text: string) => void;
  onState: (running: boolean) => void;
}

export class AgentRunner {
  private readonly opts: RunnerOptions;
  private readonly queue: string[] = [];
  private busy = false;
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

  /** Queue a prompt. One run at a time - two agents in one folder trip over each other. */
  run(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    this.queue.push(text);
    if (!this.busy) void this.drain();
  }

  private argv(): { cmd: string; args: string[] } {
    if (this.opts.agent === 'codex') {
      const args = this.opts.continueSession
        ? ['exec', 'resume', '--last']
        : ['exec'];
      args.push('--skip-git-repo-check');
      if (this.opts.fullAuto) args.push('--full-auto');
      return { cmd: 'codex', args };
    }
    const args = ['-p', '--permission-mode', this.opts.permissionMode];
    if (this.opts.continueSession) args.push('--continue');
    return { cmd: 'claude', args };
  }

  private async drain(): Promise<void> {
    const prompt = this.queue.shift();
    if (prompt === undefined) return;

    this.busy = true;
    this.opts.onState(true);
    this.stats.started++;

    try {
      const ok = await this.once(prompt, this.opts.continueSession);
      // "--continue" fails when there is no previous conversation in this
      // folder. That is a first-run condition, not an error worth showing.
      if (!ok && this.opts.continueSession) await this.once(prompt, false);
    } finally {
      this.busy = false;
      this.opts.onState(false);
      if (this.queue.length > 0) void this.drain();
    }
  }

  private once(prompt: string, continueSession: boolean): Promise<boolean> {
    const file = join(this.dir, `p-${Date.now()}.txt`);
    writeFileSync(file, prompt, 'utf8');

    const saved = this.opts.continueSession;
    this.opts.continueSession = continueSession;
    const { cmd, args } = this.argv();
    this.opts.continueSession = saved;

    return new Promise<boolean>((resolve) => {
      let fd: number;
      try {
        fd = openSync(file, 'r');
      } catch {
        this.fail('could not stage the prompt for the agent');
        resolve(false);
        return;
      }

      const child = spawn(cmd, args, {
        cwd: this.opts.cwd,
        // the npm shims on Windows are .cmd files, which need a shell to launch.
        // Safe here: every argument is a literal, the prompt arrives on stdin.
        shell: true,
        stdio: [fd, 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      // stdout is the answer, which reaches the room through the transcript.
      // Draining it stops the pipe filling up and stalling the child.
      child.stdout?.resume();

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
          resolve(true);
          return;
        }
        const detail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
        // a failed --continue is retried without it, so stay quiet about that one
        if (!continueSession) {
          this.fail(detail || `${cmd} exited with code ${code}`);
        }
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
