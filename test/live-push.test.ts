import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText } from '../src/live/push.js';
import { parseLatexErrors } from '../src/live/latexlog.js';

test('mergeText keeps edits from both sides', () => {
  const base = 'Intro: we study solar power.\nMethods: we use a CNN.\nResults: it works.\n';
  const remote = 'Intro: we study solar power forecasting.\nMethods: we use a CNN.\nResults: it works.\n';
  const local = 'Intro: we study solar power.\nMethods: we use a CNN.\nResults: it works well on three plants.\n';
  const { merged, remoteChanged } = mergeText(base, remote, local);
  assert.equal(remoteChanged, true);
  assert.equal(merged, 'Intro: we study solar power forecasting.\nMethods: we use a CNN.\nResults: it works well on three plants.\n');
});

test('mergeText without a base makes the remote equal local', () => {
  const { merged, remoteChanged } = mergeText(undefined, 'a b c', 'a x c');
  assert.equal(merged, 'a x c');
  assert.equal(remoteChanged, false);
});

test('parseLatexErrors finds message, file and line', () => {
  const log = [
    'This is pdfTeX',
    '(./main.tex',
    '(./sections/intro.tex',
    '! Undefined control sequence.',
    'l.12 \\foo',
    '        {bar}',
  ].join('\n');
  assert.deepEqual(parseLatexErrors(log), [{ message: 'Undefined control sequence.', file: 'sections/intro.tex', line: 12, context: '\\foo' }]);
});
