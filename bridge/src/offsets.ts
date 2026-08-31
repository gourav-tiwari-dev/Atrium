import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * How far through each transcript this bridge has already streamed.
 *
 * Without this, the bridge starts at the end of every file, so anything you did
 * while it was closed is dropped on the floor and nobody ever sees it. That is
 * the difference between a room that only knows what you did with it open, and
 * one that knows what you did on the project.
 *
 * Keyed by room and name so two rooms on one machine don't overwrite each
 * other, and stored in the home folder because a teammate may run the bridge
 * from anywhere.
 */

export interface OffsetStore {
  get(file: string): number | undefined;
  set(file: string, offset: number): void;
  save(): void;
}

function storePath(): string {
  return join(homedir(), '.atrium', 'offsets.json');
}

type Saved = Record<string, Record<string, number>>;

export function openOffsets(room: string, name: string): OffsetStore {
  const path = storePath();
  const scope = `${room}::${name}`;

  let all: Saved = {};
  try {
    all = JSON.parse(readFileSync(path, 'utf8')) as Saved;
  } catch {
    all = {}; // first run, or the file was removed: start clean
  }
  const mine: Record<string, number> = all[scope] ?? {};
  let dirty = false;

  return {
    get(file) {
      return mine[file];
    },
    set(file, offset) {
      if (mine[file] === offset) return;
      mine[file] = offset;
      dirty = true;
    },
    save() {
      if (!dirty) return;
      try {
        all[scope] = mine;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(all, null, 2));
        dirty = false;
      } catch {
        // Losing the offsets costs a replay, which dedupe absorbs. Never let it
        // take the bridge down.
      }
    },
  };
}
