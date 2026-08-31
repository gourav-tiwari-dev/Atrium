/** Wire format shared by the bridge, the server and the browser. */

export type EventKind =
  | 'prompt'    // a human typed this to their own agent
  | 'response'  // their agent answered
  | 'tool'      // their agent ran something
  | 'thinking'  // reasoning, only if that member opted in
  | 'chat'      // a human talking to the room
  | 'decision'  // pinned: what the team settled on
  | 'mention'   // addressed at someone else's agent
  | 'system'    // the bridge reporting something, e.g. an agent run that failed
  | 'join'
  | 'leave';

export interface RoomEvent {
  seq: number;
  ts: number;
  member: string;
  agent: string | null;
  kind: EventKind;
  text: string;
  tool: string | null;
  target: string | null;
}

/** One curated topic in the room's project memory. */
export interface MemoryEntry {
  key: string;
  text: string;
  updatedBy: string;
  updatedAt: number;
}

export interface Member {
  name: string;
  agent: string | null;
  /** a bridge streams an agent; a viewer is a browser tab */
  role: 'bridge' | 'viewer';
  /** true when this person's bridge was started with --allow-ask */
  canAsk: boolean;
  online: boolean;
  lastSeen: number;
}

/** browser or bridge -> server */
export type ClientMessage =
  | { t: 'hello'; room: string; token: string; name: string; agent?: string; role: 'bridge' | 'viewer'; canAsk?: boolean }
  | { t: 'turn'; kind: 'prompt' | 'response' | 'tool' | 'thinking'; text: string; tool?: string; ts?: number; id?: string; agent?: string }
  | { t: 'chat'; text: string }
  | { t: 'decision'; text: string }
  | { t: 'mention'; target: string; text: string }
  /** type a prompt to your own agent from the browser */
  | { t: 'ask'; text: string }
  /** a bridge reporting something to the room, e.g. a failed agent run */
  | { t: 'notice'; text: string }
  /** write or overwrite one topic of project memory */
  | { t: 'remember'; key: string; text: string }
  | { t: 'forget'; key: string }
  | { t: 'ping' };

/** server -> browser or bridge */
export type ServerMessage =
  | { t: 'welcome'; room: string; you: string; members: Member[]; history: RoomEvent[]; memory: MemoryEntry[] }
  | { t: 'memory'; memory: MemoryEntry[] }
  | { t: 'event'; event: RoomEvent }
  | { t: 'presence'; members: Member[] }
  | { t: 'deliver'; from: string; text: string }
  /** server -> a bridge: run this prompt through the local agent */
  | { t: 'run'; from: string; text: string }
  | { t: 'error'; message: string }
  | { t: 'pong' };
