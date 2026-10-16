/**
 * LaTeX section detection and claimed-range bookkeeping. Pure functions only.
 */

import { isDelete, isInsert, type Op } from './ot.js';

export interface Section {
  level: number;
  command: string;
  title: string;
  /** Offset of the heading command. */
  start: number;
  /** Offset where the next heading of the same or higher level begins. */
  end: number;
  /** 1-based line of the heading. */
  line: number;
}

const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

const HEADING = /^[ \t]*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/gm;

function readBraced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{' && text[i - 1] !== '\\') depth++;
    else if (text[i] === '}' && text[i - 1] !== '\\') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1, text.indexOf('\n', open) === -1 ? undefined : text.indexOf('\n', open));
}

function isCommentedOut(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /(^|[^\\])%/.test(text.slice(lineStart, offset));
}

export function findSections(text: string): Section[] {
  const heads: Omit<Section, 'end'>[] = [];
  for (const match of text.matchAll(HEADING)) {
    const start = match.index!;
    if (isCommentedOut(text, start + match[0].indexOf('\\'))) continue;
    const title = readBraced(text, start + match[0].length - 1).replace(/\s+/g, ' ').trim();
    heads.push({
      level: LEVELS[match[1]],
      command: match[1],
      title,
      start: start + match[0].indexOf('\\'),
      line: text.slice(0, start).split('\n').length,
    });
  }

  const docEnd = text.search(/\\end\{document\}/);
  const limit = docEnd === -1 ? text.length : docEnd;
  const sections = heads.map((head, index) => {
    let end = limit;
    for (const next of heads.slice(index + 1)) {
      if (next.level <= head.level) {
        end = next.start;
        break;
      }
    }
    // Keep the range from swallowing the next heading's leading indentation.
    if (end > head.start) {
      const lineStart = text.lastIndexOf('\n', end - 1) + 1;
      if (lineStart > head.start && /^[ \t]*$/.test(text.slice(lineStart, end))) end = lineStart;
    }
    return { ...head, end: Math.max(end, head.start) };
  });

  // Environments that work like sections but have no heading command.
  for (const match of text.matchAll(/\\begin\{(abstract)\}[\s\S]*?\\end\{\1\}\n?/g)) {
    const start = match.index!;
    if (isCommentedOut(text, start)) continue;
    sections.push({
      level: 2,
      command: match[1],
      title: 'Abstract',
      start,
      end: start + match[0].length,
      line: text.slice(0, start).split('\n').length,
    });
  }
  return sections.sort((a, b) => a.start - b.start);
}

/**
 * Pick a section by title (case-insensitive, exact match preferred over
 * substring) or by a line number inside it ("line:42").
 */
export function findSection(text: string, query: string): Section {
  const sections = findSections(text);
  if (!sections.length) throw new Error('This file has no \\section headings. Claim a text range instead.');

  const lineMatch = query.match(/^line:(\d+)$/i);
  if (lineMatch) {
    const line = Number(lineMatch[1]);
    const containing = sections
      .filter(s => s.line <= line && text.slice(0, s.end).split('\n').length >= line)
      .sort((a, b) => b.level - a.level);
    if (!containing.length) throw new Error(`Line ${line} is not inside any section.`);
    return containing[0];
  }

  const q = query.trim().toLowerCase().replace(/^\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{?|\}$/g, '');
  const exact = sections.filter(s => s.title.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = sections.filter(s => s.title.toLowerCase().includes(q));
  if (exact.length > 1 || partial.length > 1) {
    const options = (exact.length > 1 ? exact : partial).map(s => `"${s.title}" (line ${s.line})`).join(', ');
    throw new Error(`Several sections match "${query}": ${options}. Use line:<n> to pick one.`);
  }
  if (partial.length === 1) return partial[0];
  throw new Error(`No section matches "${query}". Sections: ${sections.map(s => `"${s.title}"`).join(', ')}`);
}

export interface Range {
  start: number;
  end: number;
}

/**
 * Move a claimed range through an op.
 *
 * Local (agent) edits that touch the range grow or shrink it. For edits by
 * someone else, the result also says whether they landed inside the range:
 * that is what pauses the agent. Typing exactly at the range end belongs to
 * the next section, not this one.
 */
export function moveRange(range: Range, op: Op, local: boolean): { range: Range; touched: boolean } {
  let { start, end } = range;
  let touched = false;
  for (const c of op) {
    if (isInsert(c)) {
      const len = c.i.length;
      if (local) {
        if (c.p < start) { start += len; end += len; }
        else if (c.p <= end) end += len;
      } else if (c.p <= start) {
        start += len; end += len;
      } else if (c.p < end) {
        end += len;
        touched = true;
      }
    } else if (isDelete(c)) {
      const dStart = c.p;
      const dEnd = c.p + c.d.length;
      if (dEnd <= start) {
        start -= c.d.length; end -= c.d.length;
      } else if (dStart >= end) {
        // after the range
      } else {
        if (!local) touched = true;
        const cutBefore = Math.max(0, Math.min(dEnd, start) - dStart);
        const cutInside = Math.min(dEnd, end) - Math.max(dStart, start);
        start -= cutBefore;
        end -= cutBefore + cutInside;
      }
    }
  }
  return { range: { start, end: Math.max(start, end) }, touched };
}
