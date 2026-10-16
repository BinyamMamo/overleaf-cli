/**
 * Text operations for live editing, in the ShareJS "text" shape that
 * Overleaf's collaboration socket speaks for `sharejs-text-ot` documents.
 *
 * An op is a list of components applied in order. Each position refers to the
 * document as it is after the previous components:
 *   { p, i }  insert string i at p
 *   { p, d }  delete string d, which must be at p
 *   { p, c, t }  comment c over the text at p (does not change the text)
 *
 * Pure functions only; no I/O. The transform rules follow ShareJS text0, so
 * the server and every browser agree on the result of concurrent edits.
 */

export interface InsertComponent { p: number; i: string }
export interface DeleteComponent { p: number; d: string }
export interface CommentComponent { p: number; c: string; t: string }
export type Component = InsertComponent | DeleteComponent | CommentComponent;
export type Op = Component[];

export function isInsert(c: Component): c is InsertComponent {
  return typeof (c as InsertComponent).i === 'string';
}

export function isDelete(c: Component): c is DeleteComponent {
  return typeof (c as DeleteComponent).d === 'string';
}

export class OpApplyError extends Error {}

export function apply(text: string, op: Op): string {
  for (const c of op) {
    if (c.p < 0 || c.p > text.length) throw new OpApplyError(`Position ${c.p} outside document of length ${text.length}`);
    if (isInsert(c)) {
      text = text.slice(0, c.p) + c.i + text.slice(c.p);
    } else if (isDelete(c)) {
      const found = text.slice(c.p, c.p + c.d.length);
      if (found !== c.d) throw new OpApplyError(`Delete expected ${JSON.stringify(c.d)} at ${c.p}, found ${JSON.stringify(found)}`);
      text = text.slice(0, c.p) + text.slice(c.p + c.d.length);
    }
  }
  return text;
}

/** The op that undoes `op` on the text it produced. */
export function invert(op: Op): Op {
  return op
    .filter(c => isInsert(c) || isDelete(c))
    .slice()
    .reverse()
    .map(c => (isInsert(c) ? { p: c.p, d: c.i } : { p: c.p, i: (c as DeleteComponent).d }));
}

/**
 * Move a cursor position through an op.
 * `side` decides a tie when text is inserted exactly at the position:
 * 'left' stays before the new text, 'right' moves after it.
 */
export function transformPosition(pos: number, op: Op, side: 'left' | 'right' = 'right'): number {
  for (const c of op) {
    if (isInsert(c)) {
      if (c.p < pos || (c.p === pos && side === 'right')) pos += c.i.length;
    } else if (isDelete(c)) {
      if (c.p < pos) pos -= Math.min(c.d.length, pos - c.p);
    }
  }
  return pos;
}

function transformComponent(dest: Op, c: Component, other: Component, side: 'left' | 'right'): void {
  if (isInsert(c)) {
    let p = c.p;
    if (isInsert(other)) {
      if (other.p < p || (other.p === p && side === 'right')) p += other.i.length;
    } else if (isDelete(other)) {
      if (other.p < p) p -= Math.min(other.d.length, p - other.p);
    }
    dest.push({ p, i: c.i });
    return;
  }

  if (isDelete(c)) {
    if (isInsert(other)) {
      if (other.p >= c.p + c.d.length) {
        dest.push({ p: c.p, d: c.d });
      } else if (other.p <= c.p) {
        dest.push({ p: c.p + other.i.length, d: c.d });
      } else {
        // Insert lands inside our delete: delete around it, keep the insert.
        const before = c.d.slice(0, other.p - c.p);
        const after = c.d.slice(other.p - c.p);
        if (before) dest.push({ p: c.p, d: before });
        if (after) dest.push({ p: c.p + other.i.length, d: after });
      }
      return;
    }
    if (isDelete(other)) {
      const cEnd = c.p + c.d.length;
      const oEnd = other.p + other.d.length;
      if (oEnd <= c.p) {
        dest.push({ p: c.p - other.d.length, d: c.d });
      } else if (other.p >= cEnd) {
        dest.push({ p: c.p, d: c.d });
      } else {
        // Overlap: only delete what the other op did not already delete.
        let remaining = '';
        if (c.p < other.p) remaining += c.d.slice(0, other.p - c.p);
        if (cEnd > oEnd) remaining += c.d.slice(oEnd - c.p);
        if (remaining) dest.push({ p: Math.min(c.p, other.p), d: remaining });
      }
      return;
    }
    dest.push({ ...c });
    return;
  }

  // Comment component: shift it like a range; drop it if its text was deleted.
  const cm = c as CommentComponent;
  if (isInsert(other)) {
    if (other.p <= cm.p) {
      dest.push({ ...cm, p: cm.p + other.i.length });
    } else if (other.p < cm.p + cm.c.length) {
      const offset = other.p - cm.p;
      dest.push({ ...cm, c: cm.c.slice(0, offset) + other.i + cm.c.slice(offset) });
    } else {
      dest.push({ ...cm });
    }
  } else if (isDelete(other)) {
    const cEnd = cm.p + cm.c.length;
    const oEnd = other.p + other.d.length;
    if (oEnd <= cm.p) {
      dest.push({ ...cm, p: cm.p - other.d.length });
    } else if (other.p >= cEnd) {
      dest.push({ ...cm });
    } else {
      const keepStart = Math.max(0, other.p - cm.p);
      const keepEnd = Math.max(0, oEnd - cm.p);
      const text = cm.c.slice(0, keepStart) + cm.c.slice(keepEnd);
      dest.push({ ...cm, p: Math.min(cm.p, other.p), c: text });
    }
  } else {
    dest.push({ ...cm });
  }
}

function transformComponentX(left: Component, right: Component, destLeft: Op, destRight: Op): void {
  transformComponent(destLeft, left, right, 'left');
  transformComponent(destRight, right, left, 'right');
}

/**
 * Transform two concurrent ops against each other (ShareJS bootstrapTransform).
 * Returns [left', right'] where apply(apply(s, left), right') equals
 * apply(apply(s, right), left'). On a tie, `left` inserts first.
 */
export function transformX(leftOp: Op, rightOp: Op): [Op, Op] {
  const newRightOp: Op = [];
  for (let rightComponent of rightOp) {
    const newLeftOp: Op = [];
    let k = 0;
    let carried: Component | null = rightComponent;
    while (k < leftOp.length) {
      const nextC: Op = [];
      transformComponentX(leftOp[k], carried!, newLeftOp, nextC);
      k++;
      if (nextC.length === 1) {
        carried = nextC[0];
      } else if (nextC.length === 0) {
        newLeftOp.push(...leftOp.slice(k));
        carried = null;
        break;
      } else {
        const [l, r] = transformX(leftOp.slice(k), nextC);
        newLeftOp.push(...l);
        newRightOp.push(...r);
        carried = null;
        break;
      }
    }
    if (carried) newRightOp.push(carried);
    leftOp = newLeftOp;
    rightComponent = carried as Component;
  }
  return [leftOp, newRightOp];
}

/** Transform `op` so it applies after the concurrent `other`. */
export function transform(op: Op, other: Op, side: 'left' | 'right'): Op {
  return side === 'left' ? transformX(op, other)[0] : transformX(other, op)[1];
}

/**
 * Smallest single replacement that turns `before` into `after`, as an op at
 * `offset`. Trims the shared prefix and suffix so unchanged text is not
 * deleted and re-inserted.
 */
export function replaceOp(offset: number, before: string, after: string): Op {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const op: Op = [];
  const removed = before.slice(start, endB);
  const added = after.slice(start, endA);
  if (removed) op.push({ p: offset + start, d: removed });
  if (added) op.push({ p: offset + start, i: added });
  return op;
}

/**
 * Word-level edit script from `before` to `after`, placed at `offset`.
 * Keeps untouched words in place, so a human's concurrent typing next to an
 * unchanged word is never disturbed.
 */
export function diffOp(offset: number, before: string, after: string, diffWords: (a: string, b: string) => { value: string; added?: boolean; removed?: boolean }[]): Op {
  const op: Op = [];
  let pos = offset;
  for (const part of diffWords(before, after)) {
    if (part.added) {
      const last = op[op.length - 1];
      if (last && isInsert(last) && last.p + last.i.length === pos) last.i += part.value;
      else op.push({ p: pos, i: part.value });
      pos += part.value.length;
    } else if (part.removed) {
      const last = op[op.length - 1];
      if (last && isDelete(last) && last.p === pos) last.d += part.value;
      else op.push({ p: pos, d: part.value });
    } else {
      pos += part.value.length;
    }
  }
  return op;
}
