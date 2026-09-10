import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, layoutTree, moveNode, parentOf } from '../src/core.mjs';
import { resolveNodeDrop } from '../src/node-drag.mjs';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const fixture = () => {
  const doc = createDocument();
  const children = { root: ['a', 'b', 'c'], a: ['aa', 'ab', 'ac'], b: ['ba', 'bb'], c: [], aa: ['aaa'], ab: [], ac: [], ba: [], bb: [], aaa: [] };
  for (const [id, items] of Object.entries(children)) doc.nodes[id] = { id, text: id, children: items, collapsed: false };
  return { doc: freeze(doc), boxes: freeze(layoutTree(doc).boxes) };
};
const inside = (box, portion = .5) => ({ x: box.x + box.width / 2, y: box.y + box.height * portion });
const gap = (box, y) => ({ x: box.x - 20, y });

test('direct node hits distinguish before, inside and after, while the root accepts only inside', () => {
  const { doc, boxes } = fixture();
  assert.deepEqual(resolveNodeDrop(doc, boxes, 'b', inside(boxes.a, .1)), { id: 'a', position: 'before' });
  assert.deepEqual(resolveNodeDrop(doc, boxes, 'b', inside(boxes.a)), { id: 'a', position: 'inside' });
  assert.deepEqual(resolveNodeDrop(doc, boxes, 'b', inside(boxes.c, .9)), { id: 'c', position: 'after' });
  for (const portion of [.1, .5, .9]) assert.deepEqual(resolveNodeDrop(doc, boxes, 'aa', inside(boxes.root, portion)), { id: 'root', position: 'inside' });
  for (const portion of [.25, .75]) assert.deepEqual(resolveNodeDrop(doc, boxes, 'b', inside(boxes.a, portion)), { id: 'a', position: 'inside' });
  assert.deepEqual(doc.nodes.root.children, ['a', 'b', 'c']);
});

test('source, descendant and root-source hits cannot become fallback drops or cycles', () => {
  const { doc, boxes } = fixture();
  for (const id of ['a', 'aa', 'aaa']) assert.equal(resolveNodeDrop(doc, boxes, 'a', inside(boxes[id])), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'root', inside(boxes.c)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'root', gap(boxes.root, 10000)), null);
  // Even overlapping geometry must not let a descendant hit fall through to an unrelated node.
  const overlapping = { ...boxes, aaa: { ...boxes.aaa, x: boxes.c.x, y: boxes.c.y, width: boxes.c.width, height: boxes.c.height } };
  assert.equal(resolveNodeDrop(doc, overlapping, 'a', inside(boxes.c)), null);
});

test('blank space reorders only the original siblings, including leading, middle and trailing gaps', () => {
  const { doc, boxes } = fixture();
  const before = resolveNodeDrop(doc, boxes, 'b', gap(boxes.b, boxes.a.y - 25));
  assert.deepEqual(before, { id: 'a', position: 'before' });
  assert.deepEqual(moveNode(doc, 'b', before.id, before.position).nodes.root.children, ['b', 'a', 'c']);
  const after = resolveNodeDrop(doc, boxes, 'b', gap(boxes.b, boxes.c.y + boxes.c.height + 25));
  assert.deepEqual(after, { id: 'c', position: 'after' });
  assert.deepEqual(moveNode(doc, 'b', after.id, after.position).nodes.root.children, ['a', 'c', 'b']);
  const middleY = (boxes.a.y + boxes.a.height / 2 + boxes.b.y + boxes.b.height / 2) / 2;
  assert.deepEqual(resolveNodeDrop(doc, boxes, 'c', gap(boxes.c, middleY)), { id: 'b', position: 'before' });
});

test('empty space alongside another family in the same column never changes the source parent', () => {
  const { doc, boxes } = fixture();
  const blank = gap(boxes.aa, boxes.bb.y + boxes.bb.height + 20);
  const target = resolveNodeDrop(doc, boxes, 'aa', blank);
  assert.deepEqual(target, { id: 'ac', position: 'after' });
  const moved = moveNode(doc, 'aa', target.id, target.position);
  assert.equal(parentOf(moved, 'aa'), 'a');
  assert.deepEqual(moved.nodes.a.children, ['ab', 'ac', 'aa']);
  assert.deepEqual(moved.nodes.b.children, ['ba', 'bb']);
  // A deliberate direct hit on that other family can still change ownership.
  assert.deepEqual(resolveNodeDrop(doc, boxes, 'aa', inside(boxes.ba)), { id: 'ba', position: 'inside' });
});

test('existing order produces no drop, including direct adjacency and appending to the current parent', () => {
  const { doc, boxes } = fixture();
  assert.equal(resolveNodeDrop(doc, boxes, 'b', inside(boxes.a, .9)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'b', inside(boxes.c, .1)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'c', inside(boxes.root)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'a', gap(boxes.a, -1000)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'c', gap(boxes.c, 10000)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'b', gap(boxes.b, boxes.b.y + boxes.b.height / 2)), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'aaa', gap(boxes.aaa, 10000)), null);
});

test('blank hit tolerance is limited to 44 graph units on either side of the original column', () => {
  const { doc, boxes } = fixture();
  const source = boxes.b;
  const y = -1000;
  for (const x of [source.x - 44, source.x + source.width + 44]) assert.deepEqual(resolveNodeDrop(doc, boxes, 'b', { x, y }), { id: 'a', position: 'before' });
  for (const x of [source.x - 44.01, source.x + source.width + 44.01]) assert.equal(resolveNodeDrop(doc, boxes, 'b', { x, y }), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'missing', { x: 0, y: 0 }), null);
  assert.equal(resolveNodeDrop(doc, {}, 'b', { x: 0, y: 0 }), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'b', { x: NaN, y: 0 }), null);
  assert.equal(resolveNodeDrop(doc, boxes, 'b', { x: 0, y: Infinity }), null);
});
