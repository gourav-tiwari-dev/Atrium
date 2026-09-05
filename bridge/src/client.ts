import type { Turn } from './types.ts';

/**
 * The bridge's socket to the room.
 *
 * Two things it must never do:
 *  - lose turns while the network is down
 *  - post the same turn twice after it comes back
 *
 * So: queue while disconnected, and stamp every turn with a stable id the
 * server dedupes on. Reconnect is backed off to 15s because a hackathon
 * laptop closes its lid a lot.
 */

export interface ClientOptions {
  url: string;
  room: string;
  token: string;
  name: string;
  agent: string;
  /**
   * What this person types to pick the room up in their own terminal. The
   * server hands it back to the browser so the handoff banner can show the
   * exact command instead of a vague instruction.
   */
  resumeCommand?: string;
  /** tell the server this bridge will run prompts typed in the browser */
  canAsk?: boolean;
  /** also let a teammate's @mention run this agent */
  canMention?: boolean;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  onDeliver?: (from: string, text: string) => void;
  /** the server asking us to run a prompt through the local agent */
  onRun?: (from: string, text: string) => void;
}

interface Outgoing {
  t: 'turn';
  kind: Turn['kind'];
  text: string;
  tool?: string;
  ts: number;
  id: string;
  agent: string;
}

const MAX_QUEUE = 500;

export class RoomClient {
  private ws: WebSocket | null = null;
  private readonly queue: Outgoing[] = [];
  private backoffMs = 500;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** what the caller sees in the status line */
  readonly stats = { sent: 0, queued: 0, reconnects: 0, delivered: 0 };
  /** mentions that arrived for us, newest last - the MCP room_inbox reads this */
  readonly inbox: Array<{ ts: number; from: string; text: string }> = [];
  /**
   * How many people are in the room. The lobby header tells the agent how many
   * will see its reply, so it has to be the live count, not a guess.
   */
  memberCount = 1;

  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.closed) return;
    this.opts.onStatus?.('connecting');

    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = 500;
      ws.send(
        JSON.stringify({
          t: 'hello',
          room: this.opts.room,
          token: this.opts.token,
          name: this.opts.name,
          agent: this.opts.agent,
          role: 'bridge',
          canAsk: this.opts.canAsk === true,
          canMention: this.opts.canMention === true,
          resumeCommand: this.opts.resumeCommand,
        }),
      );
      this.opts.onStatus?.('open');
      this.flush();
    });

    ws.addEventListener('message', (e) => {
      let msg: { t: string; from?: string; text?: string; message?: string; members?: unknown[] };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      // welcome and presence both carry the roster; either refreshes the count
      if (Array.isArray(msg.members)) this.memberCount = msg.members.length;
      if (msg.t === 'deliver' && msg.from && msg.text) {
        this.inbox.push({ ts: Date.now(), from: msg.from, text: msg.text });
        this.stats.delivered++;
        this.opts.onDeliver?.(msg.from, msg.text);
      }
      if (msg.t === 'run' && typeof msg.text === 'string') {
        this.opts.onRun?.(msg.from ?? 'someone', msg.text);
      }
      if (msg.t === 'error') {
        console.error(`\n  server refused the connection: ${msg.message}\n`);
        this.close();
        process.exitCode = 1;
      }
    });

    const retry = () => {
      this.ws = null;
      this.opts.onStatus?.('closed');
      if (this.closed) return;
      this.stats.reconnects++;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    };

    ws.addEventListener('close', retry, { once: true });
    ws.addEventListener('error', () => ws.close(), { once: true });
  }

  send(turn: Turn): void {
    const out: Outgoing = {
      t: 'turn',
      kind: turn.kind,
      text: turn.text,
      tool: turn.toolName,
      ts: turn.ts,
      agent: turn.agent,
      // agent-prefixed so two vendors can never collide on an id
      id: `${turn.agent}:${turn.sessionId}:${turn.id}`,
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(out));
      this.stats.sent++;
      return;
    }

    this.queue.push(out);
    // drop oldest rather than grow without bound if the server stays down
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.stats.queued = this.queue.length;
  }

  /** Report something to the room - a failed agent run, say. */
  notice(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'notice', text }));
    }
  }

  private flush(): void {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(this.queue.shift()));
      this.stats.sent++;
    }
    this.stats.queued = this.queue.length;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
