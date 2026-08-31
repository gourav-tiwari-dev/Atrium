import { DatabaseSync } from 'node:sqlite';
import type { RoomEvent, EventKind, MemoryEntry } from './protocol.ts';

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
      CREATE TABLE IF NOT EXISTS memory (
        room       TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        text       TEXT    NOT NULL,
        updated_by TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room, key)
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

  /**
   * Project memory: the curated understanding of the project, as opposed to
   * `events`, which is only what happened. One row per topic, overwritten in
   * place, so it stays a page you can read rather than a log that grows.
   */
  remember(room: string, key: string, text: string, by: string): void {
    this.db
      .prepare(
        `INSERT INTO memory (room, key, text, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(room, key) DO UPDATE SET
           text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(room, key.trim().toLowerCase(), text, by, Date.now());
  }

  forget(room: string, key: string): void {
    this.db.prepare('DELETE FROM memory WHERE room = ? AND key = ?').run(room, key.trim().toLowerCase());
  }

  memory(room: string): MemoryEntry[] {
    return this.db
      .prepare(
        `SELECT key, text, updated_by AS updatedBy, updated_at AS updatedAt
         FROM memory WHERE room = ? ORDER BY key ASC`,
      )
      .all(room) as unknown as MemoryEntry[];
  }

  /** When did anyone last curate memory? Backs "what has happened since". */
  memoryUpdatedAt(room: string): number {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS t FROM memory WHERE room = ?')
      .get(room) as { t: number | null } | undefined;
    return row?.t ?? 0;
  }

  /** Events after a timestamp, oldest first - the raw material for a digest. */
  since(room: string, ts: number, limit = 400): RoomEvent[] {
    return this.db
      .prepare(
        `SELECT seq, ts, member, agent, kind, text, tool, target
         FROM events WHERE room = ? AND ts > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(room, ts, limit) as unknown as RoomEvent[];
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
