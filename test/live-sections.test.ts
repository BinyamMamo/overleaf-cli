import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSection, findSections, moveRange } from '../src/live/sections.js';

const doc = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Introduction}',
  'Intro text.',
  '% \\section{Commented out}',
  '\\subsection{Background}',
  'Background text.',
  '\\section*{Related Work}',
  'Related text.',
  '\\subsection[short]{Long {nested} title}',
  'More.',
  '\\end{document}',
  '',
].join('\n');

test('findSections finds headings, skips commented ones, ends at the next peer', () => {
  const sections = findSections(doc);
  assert.deepEqual(sections.map(s => s.title), ['Introduction', 'Background', 'Related Work', 'Long {nested} title']);
  const intro = sections[0];
  assert.ok(doc.slice(intro.start, intro.end).startsWith('\\section{Introduction}'));
  assert.ok(doc.slice(intro.start, intro.end).includes('Background text.'));
  assert.ok(!doc.slice(intro.start, intro.end).includes('Related'));
  const last = sections[3];
  assert.ok(!doc.slice(last.start, last.end).includes('\\end{document}'));
});

test('findSection by title and by line', () => {
  assert.equal(findSection(doc, 'introduction').title, 'Introduction');
  assert.equal(findSection(doc, '\\section{Related Work}').title, 'Related Work');
  assert.equal(findSection(doc, 'line:7').title, 'Background');
  assert.throws(() => findSection(doc, 'nothing like this'), /No section matches/);
});

test('findSection reports ambiguity', () => {
  assert.throws(() => findSection('\\section{Results A}\n\\section{Results B}\n', 'results'), /Several sections/);
});

test('moveRange: remote typing inside pauses, outside does not', () => {
  const r = { start: 10, end: 20 };
  assert.deepEqual(moveRange(r, [{ p: 15, i: 'ab' }], false), { range: { start: 10, end: 22 }, touched: true });
  assert.deepEqual(moveRange(r, [{ p: 5, i: 'ab' }], false), { range: { start: 12, end: 22 }, touched: false });
  assert.deepEqual(moveRange(r, [{ p: 20, i: 'ab' }], false), { range: { start: 10, end: 20 }, touched: false });
  assert.deepEqual(moveRange(r, [{ p: 10, i: 'ab' }], false), { range: { start: 12, end: 22 }, touched: false });
  assert.deepEqual(moveRange(r, [{ p: 18, d: 'abcd' }], false), { range: { start: 10, end: 18 }, touched: true });
  assert.deepEqual(moveRange(r, [{ p: 2, d: 'abcd' }], false), { range: { start: 6, end: 16 }, touched: false });
});

test('moveRange: agent edits at the edges stay inside the claim', () => {
  const r = { start: 10, end: 20 };
  assert.deepEqual(moveRange(r, [{ p: 20, i: 'xyz' }], true), { range: { start: 10, end: 23 }, touched: false });
  assert.deepEqual(moveRange(r, [{ p: 10, i: 'xyz' }], true), { range: { start: 10, end: 23 }, touched: false });
});

test('the abstract environment can be claimed like a section', () => {
  const text = '\\begin{document}\n\\begin{abstract}\nShort.\n\\end{abstract}\n\n\\section{Intro}\nHi.\n\\end{document}\n';
  const abstract = findSection(text, 'abstract');
  assert.equal(text.slice(abstract.start, abstract.end), '\\begin{abstract}\nShort.\n\\end{abstract}\n');
  assert.equal(findSection(text, 'intro').title, 'Intro');
});
