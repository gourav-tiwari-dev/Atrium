import { spawn } from 'node:child_process';
import { joinRoom, type JoinHandle } from './join.ts';
import { resolveLobby } from './rendezvous.ts';
import { loadProfile, saveProfile, type Profile } from './profile.ts';

/**
 * The launcher a teammate double-clicks.
 *
 * The complaint this exists to fix: "everytime they have to run terminal
 * commands". The cause was ours - `pnpm deploy` bakes a rotating tunnel host
 * into the join command, so every redeploy invalidated everyone's command and
 * somebody had to hand out a new one.
 *
 * So the address is never typed. It is asked for, and - the part that actually
 * matters - asked for AGAIN when it stops working. RoomClient reconnects to the
 * URL it was handed; if the tunnel rotated, that URL is dead forever and it
 * would retry it until someone gave up and sent a message asking for a new
 * link. Re-resolving is what makes this a fix rather than a nicer wrapper
 * around the same failure.
 *
 * It runs the SAME join flow the CLI does, so the person gets a real lane and a
 * working agent - not just a socket.
 */

export interface AppOptions {
  lobby: string;
  token: string;
  rendezvous: string;
  /** override the profile location; tests use this */
  profileDir?: string;
  ask: (question: string) => Promise<string>;
  openBrowser: (url: string) => void;
  onLine: (text: string) => void;
  /** consecutive drops before going back to the rendezvous */
  maxReconnectsBeforeReresolve?: number;
}

export interface AppHandle {
  stop(): void;
  currentUrl(): string;
  /** how many times the rendezvous has been asked - the re-resolve test reads this */
  resolveCount(): number;
}

/** the browser page for a ws address, with the room and token already in it */
export function pageFor(wsUrl: string, lobby: string, token: string): string {
  const http = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
  return `${http}/?room=${encodeURIComponent(lobby)}&token=${encodeURIComponent(token)}`;
}

export function openInBrowser(url: string): void {
  // `start ""` is what opens the default browser on Windows. The empty title
  // argument is required, or start swallows the URL as the window title.
  const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    /* no shell association: the URL was printed too, so this is not fatal */
  });
  child.unref();
}

export async function startApp(opts: AppOptions): Promise<AppHandle> {
  const limit = opts.maxReconnectsBeforeReresolve ?? 4;

  let stored = loadProfile(opts.profileDir);
  if (!stored) {
    const answer = (await opts.ask('What should the room call you? ')).trim();
    stored = { name: answer || 'someone', lobby: opts.lobby };
    saveProfile(stored, opts.profileDir);
  } else if (stored.lobby !== opts.lobby) {
    stored = { ...stored, lobby: opts.lobby };
    saveProfile(stored, opts.profileDir);
  }
  const me: Profile = stored;

  let url = '';
  let resolves = 0;
  let stopped = false;
  let handle: JoinHandle | null = null;
  let drops = 0;
  let announced = false;

  async function findRoom(): Promise<string> {
    resolves++;
    try {
      const lobby = await resolveLobby(opts.rendezvous, opts.lobby);
      saveProfile({ ...me, lastUrl: lobby.url }, opts.profileDir);
      me.lastUrl = lobby.url;
      return lobby.url;
    } catch (err) {
      // A rendezvous outage should not strand someone whose room has not moved.
      if (me.lastUrl) {
        opts.onLine('could not reach the rendezvous — trying the address that worked last time');
        return me.lastUrl;
      }
      throw err;
    }
  }

  function reresolve(): void {
    void (async () => {
      if (stopped) return;
      try {
        const next = await findRoom();
        if (next === url) return; // same address; the client keeps retrying it
        opts.onLine('the room moved — reconnecting');
        url = next;
        connect();
      } catch (err) {
        opts.onLine(`still looking for the room: ${(err as Error).message}`);
      }
    })();
  }

  function connect(): void {
    if (stopped) return;
    handle?.stop();
    handle = joinRoom({
      url,
      room: opts.lobby,
      token: opts.token,
      name: me.name,
      // A teammate whose agent cannot be reached is not really in the room.
      allowAsk: true,
      allowMentions: true,
      catchUp: true,
      quiet: true,
      onStatus: (s) => {
        if (s === 'open') {
          drops = 0;
          if (!announced) {
            announced = true;
            const page = pageFor(url, opts.lobby, opts.token);
            opts.onLine(`connected as ${me.name}`);
            opts.onLine(page);
            opts.openBrowser(page);
          }
          return;
        }
        if (s === 'closed' && !stopped) {
          drops++;
          if (drops >= limit) {
            drops = 0;
            reresolve();
          }
        }
      },
    });
  }

  url = await findRoom();
  opts.onLine(`joining ${opts.lobby}…`);
  connect();

  return {
    stop(): void {
      stopped = true;
      handle?.stop();
    },
    currentUrl: () => url,
    resolveCount: () => resolves,
  };
}
