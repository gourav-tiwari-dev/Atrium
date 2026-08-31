/**
 * Carry what has already been worked out about EchoSphere into the room's
 * project memory, so nobody's agent starts from nothing.
 *
 * This is a one-off migration, not part of the product. It exists because the
 * project ran for weeks before the room did, and that history was sitting in
 * one person's assistant instead of somewhere the team could reach.
 *
 * Deliberately NOT carried over: private notes about individuals, and internal
 * strategy framing about other teams. A shared room is read by everyone.
 *
 * Run: node --no-warnings=ExperimentalWarning scripts/seed-echosphere.ts <origin> <room> <token>
 */

const [origin, room, token] = process.argv.slice(2);
if (!origin || !room || !token) {
  console.error('usage: seed-echosphere.ts <origin> <room> <token>');
  process.exit(1);
}

const MEMORY: Array<[string, string]> = [
  [
    'what-this-is',
    'EchoSphere hackathon (KNOTiC x Agora), track: Coordinated AI Interview Panel. ' +
      'Several AI interviewers share ONE Agora RTC channel, each with its own agent id and its own ' +
      'remote_rtc_uids subscription, plus a coordinator that decides who speaks next. ' +
      'Team of 4, entered 20 Aug 2026. Hybrid, with an offline grand finale in Delhi that at least ' +
      'one member has to attend in person.',
  ],
  [
    'why-agora',
    'This track was chosen over Sales/Negotiation, Classroom Co-Teacher, Multilingual+Escalation and ' +
      'Incident Commander because it is the only one that NEEDS Agora specifically. Vapi and Retell are ' +
      'shaped around a 1:1 call and cannot put several agents in one channel. That sentence is the pitch ' +
      'to the judges and belongs in the submission.',
  ],
  [
    'floor-control',
    'The hard part, and the actual project. If every agent subscribes to "*" they all fire the moment ' +
      'the candidate stops talking. The fix: make the floor an explicit resource. One coordinator holds ' +
      'it and grants turns; agents raise a hand and wait; nobody subscribes to "*", each subscribes only ' +
      'to the uids it was told to hear. The coordinator deciding who speaks next IS the project.',
  ],
  [
    'brief',
    'One shared object that six of the eleven problem-statement requirements collapse into:\n' +
      '  BRIEF { claims[]{text,t,topic}, flags[]{vague|contradicts}, score{}, difficulty }\n' +
      'Built from the Agora live transcript, read by every agent before its turn, rendered as the final ' +
      'assessment. Shared context, difficulty adjustment, contradiction flags, evidence-linked feedback, ' +
      'structured assessment and dynamic follow-ups all fall out of it.',
  ],
  [
    'lanes',
    'Interfaces were frozen on day one so nobody blocks anybody.\n' +
      '  A - Realtime: Agora channel, 3 agent ids, barge-in, timestamped transcript capture.\n' +
      '  B - Coordinator: who speaks next, collisions, interrupt policy. GOURAV OWNS THIS. It is the ' +
      'spine, it is logic rather than web stack, and it can be built offline against a recorded transcript.\n' +
      '  C - Brief and analysis: claims, flags, difficulty controller, assessment renderer.\n' +
      '  D - Surface: candidate UI, live panel view, AI-disclosure banner, recruiter report, demo video.',
  ],
  [
    'differentiators',
    'Everyone will hit the 11-item checklist given weeks, so the score comes from two things beyond it:\n' +
      '1. Measured voice quality - interrupt latency p50/p95, false-interrupt rate, panel collision rate, ' +
      'human-rated turn appropriateness. Numbers, not claims.\n' +
      '2. The panel disagrees with itself, and the split shows in the final score. A single-agent system ' +
      'cannot produce that, which is exactly why it is worth showing.',
  ],
  [
    'the-demo',
    'The problem statement ships its own example scenario: the technical interviewer is satisfied, the ' +
      'product interviewer challenges business impact. That is the stage demo. Rehearse it verbatim - it ' +
      'is the thing judges will have already imagined, so it should land exactly.',
  ],
  [
    'traps',
    '- Timestamp the transcript from minute one. Evidence-linked feedback is painful to retrofit.\n' +
      '- The AI-disclosure banner is about 5 minutes of work and a stated requirement teams forget.\n' +
      '- The submission needs repo + demo video + architecture + a written "how we used Agora". ' +
      'Incomplete submissions may not be evaluated, so one person owns assembling it.\n' +
      '- Anti-goal: do not drift into a general interview-prep app.',
  ],
  [
    'deck',
    'Round II idea-submission deck was built with python-pptx.\n' +
      '  Source + rebuild script: D:\\chrome downloads\\echosphere-build\\\n' +
      '  Output: EchoSphere_IdeaSubmission_FILLED.pptx/.pdf, plus Newbiezz_EchoSphere2026_IdeaSubmission.pdf\n' +
      'WARNING: build_deck.py regenerates the pptx from scratch. Hand edits made in PowerPoint are lost ' +
      'if it is re-run without porting them into the script first.\n' +
      'Layout gotcha: the safe body zone is y 1.80-4.30 inches. Below 4.35 the EchoSphere logo is painted ' +
      'bottom-left and text runs straight through it.',
  ],
  [
    'open-questions',
    '- Whether the 28 Aug 2026 Round II submission actually went in was never confirmed. The correctly ' +
      'named PDF exists on disk, which suggests yes, but nobody has said so.\n' +
      '- Interrupt latency p50/p95 has not been measured, and it is half of differentiator #1.\n' +
      '- The stage demo has not been rehearsed end to end.\n' +
      '- Team roster details (members 2/3/4, emails) were still blank when the deck was built.',
  ],
];

async function main(): Promise<void> {
  const base = origin.replace(/\/$/, '');
  let ok = 0;

  for (const [key, text] of MEMORY) {
    const url = new URL(`${base}/api/room/${encodeURIComponent(room)}/remember`);
    url.searchParams.set('token', token);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, text, by: 'gourav' }),
    });
    if (res.ok) {
      ok++;
      console.log(`  \x1b[32m+\x1b[0m ${key}`);
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      console.log(`  \x1b[31mx\x1b[0m ${key}  ${err.error ?? res.status}`);
    }
  }

  console.log(`\n  ${ok}/${MEMORY.length} written to the room's project memory.\n`);
  process.exit(ok === MEMORY.length ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
