import test from 'node:test';
import assert from 'node:assert/strict';
import { relationshipBounds, relationshipGeometry } from '../src/relationships.mjs';
import { createDocument, layoutTree } from '../src/core.mjs';

const box = (id, x, y, width = 100, height = 40) => ({ id, x, y, width, height });
const relation = { id: 'relation', sourceId: 'a', targetId: 'b', text: '' };
const measure = text => [...text].length * 14;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const perimeter = (point, rect) => {
  const inside = point.x >= rect.x - 1e-7 && point.x <= rect.x + rect.width + 1e-7 && point.y >= rect.y - 1e-7 && point.y <= rect.y + rect.height + 1e-7;
  const edge = Math.min(Math.abs(point.x - rect.x), Math.abs(point.x - rect.x - rect.width), Math.abs(point.y - rect.y), Math.abs(point.y - rect.y - rect.height)) < 1e-7;
  assert.ok(inside && edge, 'endpoint must lie on the rectangle perimeter');
};

test('same-row relationships bow above nodes and terminate at node borders', () => {
  const boxes = { a: box('a', 0, 100), b: box('b', 300, 100) };
  const result = relationshipGeometry(relation, boxes, measure);
  perimeter(result.start, boxes.a); perimeter(result.end, boxes.b);
  assert.ok(result.c1.y < boxes.a.y && result.c2.y < boxes.b.y);
  assert.ok(result.label.y + result.label.height / 2 < boxes.a.y);
  assert.ok(result.path.startsWith('M ') && result.path.includes(' C '));
});

test('same-column relationships bow right and custom controls choose the corresponding border', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 0, 200) };
  const result = relationshipGeometry(relation, boxes);
  assert.ok(result.c1.x > 100 && result.c2.x > 100);
  const custom = relationshipGeometry({ ...relation, control1: { x: -180, y: 0 }, control2: { x: 0, y: 160 } }, boxes);
  close(custom.start.x, 0); close(custom.start.y, 20);
  close(custom.end.x, 50); close(custom.end.y, 240);
});

test('default handles remain outside very wide and tall node boxes', () => {
  for (const boxes of [
    { a: box('a', 0, 0, 1600), b: box('b', 0, 200, 1600) },
    { a: box('a', 0, 0, 1600, 1200), b: box('b', 1700, 0, 1600, 1200) },
    { a: box('a', 0, 0, 1600, 1200), b: box('b', 1700, 1400, 1600, 1200) },
  ]) {
    const result = relationshipGeometry(relation, boxes);
    for (const [control, rect] of [[result.c1, boxes.a], [result.c2, boxes.b]]) {
      assert.ok(control.x < rect.x || control.x > rect.x + rect.width || control.y < rect.y || control.y > rect.y + rect.height);
    }
    perimeter(result.start, boxes.a); perimeter(result.end, boxes.b);
  }
});

test('default labels clear their endpoints even with nearby nodes and long text', () => {
  const text = '这段联系文字需要保持完整并且不能被节点遮盖\nThe relationship remains outside both endpoints';
  const columns = { a: box('a', 0, 0, 260), b: box('b', 0, 60, 260) };
  const beside = relationshipGeometry({ ...relation, text }, columns, measure);
  assert.ok(beside.label.x >= 260 + 16 - 1e-7);
  const rows = { a: box('a', 0, 0, 260), b: box('b', 348, 0, 260) };
  const above = relationshipGeometry({ ...relation, text: text.repeat(4) }, rows, measure);
  assert.ok(above.label.y + above.label.height <= -16 + 1e-7);
});

test('custom controls travel with their respective endpoint after layout changes', () => {
  const controls = { control1: { x: -120, y: -90 }, control2: { x: 120, y: -80 } };
  const before = relationshipGeometry({ ...relation, ...controls }, { a: box('a', 0, 0), b: box('b', 300, 0) });
  const after = relationshipGeometry({ ...relation, ...controls }, { a: box('a', 50, 70), b: box('b', 400, 120) });
  close(after.start.x - before.start.x, 50); close(after.start.y - before.start.y, 70);
  close(after.c1.x - before.c1.x, 50); close(after.c1.y - before.c1.y, 70);
  close(after.c2.x - before.c2.x, 100); close(after.c2.y - before.c2.y, 120);
  assert.deepEqual(after.control1, controls.control1); assert.deepEqual(after.control2, controls.control2);
});

test('hidden endpoints omit relationships without changing stored data', () => {
  const boxes = { a: box('a', 0, 0) };
  assert.equal(relationshipGeometry(relation, boxes), null);
  assert.deepEqual(relationshipBounds({ boxes, width: 100, height: 40 }, [relation]), { x: 0, y: 0, width: 100, height: 40 });
  assert.equal(relation.targetId, 'b');
});

test('label wraps horizontally, preserves explicit newlines, and participates in bounds', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 200, 0) };
  const text = '这是一段需要自动换行的联系文字包含中英文内容\nsecond line\n';
  const result = relationshipGeometry({ ...relation, text }, boxes, measure);
  assert.ok(result.label.width <= 280);
  assert.ok(result.label.lines.length >= 4);
  assert.equal(result.label.lines.join(''), text.replaceAll('\n', ''));
  assert.equal(result.label.lines.at(-1), '');
  assert.equal(result.label.height, result.label.lines.length * 23 + 8);
  assert.ok(result.bounds.y <= result.label.y);
  assert.ok(result.bounds.x <= result.label.x);
  assert.ok(result.bounds.x + result.bounds.width >= result.label.x + result.label.width);
  assert.ok(result.bounds.y + result.bounds.height >= result.label.y + result.label.height);
});

test('bounds use actual curve extrema and retain negative coordinates for fit and PDF', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 300, 0) };
  const custom = { ...relation, control1: { x: 0, y: -400 }, control2: { x: 0, y: -400 } };
  const result = relationshipGeometry(custom, boxes);
  // The top extremum lies at t=.5, not at either off-curve control point.
  close(result.bounds.y, -290);
  assert.ok(result.bounds.y > result.c1.y);
  const combined = relationshipBounds({ boxes, width: 400, height: 40 }, [custom]);
  close(combined.x, 0); close(combined.y, -290); close(combined.width, 400); close(combined.height, 330);
});

test('zero and nearly straight control vectors produce finite geometry', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 300, 0) };
  for (const controls of [
    { control1: { x: 0, y: 0 }, control2: { x: 0, y: 0 } },
    { control1: { x: 100, y: 1e-12 }, control2: { x: -100, y: 1e-12 } },
  ]) {
    const result = relationshipGeometry({ ...relation, ...controls }, boxes);
    perimeter(result.start, boxes.a); perimeter(result.end, boxes.b);
    for (const value of Object.values(result.bounds)) assert.ok(Number.isFinite(value));
    assert.ok(!/NaN|Infinity/.test(result.path));
  }
});

const samples = (geometry, count = 1200) => Array.from({ length: count + 1 }, (_, i) => {
  const t = i / count, u = 1 - t;
  return {
    x: u ** 3 * geometry.start.x + 3 * u ** 2 * t * geometry.c1.x + 3 * u * t ** 2 * geometry.c2.x + t ** 3 * geometry.end.x,
    y: u ** 3 * geometry.start.y + 3 * u ** 2 * t * geometry.c1.y + 3 * u * t ** 2 * geometry.c2.y + t ** 3 * geometry.end.y,
  };
});
const inside = (point, rect, inset = 0) => point.x > rect.x + inset && point.x < rect.x + rect.width - inset && point.y > rect.y + inset && point.y < rect.y + rect.height - inset;
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const assertClearNodes = (geometry, boxes) => {
  for (const [id, rect] of Object.entries(boxes)) {
    assert.ok(samples(geometry).every(point => !inside(point, rect, .05)), `curve intersects node ${id}`);
    assert.ok(!overlap(geometry.label, rect), `caption intersects node ${id}`);
  }
};
const treeFixture = () => ({
  ...createDocument('阅读与思考'),
  nodes: {
    root: { id: 'root', text: '阅读与思考', children: ['alpha', 'beta', 'gamma'] },
    alpha: { id: 'alpha', text: '观察\nObservation', children: ['detail'] },
    detail: { id: 'detail', text: '一个具体例子', children: [] },
    beta: { id: 'beta', text: '推论\nConclusion', children: [] },
    gamma: { id: 'gamma', text: '其他思考', children: [] },
  },
  relationships: [{ id: 'link', sourceId: 'alpha', targetId: 'beta', text: '产生推论\nRelationship' }],
});

test('a relationship between siblings clears their tree, child node and caption without a large detour', () => {
  const doc = treeFixture(), layout = layoutTree(doc);
  const geometry = relationshipGeometry(doc.relationships[0], layout.boxes, undefined, doc);
  assertClearNodes(geometry, layout.boxes);
  perimeter(geometry.start, layout.boxes.alpha); perimeter(geometry.end, layout.boxes.beta);
  assert.ok(Math.hypot(geometry.control1.x, geometry.control1.y) < 360, 'nearby siblings need a compact arch');
  assert.ok(Math.hypot(geometry.control2.x, geometry.control2.y) < 360);
  // The source's child connector is horizontal. Leave from a separate port.
  const source = layout.boxes.alpha, child = layout.boxes.detail;
  const connectorY = source.y + source.height / 2;
  assert.ok(samples(geometry).every(point => point.x < source.x + source.width || point.x > child.x || Math.abs(point.y - connectorY) > 5));
});

test('automatic routes stay clear of a midpoint sibling and an occupied right column', () => {
  const boxes = {
    a: box('a', 200, 0, 150), b: box('b', 200, 180, 150),
    middle: box('middle', 200, 90, 150), right: box('right', 400, 30, 360, 210),
  };
  const geometry = relationshipGeometry({ ...relation, text: '联系说明' }, boxes);
  assertClearNodes(geometry, boxes);
  assert.ok(geometry.label.x + geometry.label.width < boxes.a.x, 'use the available left side instead of crossing the occupied column');
});

test('crowded columns prefer a clear outer corridor and retain deterministic controls', () => {
  const boxes = { a: box('a', 280, 70, 150), b: box('b', 650, 270, 150) };
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    if ((column === 1 && row === 0) || (column === 2 && row === 2)) continue;
    const id = `obstacle-${column}-${row}`;
    const candidate = box(id, 80 + column * 200, 40 + row * 100, 140, 45);
    if (!overlap(candidate, boxes.a) && !overlap(candidate, boxes.b)) boxes[id] = candidate;
  }
  const first = relationshipGeometry({ ...relation, text: '跨列联系' }, boxes);
  const second = relationshipGeometry({ ...relation, text: '跨列联系' }, structuredClone(boxes));
  assertClearNodes(first, boxes);
  assert.equal(first.path, second.path);
});

test('existing relationship curves and captions influence new automatic routes', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 0, 200) };
  const first = { ...relation, text: '已经存在的联系' };
  const next = { id: 'return', sourceId: 'b', targetId: 'a', text: '另一条联系' };
  const context = { relationships: [first, next] };
  const before = relationshipGeometry(first, boxes, undefined, context);
  const after = relationshipGeometry(next, boxes, undefined, context);
  assertClearNodes(before, boxes); assertClearNodes(after, boxes);
  assert.ok(!overlap(before.label, after.label), 'captions should occupy different clear space');
  assert.ok(samples(after).every(point => !inside(point, before.label)), 'new curve must not pass through the earlier caption');
  assert.notEqual(after.path, relationshipGeometry(next, boxes).path, 'prior relationships must participate in routing');
});

test('one- and two-line typing preserve automatic controls while the label grows', () => {
  const doc = treeFixture(), layout = layoutTree(doc);
  const base = { ...doc.relationships[0], text: '' };
  let path;
  for (const text of ['', '联系', 'Relationship', '联系\nRelationship']) {
    const relationship = { ...base, text };
    const context = { ...doc, relationships: [relationship] };
    const geometry = relationshipGeometry(relationship, layout.boxes, undefined, context);
    path ??= geometry.path;
    assert.equal(geometry.path, path);
    assertClearNodes(geometry, layout.boxes);
  }
});

test('manual controls remain exact even when they cross an obstacle or another relationship', () => {
  const doc = treeFixture(), layout = layoutTree(doc);
  const manual = { ...doc.relationships[0], control1: { x: 140, y: 0 }, control2: { x: 140, y: 0 } };
  const geometry = relationshipGeometry(manual, layout.boxes, undefined, { ...doc, relationships: [manual] });
  assert.deepEqual(geometry.control1, manual.control1); assert.deepEqual(geometry.control2, manual.control2);
  assert.equal(geometry.path, relationshipGeometry(manual, layout.boxes).path);
});
