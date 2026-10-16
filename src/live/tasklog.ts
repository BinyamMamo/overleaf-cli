/**
 * A local log of every agent edit, one JSON line each, so a task can be
 * reviewed or undone later (even after the agent process restarted).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../config.js';

export interface TaskLogEntry {
  ts: string;
  projectId: string;
  taskId: string;
  task: string;
  path: string;
  section?: string;
  kind: 'edit' | 'undo' | 'suggestion-applied';
  before: string;
  after: string;
}

function logPath(projectId: string): string {
  return join(dirname(getConfigPath()), 'tasks', `${projectId}.jsonl`);
}

export function appendTaskLog(entry: Omit<TaskLogEntry, 'ts'>): void {
  const path = logPath(entry.projectId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
}

export function readTaskLog(projectId: string): TaskLogEntry[] {
  const path = logPath(projectId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as TaskLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TaskLogEntry => e !== null);
}

/** Tasks newest first, with their edits. */
export function listTasks(projectId: string): { taskId: string; task: string; edits: TaskLogEntry[]; undone: boolean }[] {
  const byId = new Map<string, { taskId: string; task: string; edits: TaskLogEntry[]; undone: boolean }>();
  for (const entry of readTaskLog(projectId)) {
    const item = byId.get(entry.taskId) || { taskId: entry.taskId, task: entry.task, edits: [], undone: false };
    if (entry.kind === 'undo') item.undone = true;
    else item.edits.push(entry);
    byId.set(entry.taskId, item);
  }
  return [...byId.values()].reverse();
}
