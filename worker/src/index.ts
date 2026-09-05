/**
 * Where is lobby X right now?
 *
 * The room runs on a laptop behind a Cloudflare quick tunnel, and that hostname
 * is new on every deploy. Teammates were re-pasting a fresh join command every
 * session because of it - the setup felt broken, and the cause was ours, not
 * theirs. This is the one address that does not move, so a lobby NAME can mean
 * something.
 *
 * It stores an address, never a credential. Reading is deliberately public:
 * knowing where the room is gets you nothing without the room token. Writing
 * needs the secret, because publishing moves where the whole team connects.
 */

export interface Env {
  LOBBIES: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
  PUBLISH_SECRET: string;
}

interface Entry {
  url: string;
  updatedAt: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // the room page may be served from a different origin than this Worker
      'access-control-allow-origin': '*',
    },
  });
}

function lobbyFrom(pathname: string): string | null {
  const m = /^\/lobby\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const lobby = lobbyFrom(url.pathname);
    if (!lobby) return json({ error: 'not found' }, 404);

    if (request.method === 'GET') {
      const raw = await env.LOBBIES.get(lobby);
      if (!raw) {
        return json({ error: `no lobby named "${lobby}" has been published` }, 404);
      }
      return json(JSON.parse(raw) as Entry, 200);
    }

    if (request.method === 'POST') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!env.PUBLISH_SECRET || token !== env.PUBLISH_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }

      let body: { url?: unknown };
      try {
        body = (await request.json()) as { url?: unknown };
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      const next = typeof body.url === 'string' ? body.url : '';
      if (!/^wss?:\/\/\S+$/.test(next)) {
        return json({ error: 'url must be a ws:// or wss:// address' }, 400);
      }

      const entry: Entry = { url: next, updatedAt: Date.now() };
      await env.LOBBIES.put(lobby, JSON.stringify(entry));
      return new Response(null, { status: 204 });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
