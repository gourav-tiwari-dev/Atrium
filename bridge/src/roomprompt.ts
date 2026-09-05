/**
 * What an agent needs to know before it answers a room message.
 *
 * Two things it cannot work out for itself:
 *
 *  1. WHO ASKED. The room hands the bridge the asker's name and the bridge used
 *     to print it to a console and throw it away, so an agent could not tell its
 *     owner's question from a teammate's. That produced answers addressed to the
 *     wrong person, which is exactly the anomaly this fixes.
 *
 *  2. WHERE THE ANSWER GOES. A reply here is posted to everyone in the room, not
 *     back to one person in private.
 *
 * This is a behavioural steer, not a security boundary. It shapes behaviour
 * reliably in normal use; a determined prompt can talk an agent around its own
 * instructions. A real boundary is a restricted tool set for room-driven runs -
 * recorded in the spec as the upgrade path if the room ever opens beyond the
 * people who already trust each other.
 */

export interface RoomContext {
  room: string;
  /** whose machine this agent runs on */
  owner: string;
  /** who typed the message */
  from: string;
  /** how many people can see the reply */
  members: number;
}

export function buildRoomPrompt(ctx: RoomContext, text: string): string {
  const isOwner = ctx.from === ctx.owner;
  const who = isOwner
    ? `[From: ${ctx.from} — your owner]`
    : `[From: ${ctx.from} — a teammate, NOT your owner ${ctx.owner}]`;

  // The header goes first and the message last, so a message that imitates a
  // header cannot displace the real one - the first [From:] line is always ours.
  return [
    `[Atrium · room "${ctx.room}" · ${ctx.members} people will see your reply]`,
    who,
    '[Shared lobby. Your reply is posted publicly to the room. Do not reveal file',
    ' contents, credentials, or personal memory from this machine unless',
    ` ${ctx.owner} asks for it themselves, here, in this room.]`,
    '',
    `${ctx.from} asks:`,
    text,
  ].join('\n');
}
