import { existsSync, statSync, createReadStream } from 'node:fs';

/**
 * Follow an append-only file and hand back whole lines.
 *
 * Polls size rather than using fs.watch: watch fires inconsistently for appends
 * on Windows, and a 250 ms stat is free next to the cost of missing a turn.
 *
 * Guarantees the parsers depend on:
 *  - a line is only emitted once it is terminated by \n, so no half-written JSON
 *  - truncation or rotation resets cleanly instead of emitting garbage
 *  - `position` is the exact byte reached, so a caller can persist it and pass
 *    it back as `startAt` next run. That is what carries work done while the
 *    bridge was closed into the room instead of losing it; this class holds no
 *    state across processes by itself.
 */
export class Tailer {
  readonly file: string;
  private readonly onLine: (line: string) => void;
  private readonly intervalMs: number;
  private offset: number;
  private carry = '';
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(
    file: string,
    onLine: (line: string) => void,
    opts: { fromStart?: boolean; startAt?: number; intervalMs?: number } = {},
  ) {
    this.file = file;
    this.onLine = onLine;
    this.intervalMs = opts.intervalMs ?? 250;

    if (opts.startAt !== undefined) {
      // Resuming a previous run. Clamp to the current size: if the file shrank
      // it was rotated, and reading from a stale offset would emit garbage.
      this.offset = Math.min(Math.max(opts.startAt, 0), this.currentSize());
    } else {
      this.offset = opts.fromStart ? 0 : this.currentSize();
    }
  }

  private currentSize(): number {
    try {
      return existsSync(this.file) ? statSync(this.file).size : 0;
    } catch {
      return 0;
    }
  }

  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Where we are in the file, so a caller can persist and resume. */
  get position(): number {
    return this.offset;
  }

  private async poll(): Promise<void> {
    if (this.reading) return; // a slow read must not overlap the next tick
    const size = this.currentSize();

    if (size < this.offset) {
      // truncated or rotated - start over rather than read misaligned bytes
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return;

    this.reading = true;
    const from = this.offset;
    try {
      const chunk = await this.read(from, size - 1);
      this.offset = size;
      const text = this.carry + chunk;
      const lines = text.split('\n');
      this.carry = lines.pop() ?? ''; // trailing partial line waits for its \n
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.onLine(trimmed);
      }
    } catch {
      // transient read failure (lock, mid-write): keep the offset, retry next tick
    } finally {
      this.reading = false;
    }
  }

  private read(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(this.file, { start, end, encoding: 'utf8' });
      let data = '';
      stream.on('data', (c) => (data += c));
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
  }
}
