import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliCommand, detectAgent } from './launch.ts';
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
  /**
   * Register Atrium as an MCP server for this machine's agent. Default true.
   * Tests turn it off - otherwise every run would rewrite the real Claude or
   * Codex config on this machine with throwaway lobby and token values.
   */
  registerMcpServer?: boolean;
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

/** The command that opens a URL in the default browser, per platform. */
export function browserOpener(url: string, platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    // `start ""` needs the empty title argument, or start swallows the URL as
    // the window title and opens nothing.
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function openInBrowser(url: string, onFail?: (why: string) => void): void {
  const { cmd, args } = browserOpener(url);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // Do not swallow this. The room still works - the URL was printed - but
    // someone staring at a window that did not open deserves to be told why.
    onFail?.(`could not open your browser (${cmd}); open the link above yourself`);
  });
  child.unref();
}

/**
 * Register Atrium as an MCP server for whichever agent CLI this person uses.
 *
 * The room already exposes decisions and project memory through `room_context`
 * and `room_memory` - but reaching them needed a `claude mcp add …` line nobody
 * on the team ever ran, so in practice no agent could read what the team had
 * decided. Doing it here means nobody has to know the command exists.
 *
 * It registers against the RENDEZVOUS, not a room address: a registration
 * outlives many deploys, and a baked-in tunnel hostname would be wrong by the
 * next morning, silently. Remove-then-add so an older stale entry is replaced.
 *
 * Failure is not fatal. The room works; the agent just cannot read it.
 */
function registerMcp(
  agent: 'claude' | 'codex',
  opts: AppOptions,
  name: string,
): { ok: boolean; detail: string } {
  const { cmd, prefix } = cliCommand(agent);
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const run = (args: string[]) =>
    spawnSync(cmd, [...prefix, ...args], { timeout: 30_000, shell: false, encoding: 'utf8' });

  run(['mcp', 'remove', 'atrium']); // may not exist; that is fine

  const r = run([
    'mcp', 'add', 'atrium', '--',
    process.execPath, '--no-warnings=ExperimentalWarning', cliPath, 'mcp',
    '--lobby', opts.lobby,
    '--token', opts.token,
    '--rendezvous', opts.rendezvous,
    '--name', name,
  ]);
  if (r.error) return { ok: false, detail: String((r.error as NodeJS.ErrnoException).code ?? r.error) };
  if (r.status !== 0) {
    return { ok: false, detail: `${(r.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 120) };
  }
  return { ok: true, detail: '' };
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

  // Give this person's agent read access to the room's decisions and memory.
  // Once per launch, so it self-heals if a config was edited or the CLI changed.
  if (opts.registerMcpServer !== false) {
    const mcp = registerMcp(detectAgent(), opts, me.name);
    opts.onLine(
      mcp.ok
        ? 'your agent can now read the room (decisions, project memory)'
        : `your agent cannot read the room yet: ${mcp.detail || 'mcp add failed'}`,
    );
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
