import type { Turn, ParseContext } from '../types.ts';

/**
 * Claude Code writes ~/.claude/projects/<slug>/<session-uuid>.jsonl
 *
 * Record types seen in a real 2.6 MB transcript:
 *   assistant | user | attachment | system | file-history-snapshot |
 *   ai-title | agent-name | mode | permission-mode | atis-latch |
 *   last-prompt | queue-operation | file-history-delta
 *
 * Only assistant and user carry conversation. The rest is bookkeeping.
 *
 * THE TRAP: `type:"user"` is NOT the same as "a human typed something".
 * In that same file, 205 user records were tool_result feedback and only
 * 54 were real prompts. Treating them alike floods every lane with noise.
 */

/** Strip harness-injected blocks a teammate never typed and shouldn't broadcast. */
function cleanPrompt(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, '')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-(name|message|args)>/g, '')
    .trim();
}

function toolSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // the field that actually says what the tool is doing, in priority order
  for (const k of ['command', 'file_path', 'pattern', 'query', 'url', 'prompt', 'skill']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export function parseClaudeLine(line: string, ctx: ParseContext): Turn[] {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return []; // partial write mid-append; the tailer will re-deliver a full line
  }

  const type = rec.type;
  if (type !== 'assistant' && type !== 'user') return [];
  if (rec.isSidechain === true) return []; // subagent chatter, not the main thread

  const ts = Date.parse(String(rec.timestamp ?? '')) || Date.now();
  const sessionId = String(rec.sessionId ?? rec.session_id ?? 'unknown');
  const uuid = String(rec.uuid ?? `${ts}`);
  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg) return [];

  const out: Turn[] = [];
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
  const base = { ts, agent: 'claude' as const, sessionId, cwd };

  if (type === 'user') {
    const content = msg.content;

    if (typeof content === 'string') {
      const text = cleanPrompt(content);
      if (text) out.push({ ...base, kind: 'prompt', text, id: `${uuid}:p` });
      return out;
    }

    if (Array.isArray(content)) {
      // A user record holding tool_result blocks is the harness feeding results
      // back to the model. Never a human turn. Drop the whole record.
      const hasToolResult = content.some(
        (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result',
      );
      if (hasToolResult) return [];

      const text = cleanPrompt(
        content
          .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
          .map((b) => String((b as Record<string, unknown>).text ?? ''))
          .join('\n'),
      );
      if (text) out.push({ ...base, kind: 'prompt', text, id: `${uuid}:p` });
    }
    return out;
  }

  // assistant
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  content.forEach((blockRaw, i) => {
    if (!blockRaw || typeof blockRaw !== 'object') return;
    const block = blockRaw as Record<string, unknown>;

    if (block.type === 'text') {
      const text = String(block.text ?? '').trim();
      if (text) out.push({ ...base, kind: 'response', text, id: `${uuid}:${i}` });
      return;
    }

    if (block.type === 'thinking') {
      if (!ctx.includeThinking) return;
      const text = String(block.thinking ?? block.text ?? '').trim();
      if (text) out.push({ ...base, kind: 'thinking', text, id: `${uuid}:${i}` });
      return;
    }

    if (block.type === 'tool_use') {
      const toolName = String(block.name ?? 'tool');
      out.push({
        ...base,
        kind: 'tool',
        toolName,
        text: toolSummary(block.input),
        id: `${uuid}:${i}`,
      });
    }
  });

  return out;
}
