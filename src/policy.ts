/**
 * What the MCP server lets an agent do. A section claim limits live edits;
 * this limits everything else (which projects, whether to write at all, and
 * which local folders tools may read or write).
 *
 * Set through the environment of the MCP server, e.g.
 *   claude mcp add olf -e OLF_PROJECTS="My Thesis" -e OLF_READ_ONLY=1 -- olf-mcp
 *
 *   OLF_PROJECTS   comma-separated project names or IDs; others are refused
 *   OLF_READ_ONLY  1 to refuse every tool that changes a project
 *   OLF_WORKSPACE  folder that local paths must stay inside
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface Policy {
  readOnly: boolean;
  projects: string[] | null;
  workspace: string | null;
}

/** Tools that change an Overleaf project. */
export const WRITE_TOOLS = new Set([
  'push_file', 'delete_entity', 'rename_entity', 'rename_project', 'create_project',
  'add_comment', 'reply_to_comment', 'resolve_comment',
  'claim_section', 'live_replace', 'release_claim', 'suggest_edit', 'check_suggestions',
  'set_edit_mode', 'undo_task', 'snapshot_restore',
]);

/** Tool arguments that name a local file or folder. */
export const LOCAL_PATH_ARGS = ['local_path', 'local_dir', 'output_dir', 'output_path'];

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const projects = (env.OLF_PROJECTS || '').split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
  let workspace: string | null = null;
  if (env.OLF_WORKSPACE) {
    const abs = resolve(env.OLF_WORKSPACE);
    workspace = existsSync(abs) ? realpathSync(abs) : abs;
  }
  return {
    readOnly: /^(1|true|yes)$/i.test(env.OLF_READ_ONLY || ''),
    projects: projects.length ? projects : null,
    workspace,
  };
}

export function projectAllowed(policy: Policy, project: { id: string; name?: string }): boolean {
  if (!policy.projects) return true;
  return policy.projects.includes(project.id.toLowerCase()) || Boolean(project.name && policy.projects.includes(project.name.toLowerCase()));
}

/**
 * Resolve a path the way the filesystem will, following symlinks of the
 * deepest part that already exists, and check it stays in the workspace.
 */
export function pathAllowed(policy: Policy, path: string): boolean {
  if (!policy.workspace) return true;
  let probe = resolve(path);
  const rest: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    rest.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  const real = resolve(existsSync(probe) ? realpathSync(probe) : probe, ...rest);
  const rel = relative(policy.workspace, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function describePolicy(policy: Policy): string[] {
  return [
    policy.readOnly ? 'read-only: tools that change a project are refused' : 'writes allowed',
    policy.projects ? `projects limited to: ${policy.projects.join(', ')}` : 'all projects in the account',
    policy.workspace ? `local files limited to: ${policy.workspace}` : 'local paths not restricted',
  ];
}
