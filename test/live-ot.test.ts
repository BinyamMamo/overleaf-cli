import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffWordsWithSpace } from 'diff';
import { apply, diffOp, invert, replaceOp, transform, transformPosition, transformX, type Op } from '../src/live/ot.js';

function converge(base: string, a: Op, b: Op): void {
  const [a2, b2] = transformX(a, b);
  const left = apply(apply(base, a), b2);
  const right = apply(apply(base, b), a2);
  assert.equal(left, right, `diverged: ${JSON.stringify({ a, b, a2, b2 })}`);
}

test('apply inserts and deletes in order', () => {
  assert.equal(apply('hello world', [{ p: 5, d: ' world' }, { p: 5, i: ', you' }]), 'hello, you');
});

test('apply refuses a delete of text that is not there', () => {
  assert.throws(() => apply('abc', [{ p: 0, d: 'x' }]));
});

test('invert undoes an op', () => {
  const op: Op = [{ p: 0, d: 'he' }, { p: 0, i: 'HE' }, { p: 4, i: '!' }];
  const text = apply('hello', op);
  assert.equal(apply(text, invert(op)), 'hello');
});

test('concurrent inserts at the same spot converge', () => {
  converge('abc', [{ p: 1, i: 'X' }], [{ p: 1, i: 'Y' }]);
});

test('insert inside a concurrent delete converges', () => {
  converge('abcdef', [{ p: 1, d: 'bcde' }], [{ p: 3, i: 'XY' }]);
});

test('overlapping deletes converge', () => {
  converge('abcdefgh', [{ p: 1, d: 'bcd' }], [{ p: 2, d: 'cdef' }]);
});

test('multi-component ops converge', () => {
  converge(
    'The quick brown fox jumps',
    [{ p: 4, d: 'quick' }, { p: 4, i: 'slow' }, { p: 15, i: ' high' }],
    [{ p: 10, d: 'brown ' }, { p: 0, i: '> ' }],
  );
});

test('random ops always converge', () => {
  const alphabet = 'abcdefghij';
  const randomOp = (text: string): Op => {
    const op: Op = [];
    let doc = text;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      if (doc.length && Math.random() < 0.5) {
        const p = Math.floor(Math.random() * doc.length);
        const len = 1 + Math.floor(Math.random() * Math.min(4, doc.length - p));
        const c = { p, d: doc.slice(p, p + len) };
        op.push(c);
        doc = apply(doc, [c]);
      } else {
        const p = Math.floor(Math.random() * (doc.length + 1));
        const c = { p, i: alphabet[Math.floor(Math.random() * alphabet.length)].repeat(1 + Math.floor(Math.random() * 3)) };
        op.push(c);
        doc = apply(doc, [c]);
      }
    }
    return op;
  };
  for (let run = 0; run < 2000; run++) {
    const base = Array.from({ length: Math.floor(Math.random() * 12) }, () => alphabet[Math.floor(Math.random() * 10)]).join('');
    converge(base, randomOp(base), randomOp(base));
  }
});

test('transform(op, other, side) matches transformX', () => {
  const a: Op = [{ p: 2, i: 'A' }];
  const b: Op = [{ p: 0, d: 'xy' }];
  assert.deepEqual(transform(a, b, 'left'), [{ p: 0, i: 'A' }]);
  assert.deepEqual(transform(b, a, 'right'), [{ p: 0, d: 'xy' }]);
});

test('transformPosition follows inserts and deletes', () => {
  assert.equal(transformPosition(5, [{ p: 0, i: 'abc' }]), 8);
  assert.equal(transformPosition(5, [{ p: 5, i: 'abc' }], 'left'), 5);
  assert.equal(transformPosition(5, [{ p: 5, i: 'abc' }], 'right'), 8);
  assert.equal(transformPosition(5, [{ p: 2, d: 'abcdef' }]), 2);
});

test('replaceOp keeps the shared prefix and suffix', () => {
  assert.deepEqual(replaceOp(10, 'the cat sat', 'the dog sat'), [{ p: 14, d: 'cat' }, { p: 14, i: 'dog' }]);
  assert.deepEqual(replaceOp(0, 'same', 'same'), []);
});

test('diffOp turns a rewrite into word edits that apply cleanly', () => {
  const before = 'We propose a simple method for solar forecasting.';
  const after = 'We propose a robust method for cross-plant solar forecasting.';
  const doc = `PREFIX ${before} SUFFIX`;
  const op = diffOp(7, before, after, diffWordsWithSpace);
  assert.equal(apply(doc, op), `PREFIX ${after} SUFFIX`);
  assert.ok(op.length <= 4);
});
