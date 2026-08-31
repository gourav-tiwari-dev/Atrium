import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The read-back half of Atrium.
 *
 * The bridge pushes what your agent says INTO the room. This lets your agent
 * pull what the room knows back OUT - so a session that was told nothing can
 * still answer "what did the team decide about floor control?".
 *
 * It runs as its own short-lived stdio process (that is how MCP clients work),
 * talks to the room server over plain HTTP, and holds no state of its own.
 */

export interface McpOptions {
  /** http origin of the room server, e.g. http://localhost:8787 */
  origin: string;
  room: string;
  token: string;
  /** whose inbox room_inbox reads */
  name: string;
}

interface Decision {
  text: string;
  by: string;
  ts: number;
}

interface MemoryEntry {
  key: string;
  text: string;
  updatedBy: string;
  updatedAt: number;
}

interface RoomEventLite {
  ts: number;
  member: string;
  agent: string | null;
  kind: string;
  text: string;
  tool: string | null;
  target: string | null;
}

function when(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

export async function runMcpServer(opts: McpOptions): Promise<void> {
  const base = opts.origin.replace(/\/$/, '');

  async function post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(`${base}/api/room/${encodeURIComponent(opts.room)}/${path}`);
    url.searchParams.set('token', opts.token);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `room server returned ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async function api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${base}/api/room/${encodeURIComponent(opts.room)}/${path}`);
    url.searchParams.set('token', opts.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `room server returned ${res.status}`);
    }
    return (await res.json()) as T;
  }

  const server = new Server(
    { name: 'atrium', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'room_context',
        description:
          'Who is in the room and what the team has decided. Call this BEFORE answering any ' +
          'question about project decisions, architecture or who owns what. For the fuller ' +
          'picture of what the project is and how it got here, also call room_memory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'room_recent',
        description:
          "Recent activity from every teammate's agent: their prompts, their agents' answers, and " +
          'the tools those agents ran. Use it to find out what someone else already tried before ' +
          'redoing it.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'how many events (default 40, max 300)' },
            kinds: {
              type: 'string',
              description: "comma separated filter, e.g. 'prompt,response' or 'decision'",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'room_memory',
        description:
          "The team's project memory: the accumulated understanding of what this project is, " +
          'how it is built, and how it got here. This is the durable page, not the activity ' +
          'feed. Read it at the start of any task so you are not starting from nothing.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'room_remember',
        description:
          'Write or overwrite one topic of the project memory, so it survives past this ' +
          "conversation and every teammate's agent can read it. Use it when something is " +
          'settled and worth keeping: an architecture choice and why, what a lane owns, a ' +
          'constraint that was discovered the hard way. Overwrite the same key to keep it ' +
          'current rather than piling up near-duplicates.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: "topic name, e.g. 'architecture', 'floor-control', 'lanes', 'open-questions'",
            },
            text: { type: 'string', description: 'the current understanding of that topic' },
          },
          required: ['key', 'text'],
          additionalProperties: false,
        },
      },
      {
        name: 'room_digest',
        description:
          'Everything that has happened in the room since project memory was last updated, ' +
          'alongside the memory itself. Use it to catch up after being away, and to decide ' +
          'what is worth writing back with room_remember. This is how a raw activity feed ' +
          'becomes something the next person can read.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'max events (default 200)' } },
          additionalProperties: false,
        },
      },
      {
        name: 'room_inbox',
        description:
          'Messages other people addressed to THIS agent and that have not been delivered into the ' +
          'session yet. Check this at the start of a task.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      if (req.params.name === 'room_context') {
        const data = await api<{
          members: Array<{ name: string; agent: string | null; role: string }>;
          decisions: Decision[];
        }>('context');

        const lines: string[] = [`Room: ${opts.room}`, ''];

        lines.push('In the room:');
        if (data.members.length === 0) lines.push('  (nobody connected)');
        for (const m of data.members) {
          lines.push(`  - ${m.name}${m.role === 'bridge' ? ` (agent: ${m.agent ?? 'unknown'})` : ' (viewing)'}`);
        }

        lines.push('', 'Decisions the team has pinned:');
        if (data.decisions.length === 0) {
          lines.push('  (none yet)');
        } else {
          for (const d of data.decisions) lines.push(`  - ${d.text}   [${d.by}, ${when(d.ts)}]`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (req.params.name === 'room_recent') {
        const limit = String(Math.min(Number(args.limit ?? 40) || 40, 300));
        const kinds = typeof args.kinds === 'string' ? args.kinds : '';
        const data = await api<{ events: RoomEventLite[] }>('recent', { limit, kinds });

        if (data.events.length === 0) {
          return { content: [{ type: 'text', text: 'Nothing in the room yet.' }] };
        }

        const lines = data.events.map((e) => {
          const who = e.agent ? `${e.member}/${e.agent}` : e.member;
          const label = e.kind === 'tool' ? `ran ${e.tool}` : e.kind;
          const text = e.text.replace(/\s+/g, ' ').trim();
          return `[${when(e.ts)}] ${who} ${label}: ${text.slice(0, 400)}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (req.params.name === 'room_memory') {
        const data = await api<{ memory: MemoryEntry[] }>('memory');
        if (data.memory.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'Project memory is empty. If you learn something durable about this project, write it with room_remember.',
            }],
          };
        }
        const lines = data.memory.map(
          (m) => `## ${m.key}\n${m.text}\n(last updated by ${m.updatedBy}, ${when(m.updatedAt)})`,
        );
        const rendered = `Project memory for ${opts.room}\n\n${lines.join('\n\n')}`;
        return { content: [{ type: 'text', text: rendered }] };
      }

      if (req.params.name === 'room_remember') {
        const key = String(args.key ?? '').trim();
        const text = String(args.text ?? '').trim();
        if (!key || !text) {
          return { content: [{ type: 'text', text: 'Both key and text are required.' }], isError: true };
        }
        await post('remember', { key, text, by: opts.name });
        return { content: [{ type: 'text', text: `Saved to project memory under "${key.toLowerCase()}". Everyone's agent can read it now.` }] };
      }

      if (req.params.name === 'room_digest') {
        const limit = String(Math.min(Number(args.limit ?? 200) || 200, 400));
        const data = await api<{
          memoryUpdatedAt: number;
          memory: MemoryEntry[];
          events: RoomEventLite[];
        }>('digest', { limit });

        const parts: string[] = [];
        parts.push(
          data.memory.length === 0
            ? 'Project memory is currently EMPTY.'
            : `Project memory covers: ${data.memory.map((m) => m.key).join(', ')}`,
        );

        if (data.events.length === 0) {
          parts.push('\nThe room has no activity yet.');
        } else {
          const mark = data.memoryUpdatedAt;
          parts.push(
            mark === 0
              ? `\n${data.events.length} event(s). Memory has never been written, so all of this is uncovered:\n`
              : `\n${data.events.length} event(s). Anything marked NEW happened after memory was last updated:\n`,
          );
          for (const e of data.events) {
            const who = e.agent ? `${e.member}/${e.agent}` : e.member;
            const label = e.kind === 'tool' ? `ran ${e.tool}` : e.kind;
            const flag = mark > 0 && e.ts > mark ? 'NEW ' : '    ';
            parts.push(
              `${flag}[${when(e.ts)}] ${who} ${label}: ${e.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
            );
          }
          parts.push(
            '\nIf any of this changes what the project IS - not just what happened - write it back with room_remember.',
          );
        }
        return { content: [{ type: 'text', text: parts.join('\n') }] };
      }

      if (req.params.name === 'room_inbox') {
        const data = await api<{ mentions: RoomEventLite[] }>('inbox', { name: opts.name });
        if (data.mentions.length === 0) {
          return { content: [{ type: 'text', text: 'No messages addressed to you.' }] };
        }
        const lines = data.mentions
          .slice()
          .reverse()
          .map((m) => `[${when(m.ts)}] ${m.member} -> you: ${m.text}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    } catch (err) {
      // A dead room server must not look like "the team decided nothing".
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Could not reach the atrium room: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
