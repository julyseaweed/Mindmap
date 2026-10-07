import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, layoutTree } from '../src/core.mjs';
import { relationshipGeometry } from '../src/relationships.mjs';

const box = (id, x, y, width = 260, height = 40) => ({ id, x, y, width, height });
const link = (sourceId = 'a', targetId = 'b', text = '') => ({ id: 'link', sourceId, targetId, text });
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} != ${expected}`);
const samples = geometry => Array.from({ length: 1201 }, (_, index) => {
  const t = index / 1200, u = 1 - t;
  return {
    x: u ** 3 * geometry.start.x + 3 * u ** 2 * t * geometry.c1.x + 3 * u * t ** 2 * geometry.c2.x + t ** 3 * geometry.end.x,
    y: u ** 3 * geometry.start.y + 3 * u ** 2 * t * geometry.c1.y + 3 * u * t ** 2 * geometry.c2.y + t ** 3 * geometry.end.y,
  };
});
const inside = (point, rect) => point.x > rect.x + .02 && point.x < rect.x + rect.width - .02
  && point.y > rect.y + .02 && point.y < rect.y + rect.height - .02;
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const assertPerimeter = (point, rect) => {
  assert.ok(point.x >= rect.x - 1e-6 && point.x <= rect.x + rect.width + 1e-6 && point.y >= rect.y - 1e-6 && point.y <= rect.y + rect.height + 1e-6);
  assert.ok(Math.min(Math.abs(point.x - rect.x), Math.abs(point.x - rect.x - rect.width), Math.abs(point.y - rect.y), Math.abs(point.y - rect.y - rect.height)) < 1e-6);
};
const assertClear = (geometry, boxes, text = '') => {
  assert.ok(geometry && !/NaN|Infinity/.test(geometry.path));
  const points = samples(geometry);
  for (const [id, rect] of Object.entries(boxes)) {
    assert.ok(points.every(point => !inside(point, rect)), `relationship must not pass through ${id}`);
    if (text) assert.ok(!overlap(geometry.label, rect), `relationship text must not overlap ${id}`);
  }
  return points;
};
const assertDirect = (geometry, boxes, relationship) => {
  const points = assertClear(geometry, boxes, relationship.text);
  assertPerimeter(geometry.start, boxes[relationship.sourceId]);
  assertPerimeter(geometry.end, boxes[relationship.targetId]);
  const distance = Math.hypot(geometry.end.x - geometry.start.x, geometry.end.y - geometry.start.y);
  const length = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  assert.ok(length <= distance * 1.03 + .1, 'a clear corridor should not take a side detour');
  for (const axis of ['x', 'y']) {
    const low = Math.min(geometry.start[axis], geometry.end[axis]), high = Math.max(geometry.start[axis], geometry.end[axis]);
    assert.ok(points.every(point => point[axis] >= low - .05 && point[axis] <= high + .05), 'a clear route must not double back beyond its endpoints');
  }
};
const crowdedCaptionFixture = () => ({
  a: box('a', 400, 200, 220, 48),
  b: box('b', 400, 303.5, 220, 48),
  leftTop: box('leftTop', -80, 180, 220, 56),
  leftBottom: box('leftBottom', -80, 270, 220, 30),
  nearLeft: box('nearLeft', 160, 180, 220, 27),
  below: box('below', 400, 360, 220, 52),
  right: box('right', 640, 270, 220, 50),
});
const longCaption = Array(5).fill('synthetic relationship caption').join('\n');

test('clear same-column nodes connect their facing edges in both directions', () => {
  for (const gap of [28, 80, 160, 600]) {
    const boxes = { a: box('a', 200, 0), b: box('b', 200, 40 + gap) };
    for (const [sourceId, targetId] of [['a', 'b'], ['b', 'a']]) {
      const relationship = link(sourceId, targetId);
      const geometry = relationshipGeometry(relationship, boxes);
      assertDirect(geometry, boxes, relationship);
      close(geometry.start.x, 330); close(geometry.end.x, 330);
      close(geometry.start.y, sourceId === 'a' ? 40 : 40 + gap);
      close(geometry.end.y, targetId === 'a' ? 40 : 40 + gap);
    }
  }
});

test('clear same-row and diagonal connections use short routes in either direction', () => {
  for (const boxes of [
    { a: box('a', 0, 0), b: box('b', 420, 0) },
    { a: box('a', 0, 0), b: box('b', 420, 200) },
    { a: box('a', 0, 240), b: box('b', 420, 0) },
    { a: box('a', 0, 0, 1600, 120), b: box('b', 0, 200, 1600, 400) },
  ]) for (const [sourceId, targetId] of [['a', 'b'], ['b', 'a']]) {
    const relationship = link(sourceId, targetId);
    assertDirect(relationshipGeometry(relationship, boxes), boxes, relationship);
  }
});

test('an empty relationship does not reserve an invisible two-line caption across a short gap', () => {
  for (const gap of [4, 12, 28]) {
    const boxes = { a: box('a', 0, 0), b: box('b', 0, 40 + gap) };
    assertDirect(relationshipGeometry(link(), boxes), boxes, link());
  }
});

test('short real captions fit the direct corridor when there is room and avoid nodes when there is not', () => {
  for (const gap of [60, 140]) {
    const boxes = { a: box('a', 0, 0), b: box('b', 0, 40 + gap) };
    const relationship = link('a', 'b', '原因');
    assertDirect(relationshipGeometry(relationship, boxes), boxes, relationship);
  }
  const tight = { a: box('a', 0, 0), b: box('b', 0, 68) };
  assertClear(relationshipGeometry(link('a', 'b', '因'), tight), tight, '因');
});

test('a two-line caption keeps a direct route across a 55.5px gap', () => {
  const boxes = { a: box('a', 0, 0, 260, 48), b: box('b', 0, 103.5, 260, 27) };
  for (const [sourceId, targetId] of [['a', 'b'], ['b', 'a']]) {
    const relationship = link(sourceId, targetId, '上下一致的联系\n第二行说明');
    const geometry = relationshipGeometry(relationship, boxes);
    assert.equal(geometry.label.lines.length, 2);
    close(geometry.label.height, 50);
    assertDirect(geometry, boxes, relationship);
    close(geometry.start.x, 130); close(geometry.end.x, 130);
  }
});

test('crowded nodes and a long caption cannot make an automatic route fold through its own endpoints', () => {
  const boxes = crowdedCaptionFixture();
  for (const [sourceId, targetId] of [['a', 'b'], ['b', 'a']]) {
    const relationship = link(sourceId, targetId, longCaption);
    const geometry = relationshipGeometry(relationship, boxes);
    assertClear(geometry, { a: boxes.a, b: boxes.b });
    assertPerimeter(geometry.start, boxes[sourceId]);
    assertPerimeter(geometry.end, boxes[targetId]);
  }
});

test('unchanged crowded routes remain stable while an unrelated earlier caption grows', () => {
  const boxes = { ...crowdedCaptionFixture(), farA: box('farA', 2200, 1000), farB: box('farB', 2200, 1300) };
  const relationship = link('a', 'b', longCaption);
  let previous, previousWidth = 0;
  for (const text of ['a', 'ab', 'abc']) {
    const earlier = { ...link('farA', 'farB', text), id: 'earlier' };
    const context = { relationships: [earlier, relationship] };
    const earlierGeometry = relationshipGeometry(earlier, boxes, undefined, context);
    assert.ok(earlierGeometry.label.width > previousWidth, 'the earlier caption must change the routing prefix');
    previousWidth = earlierGeometry.label.width;
    const geometry = relationshipGeometry(relationship, boxes, undefined, context);
    assertClear(geometry, { a: boxes.a, b: boxes.b });
    assert.ok(Object.values(boxes).some(rect => overlap(geometry.label, rect)), 'this fixture must retain an unavoidable caption collision');
    if (previous) assert.equal(geometry.path, previous, 'an unchanged unavoidable collision must not destabilize the preferred route');
    previous = geometry.path;
  }
});

test('adding a child outside an unchanged clear corridor does not change its automatic route', () => {
  const boxes = { root: box('root', 0, 130, 160), a: box('a', 248, 0, 180), b: box('b', 248, 260, 180) };
  const relationship = link();
  const context = { rootId: 'root', nodes: { root: { children: ['a', 'b'] }, a: { children: [] }, b: { children: [] } }, relationships: [relationship] };
  const before = relationshipGeometry(relationship, boxes, undefined, context);
  const extended = { ...boxes, child: box('child', 492, 260, 180) };
  const nextContext = { ...context, nodes: { ...context.nodes, b: { children: ['child'] }, child: { children: [] } } };
  const after = relationshipGeometry(relationship, extended, undefined, nextContext);
  assertDirect(before, boxes, relationship);
  assertDirect(after, extended, relationship);
  assert.equal(after.path, before.path, 'an unrelated child must not force a reversal through the upper node');
});

test('real layout changes after adding lower-node children cannot create a vertical fold through the upper node', () => {
  const doc = createDocument('Routing fixture');
  doc.nodes.root.children = ['a', 'b'];
  doc.nodes.a = { id: 'a', text: '上节点\nSecond line', children: [], collapsed: false };
  doc.nodes.b = { id: 'b', text: '下节点', children: [], collapsed: false };
  doc.relationships = [link()];
  for (const count of [0, 1, 2, 5]) {
    const current = structuredClone(doc);
    for (let index = 0; index < count; index++) {
      const id = `child${index}`;
      current.nodes.b.children.push(id);
      current.nodes[id] = { id, text: `子节点 ${index}\n说明`, children: [], collapsed: false };
    }
    const layout = layoutTree(current);
    const relationship = current.relationships[0];
    const geometry = relationshipGeometry(relationship, layout.boxes, undefined, current);
    assertDirect(geometry, layout.boxes, relationship);
    close(geometry.start.y, layout.boxes.a.y + layout.boxes.a.height);
    close(geometry.end.y, layout.boxes.b.y);
  }
});

test('a midpoint node blocks the short corridor and the detour still clears every node', () => {
  const boxes = { a: box('a', 220, 0, 180), b: box('b', 220, 280, 180), middle: box('middle', 220, 120, 180) };
  const geometry = relationshipGeometry(link(), boxes);
  assertClear(geometry, boxes);
  assert.ok(samples(geometry).some(point => point.x < boxes.middle.x || point.x > boxes.middle.x + boxes.middle.width), 'an actual obstacle requires a detour');
});

test('a parent-child relationship avoids retracing the visible solid connector', () => {
  const boxes = { a: box('a', 0, 100, 160), b: box('b', 300, 100, 160) };
  const relationship = link();
  const context = { rootId: 'a', nodes: { a: { children: ['b'] }, b: { children: [] } }, relationships: [relationship] };
  const geometry = relationshipGeometry(relationship, boxes, undefined, context);
  const points = assertClear(geometry, boxes);
  assert.ok(points.every(point => point.x <= 163 || point.x >= 295 || Math.abs(point.y - 120) >= 5), 'dashed and solid connectors must not occupy the same corridor');
});

test('a captioned parent-child relationship separates from the solid line at actual compact node sizes', () => {
  const boxes = { a: box('a', 0, 100, 152, 27), b: box('b', 240, 100, 100, 27) };
  const relationship = link('a', 'b', '原因');
  const context = { rootId: 'a', nodes: { a: { children: ['b'] }, b: { children: [] } }, relationships: [relationship] };
  const geometry = relationshipGeometry(relationship, boxes, undefined, context);
  const points = assertClear(geometry, boxes, relationship.text);
  const solidY = 113.5;
  assert.ok(points.every(point => point.x <= 155 || point.x >= 235 || Math.abs(point.y - solidY) >= 5), 'a real caption must not make the automatic route retrace the parent connector');
  const captionCoversSolid = geometry.label.x < 238 && geometry.label.x + geometry.label.width > 152
    && geometry.label.y < solidY && geometry.label.y + geometry.label.height > solidY;
  assert.equal(captionCoversSolid, false, 'the caption background must not hide the parent connector');
});

test('opposite relationships do not simply retrace each other in a clear corridor', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 0, 240) };
  const forward = link(), reverse = { ...link('b', 'a'), id: 'reverse' };
  const context = { relationships: [forward, reverse] };
  const first = relationshipGeometry(forward, boxes, undefined, context);
  const second = relationshipGeometry(reverse, boxes, undefined, context);
  assertClear(first, boxes); assertClear(second, boxes);
  assert.ok(samples(second).some(point => Math.abs(point.x - first.start.x) > 5), 'the return relationship should leave a separate route');
});

test('manual controls stay exact and partially specified or zero controls remain finite', () => {
  const boxes = { a: box('a', 0, 0), b: box('b', 0, 240), middle: box('middle', 0, 100) };
  const manual = { ...link(), control1: { x: 130, y: 170 }, control2: { x: -140, y: -210 } };
  const before = structuredClone(manual);
  const geometry = relationshipGeometry(manual, boxes);
  assert.deepEqual(geometry.control1, manual.control1); assert.deepEqual(geometry.control2, manual.control2);
  assert.deepEqual(manual, before, 'routing must not migrate stored manual controls');
  for (const partial of [{ control1: { x: 150, y: 20 } }, { control2: { x: -140, y: 60 } }, { control1: { x: 0, y: 0 }, control2: { x: 0, y: 0 } }]) {
    const result = relationshipGeometry({ ...link(), ...partial }, boxes);
    assert.ok(!/NaN|Infinity/.test(result.path));
    for (const key of ['control1', 'control2']) if (partial[key]) assert.deepEqual(result[key], partial[key]);
    assertPerimeter(result.start, boxes.a); assertPerimeter(result.end, boxes.b);
  }
});
