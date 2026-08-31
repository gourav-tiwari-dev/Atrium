/**
 * Boots a room with realistic content so the UI can be looked at.
 * Run: node --no-warnings=ExperimentalWarning scripts/demo.ts [seconds]
 * Then open http://localhost:8787  (room "echosphere", token "demo")
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const DB = join(ROOT, 'demo.sqlite');
const ROOM = 'echosphere';
const TOKEN = 'demo';
const SECONDS = Number(process.argv[2] ?? 120);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clean = () => { for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true }); };

interface Seed {
  who: string;
  agent: string;
  kind: 'prompt' | 'response' | 'tool';
  text: string;
  tool?: string;
}

const SCRIPT: Seed[] = [
  { who: 'gourav', agent: 'claude', kind: 'prompt', text: 'if all three panel agents subscribe to "*", they all fire when the candidate stops talking. how do we stop that?' },
  { who: 'gourav', agent: 'claude', kind: 'response', text: 'Make the floor an explicit resource. One coordinator holds it; agents raise a hand and wait to be granted. Nobody subscribes to "*" - each agent subscribes only to remote_rtc_uids it was told to hear.' },
  { who: 'gourav', agent: 'claude', kind: 'tool', tool: 'Write', text: 'coordinator/floor.py' },
  { who: 'meera', agent: 'codex', kind: 'prompt', text: 'build the BRIEF object from the agora transcript, claims with timestamps' },
  { who: 'meera', agent: 'codex', kind: 'response', text: 'BRIEF { claims[]{text,t,topic}, flags[]{vague|contradicts}, score{}, difficulty }. Every agent reads it before its turn and the final assessment renders straight from it.' },
  { who: 'meera', agent: 'codex', kind: 'tool', tool: 'shell_command', text: 'python -m pytest tests/test_brief.py -q' },
  { who: 'arjun', agent: 'claude', kind: 'prompt', text: 'what does the recruiter actually see at the end?' },
  { who: 'arjun', agent: 'claude', kind: 'response', text: 'One report: the score, the split where the panel disagreed, and every claim linked to its timestamp in the recording. The disagreement is the differentiator - a single-agent system cannot produce it.' },
  { who: 'gourav', agent: 'claude', kind: 'prompt', text: 'meera already has a transcript parser. do not write a second one.' },
  { who: 'gourav', agent: 'claude', kind: 'response', text: 'Checked room_recent - meera/codex built the BRIEF parser 6 minutes ago. Importing hers instead of writing a new one.' },
];

async function main(): Promise<void> {
  clean();
  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')],
    { env: { ...process.env, PORT: String(PORT), ATRIUM_DB: DB }, stdio: 'inherit' },
  );

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    await sleep(150);
  }

  const sockets = new Map<string, WebSocket>();
  async function bridgeFor(name: string, agent: string): Promise<WebSocket> {
    const existing = sockets.get(name);
    if (existing) return existing;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));
    ws.send(JSON.stringify({ t: 'hello', room: ROOM, token: TOKEN, name, agent, role: 'bridge' }));
    sockets.set(name, ws);
    await sleep(120);
    return ws;
  }

  for (const [name, agent] of [['gourav', 'claude'], ['meera', 'codex'], ['arjun', 'claude']] as const) {
    await bridgeFor(name, agent);
  }

  const gourav = sockets.get('gourav')!;
  gourav.send(JSON.stringify({ t: 'decision', text: 'the coordinator owns floor control - no agent subscribes to "*"' }));
  gourav.send(JSON.stringify({ t: 'decision', text: 'BRIEF is one shared JSON object; six of the eleven requirements fall out of it' }));
  sockets.get('meera')!.send(JSON.stringify({ t: 'decision', text: 'lanes A/B/C/D frozen day one so nobody blocks' }));

  const memory: Array<[string, string]> = [
    ['what-this-is', 'A Coordinated AI Interview Panel on Agora: three AI interviewers in ONE rtc channel, plus a coordinator that decides who speaks.'],
    ['floor-control', 'The hard part. If every agent subscribes to "*" they all fire the moment the candidate stops. One coordinator holds the floor and grants turns; agents subscribe only to the uids they were told to hear.'],
    ['brief', 'BRIEF { claims[]{text,t,topic}, flags[]{vague|contradicts}, score{}, difficulty }. Built from the live transcript, read by every agent before its turn, rendered as the final assessment. Six of the eleven requirements fall out of it.'],
    ['why-agora', 'Agora is the only stack that puts several agents in one channel with their own ids. Vapi and Retell are 1:1 call shaped and cannot do it. This is the pitch to the judges.'],
    ['lanes', 'A realtime (channel, agent ids, barge-in). B coordinator (who speaks next) - gourav. C brief and analysis. D surface (candidate UI, recruiter report).'],
    ['open-questions', 'Interrupt latency p50/p95 not measured yet. Nobody has rehearsed the stage demo end to end.'],
  ];
  for (const [key, text] of memory) {
    gourav.send(JSON.stringify({ t: 'remember', key, text }));
    await sleep(60);
  }
  await sleep(200);

  let n = 0;
  for (const s of SCRIPT) {
    const ws = await bridgeFor(s.who, s.agent);
    ws.send(JSON.stringify({ t: 'turn', kind: s.kind, text: s.text, tool: s.tool, agent: s.agent, id: `seed-${n++}` }));
    await sleep(90);
  }

  sockets.get('arjun')!.send(JSON.stringify({ t: 'chat', text: 'panel view is wired to the live BRIEF now' }));
  sockets.get('meera')!.send(JSON.stringify({ t: 'chat', text: 'nice. i am still on the contradiction flags' }));
  gourav.send(JSON.stringify({ t: 'mention', target: 'meera', text: 'can your agent expose the parser as a function so mine can import it?' }));
  await sleep(300);

  console.log(`\n  demo room ready:  http://localhost:${PORT}   room "${ROOM}"  token "${TOKEN}"`);
  console.log(`  running for ${SECONDS}s\n`);

  await sleep(SECONDS * 1000);
  for (const ws of sockets.values()) ws.close();
  server.kill();
  await sleep(200);
  clean();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
