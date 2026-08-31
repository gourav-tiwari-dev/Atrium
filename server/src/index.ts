import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './db.ts';
import type { ClientMessage, ServerMessage, Member, RoomEvent } from './protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIST = join(HERE, '..', '..', 'web', 'dist');
const store = new Store(process.env.ATRIUM_DB ?? 'atrium.sqlite');

interface Conn {
  ws: WebSocket;
  room: string;
  name: string;
  agent: string | null;
  role: 'bridge' | 'viewer';
  canAsk: boolean;
  alive: boolean;
}

/** room id -> live connections. Presence is derived from this, never stored. */
const rooms = new Map<string, Set<Conn>>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: string, msg: ServerMessage): void {
  const conns = rooms.get(room);
  if (!conns) return;
  const payload = JSON.stringify(msg);
  for (const c of conns) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

/**
 * One row per person, not per connection. Somebody with a browser tab AND a
 * running bridge is one teammate, and the row shows whether their agent is
 * actually streaming.
 */
function members(room: string): Member[] {
  const byName = new Map<string, Member>();
  for (const c of rooms.get(room) ?? []) {
    const existing = byName.get(c.name);
    if (existing) {
      if (c.role === 'bridge') {
        existing.role = 'bridge';
        existing.agent = c.agent;
        existing.canAsk = c.canAsk;
      }
      continue;
    }
    byName.set(c.name, {
      name: c.name,
      agent: c.agent,
      role: c.role,
      canAsk: c.canAsk,
      online: true,
      lastSeen: Date.now(),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function publish(room: string, event: RoomEvent | null): void {
  if (!event) return; // deduped: this turn is already in the log
  broadcast(room, { t: 'event', event });
}

function onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: 'hello' }>): Conn | null {
  const room = msg.room.trim();
  const name = msg.name.trim();

  if (!room || !name) {
    send(ws, { t: 'error', message: 'room and name are required' });
    ws.close();
    return null;
  }
  if (!store.ensureRoom(room, msg.token)) {
    send(ws, { t: 'error', message: 'wrong room token' });
    ws.close();
    return null;
  }

  const conn: Conn = {
    ws,
    room,
    name,
    agent: msg.agent ?? null,
    role: msg.role,
    canAsk: msg.role === 'bridge' && msg.canAsk === true,
    alive: true,
  };
  if (!rooms.has(room)) rooms.set(room, new Set());
  const set = rooms.get(room)!;
  set.add(conn);

  send(ws, {
    t: 'welcome',
    room,
    you: name,
    members: members(room),
    history: store.recent(room),
  });

  // a second tab from the same person is not a new arrival
  const connectionsForName = [...set].filter((c) => c.name === name).length;
  if (connectionsForName === 1) {
    publish(room, store.append(room, { ts: Date.now(), member: name, kind: 'join', text: '' }));
  }
  broadcast(room, { t: 'presence', members: members(room) });
  return conn;
}

function handleMessage(conn: Conn | null, ws: WebSocket, raw: string): Conn | null {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(ws, { t: 'error', message: 'malformed json' });
    return conn;
  }

  if (msg.t === 'ping') {
    send(ws, { t: 'pong' });
    return conn;
  }

  if (msg.t === 'hello') return onHello(ws, msg);

  if (!conn) {
    send(ws, { t: 'error', message: 'say hello first' });
    return null;
  }

  switch (msg.t) {
    case 'turn':
      publish(
        conn.room,
        store.append(conn.room, {
          ts: msg.ts ?? Date.now(),
          member: conn.name,
          agent: msg.agent ?? conn.agent,
          kind: msg.kind,
          text: msg.text,
          tool: msg.tool ?? null,
          dedupe: msg.id ?? null,
        }),
      );
      return conn;

    case 'chat':
      publish(
        conn.room,
        store.append(conn.room, {
          ts: Date.now(),
          member: conn.name,
          kind: 'chat',
          text: msg.text,
        }),
      );
      return conn;

    case 'decision':
      publish(
        conn.room,
        store.append(conn.room, {
          ts: Date.now(),
          member: conn.name,
          kind: 'decision',
          text: msg.text,
        }),
      );
      return conn;

    case 'mention': {
      publish(
        conn.room,
        store.append(conn.room, {
          ts: Date.now(),
          member: conn.name,
          kind: 'mention',
          text: msg.text,
          target: msg.target,
        }),
      );
      // Best-effort live delivery to that person's bridge. If their agent is a
      // Claude session we cannot inject into it, so the mention waits in
      // room_inbox until their agent next reads the room. See README.
      for (const c of rooms.get(conn.room) ?? []) {
        if (c.name === msg.target && c.role === 'bridge') {
          send(c.ws, { t: 'deliver', from: conn.name, text: msg.text });
        }
      }
      return conn;
    }

    case 'notice':
      publish(
        conn.room,
        store.append(conn.room, {
          ts: Date.now(),
          member: conn.name,
          agent: conn.agent,
          kind: 'system',
          text: msg.text,
        }),
      );
      return conn;

    case 'ask': {
      // Route a browser-typed prompt to this person's OWN bridge. Only a bridge
      // started with --allow-ask accepts one; everything else is a no-op that
      // says so, rather than silently doing nothing.
      const targets = [...(rooms.get(conn.room) ?? [])].filter(
        (c) => c.name === conn.name && c.role === 'bridge' && c.canAsk,
      );

      if (targets.length === 0) {
        send(conn.ws, {
          t: 'error',
          message: 'No agent of yours is accepting prompts. Restart your bridge with --allow-ask.',
        });
        return conn;
      }

      for (const c of targets) send(c.ws, { t: 'run', from: conn.name, text: msg.text });
      return conn;
    }

    default:
      return conn;
  }
}

function onClose(conn: Conn): void {
  const set = rooms.get(conn.room);
  if (!set) return;
  set.delete(conn);

  const stillConnected = [...set].some((c) => c.name === conn.name);
  if (!stillConnected) {
    publish(
      conn.room,
      store.append(conn.room, { ts: Date.now(), member: conn.name, kind: 'leave', text: '' }),
    );
  }
  broadcast(conn.room, { t: 'presence', members: members(conn.room) });
  if (set.size === 0) rooms.delete(conn.room);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Read-only HTTP for the MCP server, so an agent can pull room state without
 * holding a socket open. Same token as the websocket - there is one secret.
 *
 * This is the half of the product that removes the re-explaining: an agent
 * that has never been told anything can call room_context and know what the
 * team decided.
 */
function handleApi(url: string, query: URLSearchParams, res: ServerResponse): boolean {
  const match = /^\/api\/room\/([^/]+)\/(context|recent|inbox)$/.exec(url);
  if (!match) return false;

  const room = decodeURIComponent(match[1]);
  const what = match[2];
  const token = query.get('token') ?? '';

  if (!store.roomExists(room)) {
    json(res, 404, { error: 'no such room' });
    return true;
  }
  if (!store.ensureRoom(room, token)) {
    json(res, 403, { error: 'wrong room token' });
    return true;
  }

  const limit = Math.min(Number(query.get('limit') ?? 50) || 50, 300);

  if (what === 'context') {
    json(res, 200, {
      room,
      members: members(room),
      decisions: store.decisions(room).map((d) => ({ text: d.text, by: d.member, ts: d.ts })),
      recentCount: store.recent(room, 1).length,
    });
    return true;
  }

  if (what === 'recent') {
    const kinds = (query.get('kinds') ?? '').split(',').filter(Boolean);
    const rows = store.recent(room, limit).filter((e) => (kinds.length ? kinds.includes(e.kind) : true));
    json(res, 200, { room, events: rows });
    return true;
  }

  // inbox
  const name = query.get('name') ?? '';
  if (!name) {
    json(res, 400, { error: 'name is required' });
    return true;
  }
  json(res, 200, { room, name, mentions: store.inbox(room, name, limit) });
  return true;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  const url = raw.split('?')[0];
  const query = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');

  if (url === '/api/health') {
    json(res, 200, { ok: true, rooms: rooms.size });
    return;
  }

  if (handleApi(url, query, res)) return;

  // normalize first, so ../ cannot climb out of the dist directory
  const rel = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  if (rel.startsWith('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const file = join(WEB_DIST, rel);
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    // SPA fallback, and a readable message before the UI has ever been built
    try {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(await readFile(join(WEB_DIST, 'index.html')));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('atrium server is up. The web UI is not built yet: pnpm web:build');
    }
  }
}

const httpServer = createServer((req, res) => void serveStatic(req, res));
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  let conn: Conn | null = null;

  ws.on('message', (data) => {
    conn = handleMessage(conn, ws, data.toString());
  });

  ws.on('pong', () => {
    if (conn) conn.alive = true;
  });

  ws.on('close', () => {
    if (conn) onClose(conn);
  });

  ws.on('error', () => {
    if (conn) onClose(conn);
  });
});

/** Drop connections that stopped answering, so presence stays honest. */
setInterval(() => {
  for (const conns of rooms.values()) {
    for (const c of [...conns]) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`  atrium server   http://localhost:${PORT}`);
  console.log(`  websocket       ws://localhost:${PORT}/ws`);
});
