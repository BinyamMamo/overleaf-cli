/**
 * MCP tools for live, cooperative editing. Registered by mcp.ts.
 *
 * The workflow an agent should follow is spelled out in the tool
 * descriptions, because that is what the agent reads:
 *   live_read -> claim_section -> live_replace (repeat) -> release_claim
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import type { OverleafClient } from '../client.js';
import { Coop } from './coop.js';
import { listTasks } from './tasklog.js';
import { startBridge } from './bridge.js';

type Wrap = <T>(fn: () => Promise<T>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

const coops = new Map<string, Promise<Coop>>();

async function resolveProjectId(client: OverleafClient, project: string): Promise<string> {
  if (/^[0-9a-f]{24}$/i.test(project)) return project;
  const found = await client.getProject(project);
  if (!found) throw new Error(`Project not found: ${project}`);
  return found.id;
}

export async function getCoop(client: OverleafClient, project: string): Promise<Coop> {
  const projectId = await resolveProjectId(client, project);
  let pending = coops.get(projectId);
  if (!pending) {
    pending = Coop.open(client, projectId).then(coop => {
      startBridge(coop);
      coop.live.on('closed', () => coops.delete(projectId));
      return coop;
    });
    pending.catch(() => coops.delete(projectId));
    coops.set(projectId, pending);
  }
  return pending;
}

export async function closeAllCoops(): Promise<void> {
  const all = [...coops.values()];
  coops.clear();
  await Promise.allSettled(all.map(async p => (await p).close()));
}

function numbered(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(5)}  ${line}`)
    .join('\n');
}

export function registerLiveTools(server: McpServer, getClient: () => Promise<OverleafClient>, wrapTool: Wrap): void {
  const project = z.string().describe('Project name or ID');

  server.tool(
    'live_status',
    'Connect to a project live and report: edit mode (direct/suggest), active claims (with pause state and any replies from people), docs, who is online, and whether the plan supports tracked changes. Use this first when working on an Overleaf project together with a person.',
    { project },
    async ({ project: p }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const [users] = await coop.live.socket.rpc('clientTracking.getConnectedUsers', []).catch(() => [[]]);
      return {
        project: coop.live.name,
        projectId: coop.projectId,
        mode: coop.mode,
        trackChanges: Boolean(coop.live.features.trackChanges),
        docs: coop.live.listDocs().map(d => d.path),
        online: (users || [])
          .filter((u: any) => u.client_id !== coop.live.publicId)
          .map((u: any) => ({ name: [u.first_name, u.last_name].filter(Boolean).join(' '), email: u.email })),
        claims: await coop.status(),
      };
    })
  );

  server.tool(
    'live_read',
    'Read the current live text of a doc, or of one section of it, exactly as it is in Overleaf right now (including what a person is typing). Lines are numbered for reference only; do not include the numbers when you pass text to live_replace.',
    {
      project,
      path: z.string().describe('Doc path, e.g. main.tex or sections/intro.tex'),
      section: z.string().optional().describe('Section title (e.g. "Introduction") or line:<n>. Omit for the whole doc.'),
    },
    async ({ project: p, path, section }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const result = await coop.read(path, section);
      return { ...result, text: numbered(result.text, result.startLine) };
    })
  );

  server.tool(
    'claim_section',
    'Claim a LaTeX section before editing it. The section gets a visible comment saying what you are doing, and your cursor shows there. If a person types inside it, the claim pauses and live_replace refuses until they reply "done". Claim the smallest \\section or \\subsection that covers the task. Always release_claim when finished.',
    {
      project,
      path: z.string().describe('Doc path, e.g. main.tex'),
      section: z.string().describe('Section title or line:<n>'),
      task: z.string().describe('One short sentence a person will read, e.g. "Tightening the wording of the introduction"'),
    },
    async ({ project: p, path, section, task }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const claim = await coop.claim(path, section, task);
      return { claim_id: claim.id, section: claim.section, path: claim.path, text: coop.claimText(claim.id) };
    })
  );

  server.tool(
    'live_replace',
    'Replace one exact piece of text inside your claimed section. old_text must appear exactly once in the section (copy it from live_read without line numbers; include more context if needed). The change is sent as small live edits that merge with what people type. In suggest mode it is posted as a suggestion comment instead. If this fails because the text changed, read again and retry.',
    {
      project,
      claim_id: z.string(),
      old_text: z.string().describe('Exact current text to replace'),
      new_text: z.string().describe('Replacement text'),
    },
    async ({ project: p, claim_id, old_text, new_text }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const result = await coop.replace(claim_id, old_text, new_text);
      return {
        applied: result.applied,
        suggestion_id: result.suggestionId,
        claim_state: result.claim.state,
        edits_in_claim: result.claim.edits,
      };
    })
  );

  server.tool(
    'claim_status',
    'Check your claims: paused or active, and any replies people wrote in the claim comment (instructions for you may be there). If a claim is paused, pass wait_seconds (up to 600) to wait until the person replies "done", then live_read the section again before editing.',
    {
      project,
      claim_id: z.string().optional(),
      wait_seconds: z.number().int().min(0).max(600).optional(),
    },
    async ({ project: p, claim_id, wait_seconds }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      return { claims: await coop.status(claim_id, wait_seconds || 0) };
    })
  );

  server.tool(
    'release_claim',
    'Finish a claim. By default it first compiles the project; if there are LaTeX errors the claim stays open and the errors are returned so you can fix them with live_replace. Pass force=true only if the errors were already there before your edits.',
    {
      project,
      claim_id: z.string(),
      compile: z.boolean().optional().default(true),
      force: z.boolean().optional().default(false),
    },
    async ({ project: p, claim_id, compile, force }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const result = await coop.release(claim_id, { compile, force });
      return { released: result.released, compile: result.compile, edits: result.claim.edits };
    })
  );

  server.tool(
    'suggest_edit',
    'Propose a change without applying it: the text gets a comment with your new wording, and the person replies "accept" or "reject". Use this for changes outside your claim or when the person wants to review first. Call check_suggestions later to apply accepted ones.',
    {
      project,
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      note: z.string().optional().describe('Why, in a few words'),
    },
    async ({ project: p, path, old_text, new_text, note }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      const suggestion = await coop.suggest(path, old_text, new_text, note);
      return { suggestion_id: suggestion.id };
    })
  );

  server.tool(
    'check_suggestions',
    'Apply suggestions the person accepted, drop rejected ones, and list those still waiting.',
    { project },
    async ({ project: p }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      return coop.checkSuggestions();
    })
  );

  server.tool(
    'set_edit_mode',
    'Switch between "direct" (live_replace edits the text) and "suggest" (live_replace posts suggestions to accept or reject). The person decides; only change it when they ask.',
    { project, mode: z.enum(['direct', 'suggest']) },
    async ({ project: p, mode }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      coop.setMode(mode);
      return { mode };
    })
  );

  server.tool(
    'undo_task',
    'Undo the edits of one agent task (a claim), newest first. Text that a person changed since is left alone and reported as skipped. Omit task_id for the latest task.',
    { project, task_id: z.string().optional() },
    async ({ project: p, task_id }) => wrapTool(async () => {
      const coop = await getCoop(await getClient(), p);
      return coop.undo(task_id);
    })
  );

  server.tool(
    'task_log',
    'List recent agent tasks on a project with their edits (before/after text).',
    { project, limit: z.number().int().min(1).max(50).optional().default(10) },
    async ({ project: p, limit }) => wrapTool(async () => {
      const client = await getClient();
      const projectId = await resolveProjectId(client, p);
      return listTasks(projectId).slice(0, limit);
    })
  );
}
