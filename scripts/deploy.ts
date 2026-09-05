/**
 * One command that puts the room on the public internet.
 *
 *   pnpm deploy
 *
 * Starts the server, opens a Cloudflare quick tunnel in front of it, and prints
 * the exact lines to paste to the team. No Cloudflare account, no signup, and
 * HTTPS/WSS work straight away - which matters, because a browser on an https
 * page refuses a plain ws:// socket.
 *
 * Quick tunnels are disposable: Cloudflare can retire the hostname with no
 * warning, and cloudflared does not necessarily exit or log when that happens.
 * The room then looks fine from this machine and is gone for everybody else.
 * So the tunnel is supervised - the public URL is health-checked from outside,
 * and a dead one is replaced automatically.
 *
 * The room name and token live in .atrium/room.json and survive restarts. Only
 * the link changes, which is why it is reprinted loudly every time it does.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishLobby } from '../bridge/src/rendezvous.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_DIR = join(ROOT, '.atrium');
const CONFIG = join(CONFIG_DIR, 'room.json');

/** how often to ask the public internet whether the room is reachable */
const CHECK_MS = 30_000;
/** consecutive failed checks before the tunnel is considered dead */
const STRIKES = 2;

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface RoomConfig {
  room: string;
  token: string;
}

function loadOrCreateRoom(): RoomConfig {
  if (existsSync(CONFIG)) {
    const saved = JSON.parse(readFileSync(CONFIG, 'utf8')) as RoomConfig;
    const next = { room: arg('--room') ?? saved.room, token: arg('--token') ?? saved.token };
    writeFileSync(CONFIG, JSON.stringify(next, null, 2));
    return next;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const next: RoomConfig = {
    room: arg('--room') ?? 'atrium',
    // readable enough to type, long enough not to guess
    token: arg('--token') ?? randomBytes(9).toString('base64url'),
  };
  writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}

/** winget puts it in Program Files; a manual install may just be on PATH. */
function findCloudflared(): string {
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'cloudflared';
}

function banner(publicUrl: string, cfg: RoomConfig, attempt: number): void {
  const host = publicUrl.replace(/^https?:\/\//, '');
  const line = '─'.repeat(74);
  const joinLink = `${publicUrl}/?room=${encodeURIComponent(cfg.room)}&token=${encodeURIComponent(cfg.token)}`;

  console.log(`\n${C.green(line)}`);
  console.log(
    C.bold(
      attempt === 0
        ? '  ATRIUM IS LIVE — send everything below to your team'
        : `  NEW LINK (the old one expired) — resend this to your team`,
    ),
  );
  console.log(C.green(line));
  console.log(`\n  ${C.bold('1. Open this — it fills the room and token in for you')}`);
  console.log(`     ${C.cyan(joinLink)}`);
  console.log(C.dim(`\n     room ${cfg.room}   token ${cfg.token}`));
  console.log(`\n  ${C.bold('2. Run this in a terminal')} ${C.dim('(replace YOURNAME)')}`);
  console.log(
    C.cyan(
      `     pnpm bridge join --url wss://${host}/ws --room ${cfg.room} --token ${cfg.token} --name YOURNAME --allow-ask`,
    ),
  );
  console.log(`\n  ${C.bold('3. Optional — let your agent read the room')}`);
  console.log(
    C.cyan(
      `     claude mcp add atrium -- node "${join(ROOT, 'bridge', 'src', 'cli.ts')}" mcp --origin ${publicUrl} --room ${cfg.room} --token ${cfg.token} --name YOURNAME`,
    ),
  );
  console.log(`\n${C.green(line)}`);
  console.log(C.dim('  Keep this window open. Closing it takes the room down.'));
  console.log(C.dim('  Cloudflare retires these links without warning; a new one prints here.\n'));

  const share = [
    'ATRIUM — join the room',
    '',
    '1. Open this link (room and token are already in it):',
    `   ${joinLink}`,
    '',
    `   room:  ${cfg.room}`,
    `   token: ${cfg.token}`,
    '',
    '2. In a terminal, inside the Atrium folder, run (use your own name):',
    `   pnpm bridge join --url wss://${host}/ws --room ${cfg.room} --token ${cfg.token} --name YOURNAME --allow-ask`,
    '',
    '3. Optional, so your agent can read the room:',
    `   claude mcp add atrium -- node "${join(ROOT, 'bridge', 'src', 'cli.ts')}" mcp --origin ${publicUrl} --room ${cfg.room} --token ${cfg.token} --name YOURNAME`,
    '',
    'If the link stops working, ask for the new one. The room and token never change.',
  ].join('\n');

  writeFileSync(join(ROOT, 'JOIN.txt'), `${share}\n`);
  console.log(C.dim('  Also written to JOIN.txt — paste that into the group chat.\n'));
}

/** Spawn cloudflared and resolve once it announces a hostname. */
function startTunnel(): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      findCloudflared(),
      ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let settled = false;
    const scan = (chunk: Buffer): void => {
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(chunk.toString());
      if (found && !settled) {
        settled = true;
        resolve({ proc, url: found[0] });
      }
    };
    proc.stdout?.on('data', scan);
    proc.stderr?.on('data', scan); // cloudflared announces the URL on stderr

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('cloudflared did not produce a URL in 60s'));
      }
    }, 60_000);
  });
}

/** Ask the public internet, not this machine, whether the room is reachable. */
async function publicHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tell the rendezvous where the room is now.
 *
 * This is what stops teammates being re-issued a join command every deploy -
 * the tunnel hostname changes, this call is what makes that invisible to them.
 * The supervisor calls raise() again when it replaces a dead tunnel, so a
 * replacement is announced exactly the same way the first one is.
 */
async function announce(publicUrl: string, cfg: RoomConfig): Promise<void> {
  const base = process.env.ATRIUM_RENDEZVOUS ?? '';
  const secret = process.env.ATRIUM_PUBLISH_SECRET ?? '';
  if (!base || !secret) {
    console.log(C.dim('  (no rendezvous configured - teammates need the link above)'));
    return;
  }
  const wsUrl = `${publicUrl.replace(/^http/, 'ws')}/ws`;
  try {
    await publishLobby(base, cfg.room, wsUrl, secret);
    console.log(C.green(`  ● announced ${cfg.room} - "Join Atrium.cmd" will find it`));
  } catch (err) {
    // A room that is up but unannounced is recoverable. A deploy that dies
    // because a Worker was unreachable is not.
    console.log(C.yellow(`  ! could not announce the room: ${(err as Error).message}`));
    console.log(C.dim('    the room is running; share the link above until this is fixed'));
  }
}

async function main(): Promise<void> {
  const cfg = loadOrCreateRoom();

  const server: ChildProcess = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' },
  );

  // wait for the server before exposing it, so the tunnel never 502s
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    console.error(C.yellow(`\n  The server did not start. Is port ${PORT} already in use?\n`));
    server.kill();
    process.exit(1);
  }

  let tunnel: ChildProcess | null = null;
  let url = '';
  let attempt = 0;
  let stopping = false;

  async function raise(): Promise<void> {
    console.log(C.dim(attempt === 0 ? '\n  opening a public tunnel…' : '\n  reopening the tunnel…'));
    try {
      const started = await startTunnel();
      tunnel = started.proc;
      url = started.url;
      banner(url, cfg, attempt);
      await announce(url, cfg);
      attempt++;
    } catch (err) {
      console.error(C.red(`\n  could not start cloudflared: ${(err as Error).message}`));
      console.error(C.dim('  winget install --id Cloudflare.cloudflared\n'));
      server.kill();
      process.exit(1);
    }
  }

  await raise();

  // Supervise. A quick tunnel can stop serving while its process stays alive,
  // so trust the public URL rather than the process.
  let strikes = 0;
  const watch = setInterval(() => {
    void (async () => {
      if (stopping || !url) return;
      if (await publicHealthy(url)) {
        if (strikes > 0) console.log(C.green('  ● tunnel healthy again'));
        strikes = 0;
        return;
      }
      strikes++;
      console.log(C.yellow(`  ○ the public link is not answering (${strikes}/${STRIKES})`));
      if (strikes < STRIKES) return;

      strikes = 0;
      tunnel?.kill();
      tunnel = null;
      await raise();
    })();
  }, CHECK_MS);

  const stop = (): void => {
    stopping = true;
    clearInterval(watch);
    tunnel?.kill();
    server.kill();
    console.log(C.dim('\n  room closed.\n'));
    process.exit(0);
  };
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
