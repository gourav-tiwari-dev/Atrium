import { DatabaseSync } from 'node:sqlite';
import type { RoomEvent, EventKind } from './protocol.ts';

/**
 * One append-only event log per room, plus the room's shared secret.
 *
 * Uses node:sqlite (built in since Node 22.5) so the server has exactly one
 * dependency - ws - and nothing on the team has to compile a native module.
 *
 * Everything the UI shows is a read over this table. "Decisions" is not a
 * separate store, it is a filter on kind, which is what makes replay-on-join
 * and edit history free.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file = 'atrium.sqlite') {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        id         TEXT PRIMARY KEY,
        token      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        room   TEXT    NOT NULL,
        ts     INTEGER NOT NULL,
        member TEXT    NOT NULL,
        agent  TEXT,
        kind   TEXT    NOT NULL,
        text   TEXT    NOT NULL,
        tool   TEXT,
        target TEXT,
        dedupe TEXT
      );
      CREATE INDEX IF NOT EXISTS events_room_seq ON events(room, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe
        ON events(room, member, dedupe) WHERE dedupe IS NOT NULL;
    `);
  }

  /** Has this room ever been created? Read paths must not create one. */
  roomExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id) !== undefined;
  }

  /** Create on first use; afterwards the token must match. */
  ensureRoom(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT token FROM rooms WHERE id = ?').get(id) as
      | { token: string }
      | undefined;
    if (!row) {
      this.db
        .prepare('INSERT INTO rooms (id, token, created_at) VALUES (?, ?, ?)')
        .run(id, token, Date.now());
      return true;
    }
    return row.token === token;
  }

  /**
   * Append one event. Returns null when `dedupe` has already been seen for this
   * member, which is how a bridge can safely replay a file after a reconnect.
   */
  append(
    room: string,
    e: {
      ts: number;
      member: string;
      agent?: string | null;
      kind: EventKind;
      text: string;
      tool?: string | null;
      target?: string | null;
      dedupe?: string | null;
    },
  ): RoomEvent | null {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO events (room, ts, member, agent, kind, text, tool, target, dedupe)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room,
          e.ts,
          e.member,
          e.agent ?? null,
          e.kind,
          e.text,
          e.tool ?? null,
          e.target ?? null,
          e.dedupe ?? null,
        );
      return {
        seq: Number(info.lastInsertRowid),
        ts: e.ts,
        member: e.member,
        agent: e.agent ?? null,
        kind: e.kind,
        text: e.text,
        tool: e.tool ?? null,
        target: e.target ?? null,
      };
    } catch {
      return null; // unique index hit: already have this turn
    }
  }

  /** Newest `limit` events, returned oldest-first so the UI can just append. */
  recent(room: string, limit = 300): RoomEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, member, agent, kind, text, tool, target
         FROM events WHERE room = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(room, limit) as unknown as RoomEvent[];
    return rows.reverse();
  }

  /** Every decision ever pinned in this room, oldest first. */
  decisions(room: string): RoomEvent[] {
    return this.db
      .prepare(
        `SELECT seq, ts, member, agent, kind, text, tool, target
         FROM events WHERE room = ? AND kind = 'decision' ORDER BY seq ASC`,
      )
      .all(room) as unknown as RoomEvent[];
  }

  /** Mentions aimed at a member, newest first - backs the MCP room_inbox tool. */
  inbox(room: string, target: string, limit = 50): RoomEvent[] {
    return this.db
      .prepare(
        `SELECT seq, ts, member, agent, kind, text, tool, target
         FROM events WHERE room = ? AND kind = 'mention' AND target = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(room, target, limit) as unknown as RoomEvent[];
  }
}
