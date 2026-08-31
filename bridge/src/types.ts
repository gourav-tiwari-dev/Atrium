/** The one shape both vendors converge on. Everything downstream speaks Turn. */
export type TurnKind = 'prompt' | 'response' | 'tool' | 'thinking';

export interface Turn {
  /** epoch ms */
  ts: number;
  /** which agent produced it */
  agent: 'claude' | 'codex';
  /** vendor session id, so lanes can split by session */
  sessionId: string;
  kind: TurnKind;
  text: string;
  /** set when kind === 'tool' */
  toolName?: string;
  /** the folder the session is running in, when the transcript records it */
  cwd?: string;
  /** stable id so replays never double-post */
  id: string;
}

export interface ParseContext {
  /** include assistant reasoning blocks. Off by default: noisy and often private. */
  includeThinking: boolean;
}

export const DEFAULT_PARSE_CONTEXT: ParseContext = { includeThinking: false };
