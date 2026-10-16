/**
 * Cooperative editing on top of a live project: the agent claims a section,
 * edits only inside it, and steps back when a human types there.
 *
 * Signals a human sees in Overleaf, with no extension installed:
 *  - the claimed section is covered by an open comment thread that says what
 *    the agent is doing (it also gets a coloured highlight),
 *  - the agent's cursor sits where it is editing,
 *  - a pause and a release are posted as replies in that thread.
 *
 * A human resumes a paused agent by replying "done" (or "continue", "ok",
 * "go ahead") in the thread, or by resolving it.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OverleafClient } from '../client.js';
import { getConfigPath } from '../config.js';
import { LiveProject, type ChangeEvent, type LiveDoc } from './session.js';
import { findSection, findSections, moveRange, type Range } from './sections.js';
import { appendTaskLog, listTasks } from './tasklog.js';
import { parseLatexErrors, type LatexProblem } from './latexlog.js';

export type EditMode = 'direct' | 'suggest';

export interface HumanMessage {
  at: string;
  author: string;
  content: string;
}

export interface Claim {
  id: string;
  path: string;
  section: string;
  task: string;
  range: Range;
  state: 'active' | 'paused';
  pauseReason?: string;
  pausedAt?: string;
  edits: number;
  createdAt: string;
  /** Replies from people in the claim thread that the agent has not seen yet. */
  inbox: HumanMessage[];
}

export interface Suggestion {
  id: string;
  path: string;
  oldText: string;
  newText: string;
  note?: string;
  createdAt: string;
}

interface PersistedState {
  mode: EditMode;
  claimThreads: { id: string; docId: string }[];
  suggestions: (Suggestion & { docId: string })[];
}

const RESUME_WORDS = /\b(done|continue|go ahead|go on|resume|ok|okay|carry on|proceed|your turn)\b/i;
const ACCEPT_WORDS = /\b(accept|accepted|yes|apply|approve|approved|lgtm|ok|okay)\b/i;
const REJECT_WORDS = /\b(reject|rejected|no|decline|discard|skip)\b/i;

function newThreadId(): string {
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return time + random;
}

function statePath(projectId: string): string {
  return join(dirname(getConfigPath()), 'state', `${projectId}.json`);
}

/**
 * Events: 'paused' (claim), 'resumed' (claim), 'message' (claim, message),
 * 'claims' () whenever the claim list changes.
 */
export class Coop extends EventEmitter {
  claims = new Map<string, Claim>();
  mode: EditMode = 'direct';
  private suggestions = new Map<string, Suggestion & { docId: string }>();
  private ourMessageIds = new Set<string>();
  private ourResolves = new Set<string>();
  private outgoing = new Set<string>();
  private claimDocs = new Map<string, LiveDoc>();

  private constructor(readonly client: OverleafClient, readonly live: LiveProject) {
    super();
    live.on('change', (event: ChangeEvent) => this.onChange(event));
    live.on('event', (name: string, args: any[]) => this.onSocketEvent(name, args));
  }

  static async open(client: OverleafClient, projectId: string, options: { verbose?: boolean } = {}): Promise<Coop> {
    const live = await LiveProject.open(client, projectId, options);
    const coop = new Coop(client, live);
    await coop.loadState();
    return coop;
  }

  get projectId(): string {
    return this.live.projectId;
  }

  // ---------------------------------------------------------------- state

  private async loadState(): Promise<void> {
    const path = statePath(this.projectId);
    if (!existsSync(path)) return;
    let state: PersistedState;
    try {
      state = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return;
    }
    this.mode = state.mode || 'direct';
    for (const s of state.suggestions || []) this.suggestions.set(s.id, s);
    // Claims do not survive a restart: the agent lost its place. Close them
    // so nobody keeps waiting on a section nobody is editing.
    for (const thread of state.claimThreads || []) {
      await this.say(thread.id, 'Released: the agent restarted and is no longer editing this section.').catch(() => {});
      await this.client.threadAction(this.projectId, thread.docId, thread.id, 'resolve').catch(() => {});
    }
    this.saveState();
  }

  private saveState(): void {
    const state: PersistedState = {
      mode: this.mode,
      claimThreads: [...this.claims.values()].map(c => ({ id: c.id, docId: this.claimDocs.get(c.id)!.id })),
      suggestions: [...this.suggestions.values()],
    };
    const path = statePath(this.projectId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  setMode(mode: EditMode): void {
    this.mode = mode;
    this.saveState();
  }

  // ---------------------------------------------------------------- events

  private onChange(event: ChangeEvent): void {
    for (const claim of this.claims.values()) {
      if (this.claimDocs.get(claim.id) !== event.doc) continue;
      const { range, touched } = moveRange(claim.range, event.op, event.local);
      claim.range = range;
      if (touched && !event.local && claim.state === 'active') {
        void this.pause(claim, 'someone typed in this section');
      }
    }
  }

  private onSocketEvent(name: string, args: any[]): void {
    if (name === 'new-comment') {
      const [threadId, message] = args;
      if (!message || this.isOurs(threadId, message)) return;
      const claim = this.claims.get(threadId);
      if (claim) {
        const msg: HumanMessage = {
          at: new Date(message.timestamp || Date.now()).toISOString(),
          author: [message.user?.first_name, message.user?.last_name].filter(Boolean).join(' ') || message.user?.email || 'someone',
          content: String(message.content || ''),
        };
        claim.inbox.push(msg);
        this.emit('message', claim, msg);
        if (claim.state === 'paused' && RESUME_WORDS.test(msg.content)) this.resume(claim, `${msg.author} replied "${msg.content}"`);
      }
    } else if (name === 'resolve-thread') {
      const [threadId] = args;
      if (this.ourResolves.has(threadId)) return;
      const claim = this.claims.get(threadId);
      if (claim) {
        // Resolving the claim comment means "go on". Reopen it so the
        // section stays marked while the agent finishes.
        const doc = this.claimDocs.get(claim.id)!;
        void this.client.threadAction(this.projectId, doc.id, claim.id, 'reopen').catch(() => {});
        if (claim.state === 'paused') this.resume(claim, 'the comment was resolved');
      }
    }
  }

  private async say(threadId: string, content: string): Promise<void> {
    // The socket can announce our message before the HTTP reply gives us its
    // id, so remember the text too. Otherwise "reply done" in our own message
    // would look like a person saying "done".
    const key = `${threadId}\n${content}`;
    this.outgoing.add(key);
    try {
      const message = await this.client.postCommentMessage(this.projectId, threadId, content);
      if (message && (message as any).id) this.ourMessageIds.add((message as any).id);
    } finally {
      setTimeout(() => this.outgoing.delete(key), 30_000);
    }
  }

  private isOurs(threadId: string, message: any): boolean {
    if (this.ourMessageIds.has(message.id)) return true;
    const key = `${threadId}\n${message.content}`;
    if (this.outgoing.has(key)) {
      this.outgoing.delete(key);
      if (message.id) this.ourMessageIds.add(message.id);
      return true;
    }
    return false;
  }

  private async pause(claim: Claim, reason: string): Promise<void> {
    claim.state = 'paused';
    claim.pauseReason = reason;
    claim.pausedAt = new Date().toISOString();
    this.emit('paused', claim);
    this.emit('claims');
    await this.say(claim.id, 'Paused: you are editing this section, so I stopped. Reply "done" here when I can continue.').catch(() => {});
  }

  private resume(claim: Claim, why: string): void {
    claim.state = 'active';
    claim.pauseReason = undefined;
    claim.pausedAt = undefined;
    this.emit('resumed', claim, why);
    this.emit('claims');
    void this.say(claim.id, 'Continuing. I re-read the section first.').catch(() => {});
  }

  /** Pause from outside, e.g. the browser extension's "Edit anyway" button. */
  async pauseClaim(claimId: string, reason: string): Promise<Claim> {
    const claim = this.requireClaim(claimId);
    if (claim.state === 'active') await this.pause(claim, reason);
    return claim;
  }

  resumeClaim(claimId: string, why = 'resumed by the user'): Claim {
    const claim = this.requireClaim(claimId);
    if (claim.state === 'paused') this.resume(claim, why);
    return claim;
  }

  // ---------------------------------------------------------------- reading

  async read(path: string, section?: string): Promise<{ path: string; section?: string; startLine: number; text: string; sections: { title: string; line: number }[] }> {
    const doc = await this.live.doc(path);
    const sections = findSections(doc.content).map(s => ({ title: `${'  '.repeat(Math.max(0, s.level - 2))}${s.title}`, line: s.line }));
    if (!section) return { path: doc.path, startLine: 1, text: doc.content, sections };
    const found = findSection(doc.content, section);
    return {
      path: doc.path,
      section: found.title,
      startLine: found.line,
      text: doc.content.slice(found.start, found.end),
      sections,
    };
  }

  // ---------------------------------------------------------------- claims

  async claim(path: string, section: string, task: string): Promise<Claim> {
    const doc = await this.live.doc(path);
    const found = findSection(doc.content, section);
    const overlap = [...this.claims.values()].find(c => this.claimDocs.get(c.id) === doc && c.range.start < found.end && found.start < c.range.end);
    if (overlap) throw new Error(`Already claimed: "${overlap.section}" (${overlap.id}). Release it first or edit inside it.`);

    const id = newThreadId();
    const claim: Claim = {
      id,
      path: doc.path,
      section: found.title,
      task,
      range: { start: found.start, end: found.end },
      state: 'active',
      edits: 0,
      createdAt: new Date().toISOString(),
      inbox: [],
    };
    this.claims.set(id, claim);
    this.claimDocs.set(id, doc);

    await this.say(id, `Agent is editing this section: ${task}\nPlease leave it to me for now. If you need to change it, go ahead: I will pause and wait until you reply "done".`);
    const text = doc.content.slice(claim.range.start, claim.range.end);
    await doc.submit([{ p: claim.range.start, c: text, t: id }]);
    await this.live.moveCursor(doc, claim.range.start);
    this.saveState();
    this.emit('claims');
    return claim;
  }

  private requireClaim(claimId: string): Claim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`No active claim ${claimId}. Active: ${[...this.claims.values()].map(c => `${c.id} "${c.section}"`).join(', ') || 'none'}`);
    return claim;
  }

  claimText(claimId: string): string {
    const claim = this.requireClaim(claimId);
    const doc = this.claimDocs.get(claimId)!;
    return doc.content.slice(claim.range.start, claim.range.end);
  }

  /** Replace text inside a claim. In suggest mode this becomes a suggestion instead. */
  async replace(claimId: string, oldText: string, newText: string): Promise<{ applied: boolean; suggestionId?: string; claim: Claim }> {
    const claim = this.requireClaim(claimId);
    if (claim.state === 'paused') {
      throw new Error(`Claim "${claim.section}" is paused (${claim.pauseReason}). Call claim_status with wait_seconds to wait until the user replies "done", then read the section again.`);
    }
    const doc = this.claimDocs.get(claimId)!;
    if (this.mode === 'suggest') {
      const suggestion = await this.suggest(doc.path, oldText, newText, `Part of: ${claim.task}`, claim.range);
      return { applied: false, suggestionId: suggestion.id, claim };
    }
    const op = await doc.replace(oldText, newText, claim.range);
    claim.edits++;
    appendTaskLog({ projectId: this.projectId, taskId: claim.id, task: claim.task, path: doc.path, section: claim.section, kind: 'edit', before: oldText, after: newText });
    const last = op[op.length - 1];
    if (last) await this.live.moveCursor(doc, Math.min(doc.content.length, last.p + ('i' in last ? last.i.length : 0)));
    return { applied: true, claim };
  }

  async status(claimId?: string, waitSeconds = 0): Promise<Claim[]> {
    const targets = claimId ? [this.requireClaim(claimId)] : [...this.claims.values()];
    const deadline = Date.now() + waitSeconds * 1000;
    while (waitSeconds > 0 && Date.now() < deadline && targets.some(c => c.state === 'paused' && this.claims.has(c.id))) {
      await new Promise(r => setTimeout(r, 500));
    }
    const snapshot = targets.map(c => ({ ...c, inbox: [...c.inbox] }));
    for (const c of targets) c.inbox = [];
    return snapshot;
  }

  async compileCheck(): Promise<{ ok: boolean; status: string; errors: LatexProblem[] }> {
    for (const doc of this.live.docs.values()) await doc.settle().catch(() => {});
    const result = await this.client.compileWithOutputs(this.projectId);
    let errors: LatexProblem[] = [];
    const log = result.outputFiles.find(f => f.path === 'output.log');
    if (log) {
      const text = (await this.client.downloadOutputFile(log.url).catch(() => Buffer.from(''))).toString('utf-8');
      errors = parseLatexErrors(text);
    }
    return { ok: result.status === 'success' && errors.length === 0, status: result.status, errors };
  }

  async release(claimId: string, options: { compile?: boolean; force?: boolean } = {}): Promise<{ released: boolean; compile?: { ok: boolean; status: string; errors: LatexProblem[] }; claim: Claim }> {
    const claim = this.requireClaim(claimId);
    const doc = this.claimDocs.get(claimId)!;
    await doc.settle();
    let compile: { ok: boolean; status: string; errors: LatexProblem[] } | undefined;
    if (options.compile !== false) {
      compile = await this.compileCheck();
      if (!compile.ok && !options.force) return { released: false, compile, claim };
    }
    const summary = claim.edits === 1 ? '1 edit' : `${claim.edits} edits`;
    const compileNote = compile ? (compile.ok ? ' The project compiles.' : ' Warning: the project has compile errors.') : '';
    await this.say(claim.id, `Done: ${summary}.${compileNote} Undo with "olf undo ${claim.id}".`).catch(() => {});
    this.ourResolves.add(claim.id);
    await this.client.threadAction(this.projectId, doc.id, claim.id, 'resolve').catch(() => {});
    this.claims.delete(claimId);
    this.claimDocs.delete(claimId);
    this.saveState();
    this.emit('claims');
    return { released: true, compile, claim };
  }

  // ---------------------------------------------------------------- suggestions

  async suggest(path: string, oldText: string, newText: string, note?: string, within?: Range): Promise<Suggestion> {
    const doc = await this.live.doc(path);
    const at = doc.locate(oldText, within?.start, within?.end);
    const id = newThreadId();
    const lines = [
      'Suggested change' + (note ? ` (${note})` : '') + ':',
      newText,
      '',
      'Reply "accept" to apply it, or "reject" to drop it.',
    ];
    await this.say(id, lines.join('\n'));
    await doc.submit([{ p: at, c: oldText, t: id }]);
    const suggestion = { id, docId: doc.id, path: doc.path, oldText, newText, note, createdAt: new Date().toISOString() };
    this.suggestions.set(id, suggestion);
    this.saveState();
    return suggestion;
  }

  /**
   * Apply accepted suggestions and drop rejected ones. Reads the threads over
   * HTTP, so replies given while the agent was not running count too.
   */
  async checkSuggestions(): Promise<{ applied: string[]; rejected: string[]; pending: string[]; failed: { id: string; reason: string }[] }> {
    const result = { applied: [] as string[], rejected: [] as string[], pending: [] as string[], failed: [] as { id: string; reason: string }[] };
    if (!this.suggestions.size) return result;
    const threads = await this.client.getCommentThreads(this.projectId);
    for (const suggestion of [...this.suggestions.values()]) {
      const thread = threads[suggestion.id];
      if (!thread) {
        this.suggestions.delete(suggestion.id);
        result.rejected.push(suggestion.id);
        continue;
      }
      // The first message is the suggestion itself; later ones from us are status notes.
      const replies = (thread.messages || []).slice(1).filter(m => !this.ourMessageIds.has((m as any).id));
      const lastReply = replies.length ? String(replies[replies.length - 1].content || '') : '';
      const accepted = lastReply && ACCEPT_WORDS.test(lastReply) && !REJECT_WORDS.test(lastReply);
      const rejected = (lastReply && REJECT_WORDS.test(lastReply)) || (thread.resolved && !accepted);
      if (accepted) {
        try {
          const doc = await this.live.doc(suggestion.path);
          await doc.replace(suggestion.oldText, suggestion.newText);
          appendTaskLog({ projectId: this.projectId, taskId: suggestion.id, task: suggestion.note || 'suggestion', path: suggestion.path, kind: 'suggestion-applied', before: suggestion.oldText, after: suggestion.newText });
          await this.say(suggestion.id, 'Applied.').catch(() => {});
          this.ourResolves.add(suggestion.id);
          await this.client.threadAction(this.projectId, suggestion.docId, suggestion.id, 'resolve').catch(() => {});
          this.suggestions.delete(suggestion.id);
          result.applied.push(suggestion.id);
        } catch (error) {
          result.failed.push({ id: suggestion.id, reason: (error as Error).message });
        }
      } else if (rejected) {
        if (!thread.resolved) {
          this.ourResolves.add(suggestion.id);
          await this.client.threadAction(this.projectId, suggestion.docId, suggestion.id, 'resolve').catch(() => {});
        }
        this.suggestions.delete(suggestion.id);
        result.rejected.push(suggestion.id);
      } else {
        result.pending.push(suggestion.id);
      }
    }
    this.saveState();
    return result;
  }

  // ---------------------------------------------------------------- undo

  /**
   * Undo a task's edits, newest first. Each edit is reverted only where its
   * result is still in the document unchanged, so nothing a person wrote
   * afterwards is touched.
   */
  async undo(taskId?: string): Promise<{ taskId: string; task: string; reverted: number; skipped: { path: string; text: string; reason: string }[] }> {
    const tasks = listTasks(this.projectId).filter(t => !t.undone && t.edits.length);
    const task = taskId ? tasks.find(t => t.taskId === taskId) : tasks[0];
    if (!task) throw new Error(taskId ? `No undoable task ${taskId}` : 'No agent task to undo.');
    let reverted = 0;
    const skipped: { path: string; text: string; reason: string }[] = [];
    for (const edit of [...task.edits].reverse()) {
      try {
        const doc = await this.live.doc(edit.path);
        await doc.replace(edit.after, edit.before);
        reverted++;
      } catch (error) {
        skipped.push({ path: edit.path, text: edit.after.slice(0, 80), reason: (error as Error).message });
      }
    }
    appendTaskLog({ projectId: this.projectId, taskId: task.taskId, task: task.task, path: '', kind: 'undo', before: '', after: '' });
    return { taskId: task.taskId, task: task.task, reverted, skipped };
  }

  // ---------------------------------------------------------------- shutdown

  async close(): Promise<void> {
    for (const claim of [...this.claims.values()]) {
      await this.release(claim.id, { compile: false }).catch(() => {});
    }
    await this.live.close();
  }
}
