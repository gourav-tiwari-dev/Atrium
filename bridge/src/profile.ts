import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * What this person answered the first time they ran the launcher.
 *
 * The whole point is that they are asked once and never again - a teammate who
 * has to retype anything every session is back where they started, which is the
 * complaint this exists to fix.
 *
 * `lastUrl` is a fallback, not a cache. If the rendezvous is unreachable at
 * launch, the address that worked last time is a far better guess than failing
 * outright, because most of the time the room has not actually moved.
 *
 * Same home directory and same never-throw discipline as offsets.ts and
 * sessions.ts - a teammate may run this from anywhere, and losing this file
 * costs one question, not data.
 */

export interface Profile {
  name: string;
  lobby: string;
  /** the address that last worked, used only when the rendezvous is unreachable */
  lastUrl?: string;
}

function profilePath(dir?: string): string {
  return join(dir ?? join(homedir(), '.atrium'), 'profile.json');
}

export function loadProfile(dir?: string): Profile | undefined {
  try {
    const p = JSON.parse(readFileSync(profilePath(dir), 'utf8')) as Partial<Profile>;
    if (typeof p.name !== 'string' || !p.name) return undefined;
    if (typeof p.lobby !== 'string' || !p.lobby) return undefined;
    return {
      name: p.name,
      lobby: p.lobby,
      lastUrl: typeof p.lastUrl === 'string' ? p.lastUrl : undefined,
    };
  } catch {
    return undefined; // first run, or the file was removed
  }
}

export function saveProfile(p: Profile, dir?: string): void {
  const path = profilePath(dir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(p, null, 2));
  } catch {
    // Losing the profile costs one question next launch, not data.
  }
}
