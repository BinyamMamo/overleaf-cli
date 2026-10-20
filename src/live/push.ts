/**
 * Push text files as live edits instead of whole-file uploads.
 *
 * `olcli push` replaces a remote file with the local one, which throws away
 * anything a collaborator wrote since your pull. olf keeps the version you
 * last pulled (the base, in .olf/base/) and merges three ways: your changes
 * since the base are moved past their changes since the base, then sent as
 * live edits, so someone typing in the browser is not interrupted.
 *
 * It fails closed. When the live connection or the base is missing, or both
 * sides changed the same words, the file is skipped with a reason instead of
 * being replaced. Replacing needs an explicit `--overwrite`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as http from 'node:http';
import { diffWordsWithSpace } from 'diff';
import type { OverleafClient } from '../client.js';
import { LiveProject } from './session.js';
import { apply, diffOp, transformX, type Op } from './ot.js';
import { BRIDGE_PORT, readBridgeToken } from './bridge.js';

const BASE_DIR = join('.olf', 'base');

export function basePath(dir: string, relPath: string): string {
  return join(dir, BASE_DIR, relPath);
}

export function saveBase(dir: string, relPath: string, content: Buffer | string): void {
  if (Buffer.isBuffer(content) && !isUtf8Text(content)) return;
  try {
    const path = basePath(dir, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  } catch {
    // The base only improves merges; never fail a pull over it.
  }
}

function readBase(dir: string, relPath: string): string | undefined {
  const path = basePath(dir, relPath);
  return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
}

/**
 * Merge local edits into the remote text.
 * Returns the op to send to the remote and the merged result.
 */
export function mergeText(base: string | undefined, remote: string, local: string): { op: Op; merged: string; remoteChanged: boolean } {
  if (base === undefined || base === remote) {
    const op = diffOp(0, remote, local, diffWordsWithSpace);
    return { op, merged: apply(remote, op), remoteChanged: false };
  }
  const mine = diffOp(0, base, local, diffWordsWithSpace);
  const theirs = diffOp(0, base, remote, diffWordsWithSpace);
  const [mineAfterTheirs] = transformX(mine, theirs);
  return { op: mineAfterTheirs, merged: apply(remote, mineAfterTheirs), remoteChanged: true };
}

function isUtf8Text(content: Buffer): boolean {
  if (content.includes(0)) return false;
  return Buffer.from(content.toString('utf-8'), 'utf-8').equals(content);
}

interface BridgeClaim {
  path: string;
  section: string;
  state: string;
  startLine: number;
  endLine: number;
}

function fetchClaims(projectId: string): Promise<BridgeClaim[]> {
  return new Promise(resolve => {
    const token = readBridgeToken();
    if (!token) return resolve([]);
    const req = http.get({ host: '127.0.0.1', port: BRIDGE_PORT, path: `/claims?project=${projectId}`, timeout: 800, headers: { 'X-Olf-Token': token } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')).claims || []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function lineRange(text: string, startLine: number, endLine: number): { start: number; end: number } {
  const lines = text.split('\n');
  const start = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
  const end = lines.slice(0, endLine).reduce((n, l) => n + l.length + 1, 0);
  return { start, end };
}

/** How a file reached Overleaf. */
export type Transport =
  | 'live-edit'      // live edits; nobody else had changed the file since your pull
  | 'live-merge'     // live three-way merge with changes others made since your pull
  | 'live-overwrite' // live edits that make the remote equal your file (--overwrite)
  | 'upload-new'     // new file, uploaded whole
  | 'replace'        // existing file replaced by a whole-file upload
  | 'none';

export interface FileResult {
  path: string;
  transport: Transport;
  outcome: 'applied' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  /** The local file was rewritten with the merged text. */
  localUpdated?: boolean;
}

interface Range { start: number; end: number }

/** Spans of `base` that a word diff to `other` touches (inserts are empty spans). */
export function changedRanges(base: string, other: string): Range[] {
  const ranges: Range[] = [];
  let pos = 0;
  for (const part of diffWordsWithSpace(base, other)) {
    if (part.added) ranges.push({ start: pos, end: pos });
    else if (part.removed) {
      ranges.push({ start: pos, end: pos + part.value.length });
      pos += part.value.length;
    } else pos += part.value.length;
  }
  return ranges;
}

/** Base line numbers where both sides changed the same text. */
export function conflictLines(base: string, remote: string, local: string): number[] {
  const theirs = changedRanges(base, remote);
  const mine = changedRanges(base, local);
  const lines = new Set<number>();
  for (const a of mine) {
    for (const b of theirs) {
      const overlap = a.start === a.end || b.start === b.end
        ? Math.max(a.start, b.start) <= Math.min(a.end, b.end)
        : a.start < b.end && b.start < a.end;
      if (overlap) lines.add(base.slice(0, Math.min(a.start, b.start)).split('\n').length);
    }
  }
  return [...lines].sort((x, y) => x - y);
}

function walkFiles(folder: any, prefix: string, docs: Set<string>, files: Set<string>): void {
  for (const doc of folder?.docs || []) docs.add(prefix + doc.name);
  for (const file of folder?.fileRefs || []) files.add(prefix + file.name);
  for (const child of folder?.folders || []) walkFiles(child, `${prefix}${child.name}/`, docs, files);
}

export interface PushOptions {
  client: OverleafClient;
  projectId: string;
  /** Local project folder (where .olf/base lives). */
  dir: string;
  files: { path: string; content: Buffer; localPath?: string }[];
  /** Allow whole-file replacement and local-wins edits. */
  overwrite: boolean;
  /** Upload one whole file (olcli's upload path). */
  upload: (path: string, content: Buffer) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Send local files to Overleaf, one result per file. Never replaces a text
 * document unless `overwrite` is set.
 */
export async function pushFiles(options: PushOptions): Promise<FileResult[]> {
  const { client, projectId, dir, files, overwrite, upload } = options;
  const results: FileResult[] = [];
  let live: LiveProject | null = null;
  let liveError = process.env.OLF_LIVE_PUSH === 'off' ? 'live pushing is turned off (OLF_LIVE_PUSH=off)' : '';
  if (!liveError) {
    try {
      live = await LiveProject.open(client, projectId);
    } catch (error) {
      liveError = `could not open the live connection (${(error as Error).message})`;
    }
  }

  const docs = new Set<string>();
  const remoteFiles = new Set<string>();
  for (const root of live?.joinInfo?.project?.rootFolder || []) walkFiles(root, '', docs, remoteFiles);
  const claims = live ? await fetchClaims(projectId) : [];

  try {
    for (const [index, file] of files.entries()) {
      const path = file.path.replace(/\\/g, '/');
      try {
        results.push(await pushOne(path, file));
      } catch (error) {
        results.push({ path, transport: 'none', outcome: 'failed', reason: (error as Error).message });
      }
      options.onProgress?.(index + 1, files.length);
    }
  } finally {
    await live?.close().catch(() => {});
  }
  return results;

  async function pushOne(path: string, file: PushOptions['files'][number]): Promise<FileResult> {
    const text = isUtf8Text(file.content);

    if (!live) {
      if (text && !overwrite) {
        return { path, transport: 'none', outcome: 'skipped', reason: `${liveError}; nothing was replaced. Re-run with --overwrite to upload whole files.` };
      }
      await upload(path, file.content);
      return { path, transport: 'replace', outcome: 'applied', reason: overwrite ? 'whole-file upload (--overwrite)' : 'binary file, uploaded whole' };
    }

    if (!docs.has(path) || !text) {
      const exists = docs.has(path) || remoteFiles.has(path);
      await upload(path, file.content);
      return { path, transport: exists ? 'replace' : 'upload-new', outcome: 'applied' };
    }

    const doc = await live.doc(path);
    const local = file.content.toString('utf-8');
    const remote = doc.content;
    if (local === remote) {
      saveBase(dir, path, remote);
      return { path, transport: 'none', outcome: 'unchanged' };
    }

    const base = readBase(dir, path);
    let transport: Transport;
    let op: Op;
    if (base === undefined || base !== remote) {
      const conflicts = base === undefined ? [] : conflictLines(base, remote, local);
      if (!overwrite && base === undefined) {
        return { path, transport: 'none', outcome: 'skipped', reason: 'no record of what you pulled, so a merge could drop changes made on Overleaf. Run "olf sync" (merges), or --overwrite to make Overleaf match your file.' };
      }
      if (!overwrite && conflicts.length) {
        return { path, transport: 'none', outcome: 'skipped', reason: `you and someone on Overleaf both changed the same text (near line ${conflicts.join(', ')}). Resolve it, or --overwrite to keep your version.` };
      }
      if (overwrite && (base === undefined || conflicts.length)) {
        transport = 'live-overwrite';
        op = diffOp(0, remote, local, diffWordsWithSpace);
      } else {
        transport = 'live-merge';
        op = mergeText(base, remote, local).op;
      }
    } else {
      transport = 'live-edit';
      op = diffOp(0, remote, local, diffWordsWithSpace);
    }

    for (const claim of claims.filter(c => c.path === path)) {
      const range = lineRange(remote, claim.startLine, claim.endLine);
      const hits = op.some(c => c.p < range.end && c.p + ('d' in c ? c.d.length : 0) >= range.start);
      if (hits) return { path, transport: 'none', outcome: 'skipped', reason: `the agent is editing "${claim.section}" (lines ${claim.startLine}-${claim.endLine}); push again after it releases` };
    }

    await doc.submit(op);
    await doc.settle();
    saveBase(dir, path, doc.content);
    let localUpdated = false;
    if (transport === 'live-merge' && file.localPath && doc.content !== local) {
      writeFileSync(file.localPath, doc.content);
      localUpdated = true;
    }
    return { path, transport, outcome: 'applied', localUpdated };
  }
}

const TRANSPORT_LABEL: Record<Transport, string> = {
  'live-edit': 'live edit',
  'live-merge': 'live merge',
  'live-overwrite': 'live overwrite',
  'upload-new': 'uploaded (new)',
  replace: 'REPLACED',
  none: '',
};

/** One line per file, for the terminal. */
export function describeResult(r: FileResult): string {
  if (r.outcome === 'unchanged') return `${r.path}: unchanged`;
  if (r.outcome === 'skipped') return `${r.path}: skipped, ${r.reason}`;
  if (r.outcome === 'failed') return `${r.path}: failed, ${r.reason}`;
  const extra = r.localUpdated ? ' (local file updated with the merged text)' : r.reason ? ` (${r.reason})` : '';
  return `${r.path}: ${TRANSPORT_LABEL[r.transport]}${extra}`;
}
