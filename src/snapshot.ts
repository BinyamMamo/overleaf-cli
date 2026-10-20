/**
 * Git snapshots of an Overleaf project.
 *
 * Overleaf's free plan keeps no browsable history. olf keeps its own: each
 * snapshot downloads the project as Overleaf has it right now and commits it
 * to a local Git repository, one repository per project. Snapshots are taken
 * on request and automatically when an agent finishes a task, so every agent
 * change can be compared and restored. The repository can be pushed to a
 * private GitHub repository as an off-site backup.
 *
 * A snapshot is a copy of the project at one moment. It does not replay every
 * keystroke between two snapshots; Overleaf's own history (paid plans) does.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import type { OverleafClient } from './client.js';
import { getConfigPath } from './config.js';
import { resolveWithin } from './paths.js';
import { pushFiles, type FileResult } from './live/push.js';

/** Files never committed, even if they are in the Overleaf project. */
const EXCLUDED = [/^\.olauth$/, /(^|\/)\.env(\..*)?$/, /(^|\/)id_(rsa|ed25519)(\.pub)?$/, /\.(pem|key|p12|pfx)$/i];
/** Folder inside a snapshot for build output (PDF, log, manifest). Never restored. */
export const BUILD_DIR = '_olf-build';

export function snapshotRepoDir(projectId: string): string {
  const root = process.env.OLF_SNAPSHOT_DIR || join(dirname(getConfigPath()), 'snapshots');
  return join(root, projectId);
}

function git(dir: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function gitOk(dir: string, args: string[]): boolean {
  return spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }).status === 0;
}

export function hasGit(): boolean {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function ensureRepo(dir: string, projectName: string): void {
  if (!hasGit()) throw new Error('Snapshots need Git. Install git and try again.');
  if (existsSync(join(dir, '.git'))) return;
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  // Commit as the user if Git knows them, otherwise as olf.
  if (!gitOk(dir, ['config', 'user.email'])) {
    git(dir, ['config', 'user.name', 'olf']);
    git(dir, ['config', 'user.email', 'olf@localhost']);
  }
  writeFileSync(join(dir, '.olf-snapshots'), `Snapshots of the Overleaf project "${projectName}", made by olf.\n`, 'utf-8');
}

function clearWorktree(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === '.olf-snapshots') continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function excluded(path: string): boolean {
  return EXCLUDED.some(re => re.test(path));
}

function extractZip(zip: Buffer, dir: string): string[] {
  const written: string[] = [];
  for (const entry of new AdmZip(zip).getEntries()) {
    if (entry.isDirectory || excluded(entry.entryName)) continue;
    const target = resolveWithin(dir, entry.entryName);
    if (!target) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
    written.push(entry.entryName);
  }
  return written;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface SnapshotInfo {
  commit: string;
  date: string;
  message: string;
}

export interface SaveResult {
  created: boolean;
  commit: string;
  message: string;
  files: number;
  changed: string;
  repo: string;
  pdf?: { status: string; included: boolean };
  push?: { ok: boolean; error?: string };
}

export interface SaveOptions {
  message?: string;
  taskId?: string;
  /** Compile and keep the PDF, log and a manifest with file hashes (a submission snapshot). */
  pdf?: boolean;
  push?: boolean;
}

/** Download the project as it is now and commit it. */
export async function saveSnapshot(client: OverleafClient, projectId: string, options: SaveOptions = {}): Promise<SaveResult> {
  const project = await client.getProjectById(projectId);
  const name = project?.name || projectId;
  const dir = snapshotRepoDir(projectId);
  ensureRepo(dir, name);

  const zip = await client.downloadProject(projectId);
  clearWorktree(dir);
  const files = extractZip(zip, dir);

  let pdf: SaveResult['pdf'];
  if (options.pdf) {
    const build = await client.compileWithOutputs(projectId);
    const buildDir = join(dir, BUILD_DIR);
    mkdirSync(buildDir, { recursive: true });
    const manifest: Record<string, unknown> = {
      project: name,
      projectId,
      compiledAt: new Date().toISOString(),
      status: build.status,
      sources: Object.fromEntries(files.map(f => [f, sha256(readFileSync(join(dir, f)))])),
    };
    let included = false;
    for (const out of build.outputFiles.filter(f => f.path === 'output.pdf' || f.path === 'output.log')) {
      const data = await client.downloadOutputFile(out.url);
      writeFileSync(join(buildDir, out.path), data);
      (manifest as any)[out.path] = sha256(data);
      if (out.path === 'output.pdf') included = true;
    }
    writeFileSync(join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    pdf = { status: build.status, included };
  }

  git(dir, ['add', '-A']);
  const staged = !gitOk(dir, ['diff', '--cached', '--quiet']);
  const hasHead = gitOk(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  const message = options.message?.trim() || `Snapshot of "${name}"`;
  if (!staged && hasHead && !options.taskId) {
    return { created: false, commit: git(dir, ['rev-parse', '--short', 'HEAD']), message: git(dir, ['log', '-1', '--format=%s']), files: files.length, changed: 'no changes since the last snapshot', repo: dir, pdf };
  }
  const trailers = [`Overleaf-Project: ${name} (${projectId})`];
  if (options.taskId) trailers.push(`olf-Task: ${options.taskId}`);
  git(dir, ['commit', '-q', '--allow-empty', '-F', '-'], `${message}\n\n${trailers.join('\n')}\n`);
  const commit = git(dir, ['rev-parse', '--short', 'HEAD']);
  const changed = hasHead ? git(dir, ['diff', '--shortstat', 'HEAD~1', 'HEAD']) || 'no file changes' : `first snapshot, ${files.length} files`;

  const result: SaveResult = { created: true, commit, message, files: files.length, changed, repo: dir, pdf };
  if (options.push) result.push = pushSnapshots(projectId);
  return result;
}

export function listSnapshots(projectId: string, limit = 20): SnapshotInfo[] {
  const dir = snapshotRepoDir(projectId);
  if (!existsSync(join(dir, '.git')) || !gitOk(dir, ['rev-parse', '--verify', '-q', 'HEAD'])) return [];
  const out = git(dir, ['log', `-${limit}`, '--format=%h%x09%cI%x09%s']);
  return out.split('\n').filter(Boolean).map(line => {
    const [commit, date, ...rest] = line.split('\t');
    return { commit, date, message: rest.join('\t') };
  });
}

/** Snapshot commit that recorded an agent task, if any. */
export function snapshotForTask(projectId: string, taskId: string): string | undefined {
  const dir = snapshotRepoDir(projectId);
  if (!existsSync(join(dir, '.git'))) return undefined;
  try {
    return git(dir, ['log', '-1', '--format=%h', `--grep=olf-Task: ${taskId}`]) || undefined;
  } catch {
    return undefined;
  }
}

function resolveRef(dir: string, ref: string): string {
  if (!existsSync(join(dir, '.git'))) throw new Error('No snapshots yet for this project. Run: olf snapshot save');
  try {
    return git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  } catch {
    throw new Error(`No snapshot "${ref}". See: olf snapshot list`);
  }
}

function exportRef(dir: string, ref: string): string {
  const out = mkdtempSync(join(tmpdir(), 'olf-snap-'));
  const tar = spawnSync('git', ['-C', dir, 'archive', '--format=tar', ref], { maxBuffer: 1024 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr?.toString()}`);
  const untar = spawnSync('tar', ['-x', '-C', out], { input: tar.stdout });
  if (untar.status !== 0) throw new Error(`Could not unpack snapshot: ${untar.stderr?.toString()}`);
  rmSync(join(out, '.olf-snapshots'), { force: true });
  rmSync(join(out, BUILD_DIR), { recursive: true, force: true });
  return out;
}

function walk(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) files.push(...walk(full, base));
    else files.push(relative(base, full).split('\\').join('/'));
  }
  return files;
}

export interface DiffResult {
  ref: string;
  against: string;
  changed: { status: 'modified' | 'added' | 'deleted'; path: string }[];
  patch?: string;
}

/**
 * Compare a snapshot with the project as Overleaf has it now. `added` means
 * the file exists now but not in the snapshot.
 */
export async function diffSnapshot(client: OverleafClient, projectId: string, ref = 'HEAD', patch = false): Promise<DiffResult> {
  const dir = snapshotRepoDir(projectId);
  const commit = resolveRef(dir, ref);
  const then = exportRef(dir, commit);
  const now = mkdtempSync(join(tmpdir(), 'olf-now-'));
  try {
    extractZip(await client.downloadProject(projectId), now);
    const a = new Set(walk(then));
    const b = new Set(walk(now));
    const changed: DiffResult['changed'] = [];
    for (const path of [...new Set([...a, ...b])].sort()) {
      if (!b.has(path)) changed.push({ status: 'deleted', path });
      else if (!a.has(path)) changed.push({ status: 'added', path });
      else if (!readFileSync(join(then, path)).equals(readFileSync(join(now, path)))) changed.push({ status: 'modified', path });
    }
    let text: string | undefined;
    if (patch && changed.length) {
      const res = spawnSync('git', ['diff', '--no-index', '--no-color', '--src-prefix=snapshot/', '--dst-prefix=now/', then, now], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      text = (res.stdout || '').split(then).join('').split(now).join('');
    }
    return { ref: git(dir, ['rev-parse', '--short', commit]), against: 'Overleaf now', changed, patch: text };
  } finally {
    rmSync(then, { recursive: true, force: true });
    rmSync(now, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  /** Only these paths. */
  paths?: string[];
  /** Also delete files that exist now but not in the snapshot. */
  deleteExtra?: boolean;
  dryRun?: boolean;
}

export interface RestoreResult {
  ref: string;
  safetySnapshot?: string;
  plan: DiffResult['changed'];
  files: FileResult[];
  deleted: string[];
  afterSnapshot?: string;
}

/**
 * Make the project match a snapshot. Text files are restored as live edits,
 * so people typing elsewhere are not interrupted. A snapshot of the current
 * state is saved first, so the restore itself can be undone.
 */
export async function restoreSnapshot(client: OverleafClient, projectId: string, ref: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const dir = snapshotRepoDir(projectId);
  const commit = resolveRef(dir, ref);
  const short = git(dir, ['rev-parse', '--short', commit]);
  const diff = await diffSnapshot(client, projectId, commit);
  const wanted = (path: string) => !options.paths?.length || options.paths.some(p => path === p || path.startsWith(p.replace(/\/?$/, '/')));
  const plan = diff.changed.filter(c => wanted(c.path) && (c.status !== 'added' || options.deleteExtra));
  if (options.dryRun || plan.length === 0) return { ref: short, plan, files: [], deleted: [] };

  const safety = await saveSnapshot(client, projectId, { message: `Before restoring snapshot ${short}` });
  const source = exportRef(dir, commit);
  const baseDir = mkdtempSync(join(tmpdir(), 'olf-restore-'));
  try {
    const toWrite = plan.filter(c => c.status !== 'added').map(c => ({ path: c.path, content: readFileSync(join(source, c.path)) }));
    const files = await pushFiles({
      client,
      projectId,
      dir: baseDir,
      overwrite: true,
      files: toWrite,
      upload: async (path, content) => {
        const res = await client.uploadFile(projectId, null, path, content);
        if (!res.success) throw new Error('upload was not accepted');
      },
    });
    const deleted: string[] = [];
    for (const c of plan.filter(c => c.status === 'added')) {
      await client.deleteByPath(projectId, c.path);
      deleted.push(c.path);
    }
    const after = await saveSnapshot(client, projectId, { message: `Restored snapshot ${short}` });
    return { ref: short, safetySnapshot: safety.commit, plan, files, deleted, afterSnapshot: after.commit };
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- backup

export function getSnapshotRemote(projectId: string): string | undefined {
  const dir = snapshotRepoDir(projectId);
  try {
    return git(dir, ['remote', 'get-url', 'origin']) || undefined;
  } catch {
    return undefined;
  }
}

export function setSnapshotRemote(projectId: string, url: string): void {
  const dir = snapshotRepoDir(projectId);
  if (!existsSync(join(dir, '.git'))) throw new Error('Save a snapshot first: olf snapshot save');
  if (getSnapshotRemote(projectId)) git(dir, ['remote', 'set-url', 'origin', url]);
  else git(dir, ['remote', 'add', 'origin', url]);
}

/** Create a private GitHub repository for the snapshots (needs the gh CLI). */
export function createGithubBackup(projectId: string, repoName: string): string {
  const dir = snapshotRepoDir(projectId);
  if (!existsSync(join(dir, '.git'))) throw new Error('Save a snapshot first: olf snapshot save');
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('Needs the GitHub CLI (gh). Install it and run gh auth login, or use olf snapshot remote <url>.');
  const res = spawnSync('gh', ['repo', 'create', repoName, '--private', '--source', dir, '--remote', 'origin', '--push'], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(res.stderr.trim() || 'gh repo create failed');
  return getSnapshotRemote(projectId) || repoName;
}

/** Push snapshots. A failure leaves the local commits as they are. */
export function pushSnapshots(projectId: string): { ok: boolean; error?: string } {
  const dir = snapshotRepoDir(projectId);
  if (!getSnapshotRemote(projectId)) return { ok: false, error: 'no backup remote; run olf snapshot backup --github, or olf snapshot remote <url>' };
  const res = spawnSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'main'], { encoding: 'utf-8' });
  return res.status === 0 ? { ok: true } : { ok: false, error: res.stderr.trim() || 'git push failed' };
}
