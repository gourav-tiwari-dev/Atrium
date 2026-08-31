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
 * The room name and token are saved to .atrium/room.json so the team's
 * credentials survive a restart. Only the tunnel URL changes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const CONFIG_DIR = join(ROOT, '.atrium');
const CONFIG = join(CONFIG_DIR, 'room.json');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
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
    const room = arg('--room') ?? saved.room;
    const token = arg('--token') ?? saved.token;
    const next = { room, token };
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

function banner(publicUrl: string, cfg: RoomConfig): void {
  const host = publicUrl.replace(/^https?:\/\//, '');
  const line = '─'.repeat(74);

  console.log(`\n${C.green(line)}`);
  console.log(C.bold('  ATRIUM IS LIVE — send everything below to your team'));
  console.log(C.green(line));
  console.log(`\n  ${C.bold('1. Open this in a browser')}`);
  console.log(`     ${C.cyan(publicUrl)}`);
  console.log(`\n     room:   ${C.bold(cfg.room)}`);
  console.log(`     token:  ${C.bold(cfg.token)}`);
  console.log(`\n  ${C.bold('2. Run this in a terminal')} ${C.dim('(replace YOURNAME)')}`);
  console.log(C.cyan(`     pnpm bridge join --url wss://${host}/ws --room ${cfg.room} --token ${cfg.token} --name YOURNAME`));
  console.log(`\n  ${C.bold('3. Optional — let your agent read the room')}`);
  console.log(C.dim('     Claude Code:'));
  console.log(C.cyan(`     claude mcp add atrium -- node "${join(ROOT, 'bridge', 'src', 'cli.ts')}" mcp --origin ${publicUrl} --room ${cfg.room} --token ${cfg.token} --name YOURNAME`));
  console.log(`\n${C.green(line)}`);
  console.log(C.dim('  Keep this window open. Closing it takes the room down.'));
  console.log(C.dim(`  The link changes every restart; the room and token do not.\n`));

  const share = [
    'ATRIUM — join the room',
    '',
    '1. Open this link:',
    `   ${publicUrl}`,
    `   room:  ${cfg.room}`,
    `   token: ${cfg.token}`,
    '',
    '2. In a terminal, inside the atrium folder, run (use your own name):',
    `   pnpm bridge join --url wss://${host}/ws --room ${cfg.room} --token ${cfg.token} --name YOURNAME`,
    '',
    '3. Optional, so your agent can read the room:',
    `   claude mcp add atrium -- node "${join(ROOT, 'bridge', 'src', 'cli.ts')}" mcp --origin ${publicUrl} --room ${cfg.room} --token ${cfg.token} --name YOURNAME`,
    '',
    'The link changes if the host restarts. The room and token stay the same.',
  ].join('\n');

  writeFileSync(join(ROOT, 'JOIN.txt'), `${share}\n`);
  console.log(C.dim(`  Also written to JOIN.txt — paste that into the group chat.\n`));
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
    console.error(C.yellow('\n  The server did not start. Is port ' + PORT + ' already in use?\n'));
    server.kill();
    process.exit(1);
  }

  console.log(C.dim('\n  opening a public tunnel…'));

  const tunnel = spawn(
    findCloudflared(),
    ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let announced = false;
  const scan = (chunk: Buffer): void => {
    const text = chunk.toString();
    const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (found && !announced) {
      announced = true;
      banner(found[0], cfg);
    }
  };
  tunnel.stdout?.on('data', scan);
  tunnel.stderr?.on('data', scan); // cloudflared prints the URL on stderr

  tunnel.on('error', () => {
    console.error(C.yellow('\n  cloudflared is not installed.'));
    console.error(C.dim('  winget install --id Cloudflare.cloudflared\n'));
    server.kill();
    process.exit(1);
  });

  const stop = (): void => {
    tunnel.kill();
    server.kill();
    console.log(C.dim('\n  room closed.\n'));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  tunnel.on('exit', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
