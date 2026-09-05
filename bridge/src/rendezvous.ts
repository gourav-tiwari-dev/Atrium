/**
 * Asking a fixed address where the room currently is.
 *
 * The room's tunnel hostname changes on every deploy. Baking it into a join
 * command is why teammates had to be re-issued one every session, and why the
 * setup felt broken to them. This is the indirection that makes a lobby NAME
 * work - and it keeps working when the room eventually moves to permanent
 * hosting, because only the stored address changes.
 */

export interface Lobby {
  url: string;
  updatedAt: number;
}

/** Set on the machine that runs `pnpm deploy`, and inside Join Atrium.cmd. */
export const DEFAULT_RENDEZVOUS = process.env.ATRIUM_RENDEZVOUS ?? '';

function endpoint(base: string, lobby: string): string {
  return `${base.replace(/\/+$/, '')}/lobby/${encodeURIComponent(lobby)}`;
}

export async function resolveLobby(base: string, lobby: string, timeoutMs = 8000): Promise<Lobby> {
  if (!base) throw new Error('no rendezvous address is configured (set ATRIUM_RENDEZVOUS)');

  let res: Response;
  try {
    res = await fetch(endpoint(base, lobby), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`could not reach the rendezvous at ${base}: ${(err as Error).message}`);
  }

  if (res.status === 404) {
    throw new Error(`the rendezvous has no lobby named "${lobby}" - has the room been deployed?`);
  }
  if (!res.ok) throw new Error(`the rendezvous answered ${res.status} for "${lobby}"`);

  let body: Partial<Lobby>;
  try {
    body = (await res.json()) as Partial<Lobby>;
  } catch {
    throw new Error(`the rendezvous returned something that was not JSON for "${lobby}"`);
  }
  if (typeof body.url !== 'string' || !body.url) {
    throw new Error(`the rendezvous returned no address for "${lobby}"`);
  }
  return {
    url: body.url,
    updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
  };
}

export async function publishLobby(
  base: string,
  lobby: string,
  url: string,
  secret: string,
  timeoutMs = 8000,
): Promise<void> {
  if (!base) throw new Error('no rendezvous address is configured (set ATRIUM_RENDEZVOUS)');
  if (!secret) throw new Error('no publish secret is configured (set ATRIUM_PUBLISH_SECRET)');

  let res: Response;
  try {
    res = await fetch(endpoint(base, lobby), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`could not reach the rendezvous at ${base}: ${(err as Error).message}`);
  }

  if (res.status === 401) throw new Error('the rendezvous refused the publish secret');
  if (!res.ok) throw new Error(`the rendezvous answered ${res.status} when publishing "${lobby}"`);
}
