import { basename } from 'node:path';
import type { Turn, ParseContext } from '../types.ts';

/**
 * Codex CLI writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Verified against real rollout files on this machine. Record types:
 *
 *   response_item   the conversation stream - THE source of truth
 *     payload.type = message (role user|assistant|developer)
 *                  | function_call | function_call_output
 *                  | custom_tool_call | custom_tool_call_output
 *                  | reasoning
 *   event_msg       a UI mirror of the same content
 *   session_meta / world_state / turn_context   bookkeeping
 *
 * THE TRAP: event_msg/agent_message duplicates response_item/message/assistant
 * one for one (10 and 10 in the sample file). Consuming both puts every Codex
 * answer on screen twice. So: response_item only, event_msg never.
 *
 * Two more real-data quirks:
 *  - the first user message is an injected <environment_context> blob, not
 *    something a human typed
 *  - reasoning carries `encrypted_content` and an empty `summary`, so there is
 *    usually nothing readable to show even when thinking is enabled
 */

export const unknownShapes = new Map<string, number>();

function noteUnknown(payloadType: string, rec: Record<string, unknown>): void {
  const sig = `${payloadType || '<none>'} :: ${Object.keys(rec).sort().join(',')}`.slice(0, 200);
  unknownShapes.set(sig, (unknownShapes.get(sig) ?? 0) + 1);
}

/** message.content blocks are input_text (user) or output_text (assistant). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      const o = b as Record<string, unknown>;
      const t = String(o.type ?? '');
      return t === 'text' || t === 'input_text' || t === 'output_text' ? String(o.text ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Strip the harness-injected context blob nobody typed. */
function cleanPrompt(raw: string): string {
  return raw
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<permissions instructions>[\s\S]*/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .trim();
}

/** function_call.arguments is a JSON string; pull the field that says what it does. */
function argSummary(args: unknown): string {
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'query', 'pattern', 'url']) {
      const v = parsed[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v)) return v.join(' ');
    }
    return '';
  } catch {
    return args.slice(0, 200);
  }
}

export function parseCodexLine(
  line: string,
  ctx: ParseContext,
  defaultSessionId = 'codex',
): Turn[] {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return []; // partial write; the tailer re-delivers whole lines only
  }

  // event_msg mirrors response_item. Taking both double-posts every answer.
  if (rec.type !== 'response_item') return [];

  const payload = rec.payload;
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;

  const ts = Date.parse(String(rec.timestamp ?? '')) || Date.now();
  const base = { ts, agent: 'codex' as const, sessionId: defaultSessionId };
  const id = String(p.id ?? p.call_id ?? `${ts}`);
  const type = String(p.type ?? '');

  switch (type) {
    case 'message': {
      const role = String(p.role ?? '');
      if (role === 'developer') return []; // system prompt, not a team-visible turn

      const raw = textOf(p.content);
      if (role === 'user') {
        const text = cleanPrompt(raw);
        return text ? [{ ...base, kind: 'prompt', text, id: `${id}:p` }] : [];
      }
      if (role === 'assistant') {
        const text = raw.trim();
        return text ? [{ ...base, kind: 'response', text, id }] : [];
      }
      return [];
    }

    case 'function_call':
      return [
        {
          ...base,
          kind: 'tool',
          toolName: String(p.name ?? 'tool'),
          text: argSummary(p.arguments),
          id,
        },
      ];

    case 'custom_tool_call':
      return [
        {
          ...base,
          kind: 'tool',
          toolName: String(p.name ?? 'tool'),
          // input is a raw string (an apply_patch body, say), not JSON
          text: typeof p.input === 'string' ? p.input.split('\n')[0].slice(0, 200) : '',
          id,
        },
      ];

    case 'reasoning': {
      if (!ctx.includeThinking) return [];
      // summary is usually [] and the real content is encrypted - nothing to show
      const summary = Array.isArray(p.summary) ? textOf(p.summary) : '';
      return summary ? [{ ...base, kind: 'thinking', text: summary, id }] : [];
    }

    // tool results are input to the model, not conversation
    case 'function_call_output':
    case 'custom_tool_call_output':
      return [];

    default:
      noteUnknown(type, p);
      return [];
  }
}

/** rollout-2026-08-10T13-02-59-<uuid>.jsonl -> <uuid> */
export function sessionIdFromPath(file: string): string {
  // basename copes with both path separators on Windows, so no escaping here
  const name = basename(file);
  const m = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{8,})\.jsonl$/i.exec(name);
  return m ? m[1] : 'codex';
}
