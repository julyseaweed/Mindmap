import { wrapText } from './text-wrap.mjs';
import { treeConnector } from './tree-connectors.mjs';

const labelPaddingX = 8;
const labelPaddingY = 4;
const labelMaxWidth = 280;
const lineHeight = 23;
const fallbackMeasure = text => [...text].reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 14 : 7.5), 0);
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });

function outside(box, vector) {
  const factor = Math.max(1, Math.min(vector.x ? (box.width / 2 + 28) / Math.abs(vector.x) : Infinity, vector.y ? (box.height / 2 + 28) / Math.abs(vector.y) : Infinity));
  return { x: vector.x * factor, y: vector.y * factor };
}

function defaultControls(sourceBox, targetBox, label) {
  const source = center(sourceBox), target = center(targetBox);
  const dx = target.x - source.x, dy = target.y - source.y;
  if (Math.abs(dx) < 1) {
    const right1 = sourceBox.x + sourceBox.width, right2 = targetBox.x + targetBox.width;
    const labelClearance = (Math.abs(right1 - right2) / 2 + label.width / 2 + 16) / .75;
    const bow = Math.max(90, Math.abs(dy) * .4, labelClearance);
    return { control1: { x: sourceBox.width / 2 + bow, y: 0 }, control2: { x: targetBox.width / 2 + bow, y: 0 } };
  }
  if (Math.abs(dy) < 1) {
    const labelClearance = (Math.abs(sourceBox.y - targetBox.y) / 2 + label.height / 2 + 16) / .75;
    const bow = Math.max(80, Math.min(220, Math.abs(dx) * .24), labelClearance);
    return { control1: { x: 0, y: -sourceBox.height / 2 - bow }, control2: { x: 0, y: -targetBox.height / 2 - bow } };
  }
  const length = Math.hypot(dx, dy);
  const bow = Math.max(80, Math.min(220, length * .24));
  const direction = dx > 0 ? 1 : -1;
  const nx = dy / length * direction, ny = -dx / length * direction;
  return {
    control1: outside(sourceBox, { x: dx / 3 + nx * bow, y: dy / 3 + ny * bow }),
    control2: outside(targetBox, { x: -dx / 3 + nx * bow, y: -dy / 3 + ny * bow }),
  };
}

function endpoint(box, vector, fallback) {
  const point = center(box);
  const direction = Math.hypot(vector.x, vector.y) < .001 ? fallback : vector;
  const factor = Math.min(direction.x ? box.width / 2 / Math.abs(direction.x) : Infinity, direction.y ? box.height / 2 / Math.abs(direction.y) : Infinity);
  return add(point, { x: direction.x * factor, y: direction.y * factor });
}

function curveAt(a, b, c, d, t) {
  const inverse = 1 - t;
  return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d;
}

function extrema(a, b, c, d) {
  const quadratic = -a + 3 * b - 3 * c + d;
  const linear = 2 * (a - 2 * b + c);
  const constant = b - a;
  if (Math.abs(quadratic) < 1e-9) return Math.abs(linear) < 1e-9 ? [] : [-constant / linear];
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-linear + root) / (2 * quadratic), (-linear - root) / (2 * quadratic)];
}

function curveBounds(start, c1, c2, end) {
  const values = axis => [start[axis], end[axis], ...extrema(start[axis], c1[axis], c2[axis], end[axis])
    .filter(t => t > 0 && t < 1).map(t => curveAt(start[axis], c1[axis], c2[axis], end[axis], t))];
  const xs = values('x'), ys = values('y');
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function labelGeometry(text, point, measure) {
  const width = Math.max(text ? 24 : 96, Math.min(labelMaxWidth, Math.max(...text.split('\n').map(measure)) + labelPaddingX * 2));
  const lines = wrapText(text, width - labelPaddingX * 2, measure);
  const height = Math.max(1, lines.length) * lineHeight + labelPaddingY * 2;
  return { x: point.x - width / 2, y: point.y - height / 2, width, height, lines };
}

function buildGeometry(relationship, boxes, labelSize, controls) {
  const source = boxes[relationship.sourceId], target = boxes[relationship.targetId];
  if (!source || !target || source === target) return null;
  const sourceCenter = center(source), targetCenter = center(target);
  const defaults = defaultControls(source, target, labelSize);
  const control1 = relationship.control1 ?? controls.control1, control2 = relationship.control2 ?? controls.control2;
  const c1 = add(sourceCenter, control1), c2 = add(targetCenter, control2);
  const start = endpoint(source, control1, defaults.control1), end = endpoint(target, control2, defaults.control2);
  const middle = { x: curveAt(start.x, c1.x, c2.x, end.x, .5), y: curveAt(start.y, c1.y, c2.y, end.y, .5) };
  const label = { ...labelSize, x: middle.x - labelSize.width / 2, y: middle.y - labelSize.height / 2 };
  const curve = curveBounds(start, c1, c2, end);
  // Include the arrowhead and stroke, while keeping curve extrema exact before padding.
  let bounds = { x: curve.x - 5, y: curve.y - 5, width: curve.width + 10, height: curve.height + 10 };
  if (relationship.text) bounds = union(bounds, label);
  const path = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
  return { path, start, end, c1, c2, control1, control2, label, bounds };
}

const expand = (rect, gap) => ({ x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 });
const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const segmentBounds = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

// A small uniform grid limits collision checks to objects near each candidate.
function spatialIndex(items = []) {
  const cells = new Map(), large = [];
  const visit = (bounds, callback) => {
    const x1 = Math.floor(bounds.x / 160), x2 = Math.floor((bounds.x + bounds.width) / 160);
    const y1 = Math.floor(bounds.y / 160), y2 = Math.floor((bounds.y + bounds.height) / 160);
    if ((x2 - x1 + 1) * (y2 - y1 + 1) > 1600) return false;
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) callback(`${x},${y}`);
    return true;
  };
  const all = [];
  const insert = item => {
    all.push(item);
    if (!visit(item.bounds, key => { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(item); })) large.push(item);
  };
  for (const item of items) insert(item);
  return {
    insert,
    query(bounds) {
      const found = new Set(large);
      if (!visit(bounds, key => { for (const item of cells.get(key) ?? []) found.add(item); })) return all;
      return [...found];
    },
  };
}

function segmentHitsBox(a, b, box) {
  let low = 0, high = 1;
  for (const axis of ['x', 'y']) {
    const delta = b[axis] - a[axis], min = box[axis], max = min + box[axis === 'x' ? 'width' : 'height'];
    if (Math.abs(delta) < 1e-9) { if (a[axis] < min || a[axis] > max) return false; }
    else {
      const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta;
      low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return true;
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pointDistance = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};
function segmentsMeet(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b)) < 5;
}

function sampleCurve(geometry) {
  const { start, c1, c2, end } = geometry;
  const points = [start];
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const flatten = (a, b, c, d, depth) => {
    if (depth >= 10 || Math.max(pointDistance(b, a, d), pointDistance(c, a, d)) <= 1) { points.push(d); return; }
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    flatten(a, ab, abc, middle, depth + 1); flatten(middle, bcd, cd, d, depth + 1);
  };
  flatten(start, c1, c2, end, 0);
  return points;
}

function edgeSegments(geometry, id) {
  const points = sampleCurve(geometry);
  return points.slice(1).map((b, i) => ({ a: points[i], b, id, bounds: expand(segmentBounds(points[i], b), 5) }));
}

const scenesByBoxes = new WeakMap();
const recentScenes = new Map();
function routingScene(boxes, nodes, rootId) {
  const previous = scenesByBoxes.get(boxes);
  if (previous && previous.nodes === nodes && previous.rootId === rootId) return previous.scene;
  const entries = Object.entries(boxes);
  const links = [];
  for (const [id] of entries) if (!nodes?.[id]?.collapsed) {
    for (const child of nodes?.[id]?.children ?? []) if (boxes[child]) links.push([id, child]);
  }
  // Reusing identical geometry also covers immutable document updates while typing.
  const key = JSON.stringify([rootId, entries.map(([id, box]) => [id, box.x, box.y, box.width, box.height]), links]);
  let scene = recentScenes.get(key);
  if (!scene) {
    const obstacles = entries.map(([id, box]) => ({ id, box, bounds: expand(box, 12) }));
    const tree = links.flatMap(([parentId, childId]) => {
      const parent = boxes[parentId], child = boxes[childId];
      const start = { x: parent.x + parent.width, y: parent.y + parent.height / 2 };
      const end = { x: child.x - 2, y: child.y + child.height / 2 };
      const rootBranch = parentId === rootId;
      const connector = treeConnector(start, end, rootBranch);
      // Shared trunks count as one obstacle, regardless of the number of children.
      const obstacleId = rootBranch ? `tree:${parentId}>${childId}` : `tree:${parentId}`;
      return connector.curves.flatMap(curve => edgeSegments(curve, obstacleId));
    });
    scene = { boxes, obstacles: spatialIndex(obstacles), tree, routes: new Map(), batches: new Map() };
    recentScenes.set(key, scene);
    if (recentScenes.size > 8) recentScenes.delete(recentScenes.keys().next().value);
  }
  scenesByBoxes.set(boxes, { nodes, rootId, scene });
  return scene;
}

function scoreRoute(geometry, relationship, scene, edges, labels, ceiling) {
  const points = sampleCurve(geometry);
  let hits = 0;
  const rejected = () => ({ hits, crossings: Infinity, length: Infinity, cost: Infinity });
  const tooManyHits = () => ceiling && hits > ceiling.hits;
  const hitBoxes = new Set();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (const obstacle of scene.obstacles.query(expand(segmentBounds(a, b), 12))) {
      if (hitBoxes.has(obstacle.id)) continue;
      const endpointBox = obstacle.id === relationship.sourceId || obstacle.id === relationship.targetId;
      const bounds = endpointBox ? expand(obstacle.box, -.5) : obstacle.bounds;
      if (segmentHitsBox(a, b, bounds)) { hits++; hitBoxes.add(obstacle.id); }
      if (tooManyHits()) return rejected();
    }
  }
  const hitLabels = new Set();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (const prior of labels.query(expand(segmentBounds(a, b), 6))) {
      if (hitLabels.has(prior)) continue;
      if (segmentHitsBox(a, b, prior.bounds)) { hits++; hitLabels.add(prior); }
      if (tooManyHits()) return rejected();
    }
  }
  const label = expand(geometry.label, 8);
  for (const obstacle of scene.obstacles.query(label)) if (intersects(label, obstacle.box)) hits++;
  for (const prior of labels.query(label)) if (intersects(label, prior.bounds)) hits++;
  if (tooManyHits()) return rejected();
  const crossed = new Set();
  const length = points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0);
  const handleLength = distance(geometry.start, geometry.c1) + distance(geometry.end, geometry.c2);
  const baseCost = length + handleLength * .08;
  if (ceiling && hits === ceiling.hits && baseCost > ceiling.cost) return { hits, crossings: 0, length, cost: baseCost };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (const edge of edges.query(expand(segmentBounds(a, b), 5))) {
      if (crossed.has(edge.id)) continue;
      // Separate ports on a node are preferable to retracing its tree connector.
      if (segmentsMeet(a, b, edge.a, edge.b)) crossed.add(edge.id);
    }
    if (ceiling && hits === ceiling.hits && baseCost + crossed.size * 100 > ceiling.cost) return { hits, crossings: crossed.size, length, cost: baseCost + crossed.size * 100 };
  }
  for (const edge of edges.query(label)) if (segmentHitsBox(edge.a, edge.b, label)) crossed.add(edge.id);
  return { hits, crossings: crossed.size, length, cost: baseCost + crossed.size * 100 };
}

function* controlCandidates(sourceBox, targetBox, label, obstacles) {
  const source = center(sourceBox), target = center(targetBox);
  const dx = target.x - source.x, dy = target.y - source.y;
  const base = Math.max(90, Math.min(240, Math.hypot(dx, dy) * .3));
  for (const sign of [1, -1]) for (const shift of [24, -24, 48, -48, 80, -80]) {
    const bow = Math.max(base, (label.width / 2 + 28) / .75);
    yield { control1: { x: sign * (sourceBox.width / 2 + bow), y: shift }, control2: { x: sign * (targetBox.width / 2 + bow), y: shift } };
    const rise = Math.max(base, (label.height / 2 + 28) / .75);
    yield { control1: { x: shift, y: sign * (sourceBox.height / 2 + rise) }, control2: { x: shift, y: sign * (targetBox.height / 2 + rise) } };
  }
  // First try nearby arches. Quarter-side ports avoid the existing tree ports.
  for (const sign of [1, -1]) for (const multiplier of [1, 1.8, 3.2]) for (const tilt of [0, .5, -.5]) {
    const bow = Math.max(base * multiplier, (label.width / 2 + 28) / .75);
    const toward = Math.sign(dy) || 1;
    yield { control1: { x: sign * (sourceBox.width / 2 + bow), y: toward * bow * tilt }, control2: { x: sign * (targetBox.width / 2 + bow), y: -toward * bow * tilt } };
    const rise = Math.max(base * multiplier, (label.height / 2 + 28) / .75);
    const across = Math.sign(dx) || 1;
    yield { control1: { x: across * rise * tilt, y: sign * (sourceBox.height / 2 + rise) }, control2: { x: -across * rise * tilt, y: sign * (targetBox.height / 2 + rise) } };
  }
  // Size outer arches from nearby occupied space instead of guessing a fixed bend.
  let occupied = union(sourceBox, targetBox);
  const near = expand(occupied, 400);
  for (const obstacle of obstacles.query(near)) if (intersects(near, obstacle.box)) occupied = union(occupied, obstacle.box);
  for (const margin of [40, 140, 320]) for (const side of ['right', 'left', 'top', 'bottom']) {
    const horizontal = side === 'right' || side === 'left';
    const sign = side === 'right' || side === 'bottom' ? 1 : -1;
    const axis = horizontal ? 'x' : 'y', other = horizontal ? 'y' : 'x';
    const dimension = horizontal ? 'width' : 'height';
    const boundary = occupied[axis] + (sign > 0 ? occupied[dimension] : 0) + sign * (margin + label[dimension] / 2);
    const wall = (boundary - .125 * (source[axis] + target[axis])) / .75;
    for (const tilt of [0, .3, -.3]) {
      const toward = Math.sign(target[other] - source[other]) || 1;
      const delta1 = wall - source[axis], delta2 = wall - target[axis];
      yield { control1: { [axis]: delta1, [other]: toward * Math.abs(delta1) * tilt }, control2: { [axis]: delta2, [other]: -toward * Math.abs(delta2) * tilt } };
    }
  }
}

function routeControls(relationship, scene, label, edges, labels, prefix) {
  const source = scene.boxes[relationship.sourceId], target = scene.boxes[relationship.targetId];
  const defaults = defaultControls(source, target, label);
  if (relationship.control1 && relationship.control2) return defaults;
  const key = JSON.stringify([relationship.sourceId, relationship.targetId, label.width, label.height, relationship.control1, relationship.control2, prefix]);
  const cached = scene.routes.get(key);
  if (cached) return cached;
  let best, bestScore;
  const consider = controls => {
    const bounded = point => ({ x: Math.max(-100000, Math.min(100000, point.x)), y: Math.max(-100000, Math.min(100000, point.y)) });
    controls = { control1: bounded(controls.control1), control2: bounded(controls.control2) };
    const geometry = buildGeometry(relationship, scene.boxes, label, controls);
    const score = scoreRoute(geometry, relationship, scene, edges, labels, bestScore);
    if (!bestScore || score.hits < bestScore.hits || (score.hits === bestScore.hits && score.cost < bestScore.cost)) {
      best = controls; bestScore = score;
    }
  };
  consider(defaults);
  if (bestScore.hits || bestScore.crossings) {
    for (const candidate of controlCandidates(source, target, label, scene.obstacles)) consider(candidate);
    // Different departure/arrival sides can fit through crowded column gaps.
    if (bestScore.hits || bestScore.crossings) {
      const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      const separation = Math.hypot(center(target).x - center(source).x, center(target).y - center(source).y);
      for (const factor of [.65, 1.3, 2.5]) for (const first of directions) for (const last of directions) {
        const vector = (box, direction) => {
          const length = Math.max(100, separation * factor);
          return outside(box, { x: direction[0] * length, y: direction[1] * length });
        };
        consider({ control1: vector(source, first), control2: vector(target, last) });
      }
    }
  }
  scene.routes.set(key, best);
  if (scene.routes.size > 4096) scene.routes.delete(scene.routes.keys().next().value);
  return best;
}

function reservedLabel(label) {
  // Reserve one full label from the start, so ordinary typing does not move it.
  return { ...label, width: labelMaxWidth, height: Math.max(54, Math.ceil((label.height - labelPaddingY * 2) / 46) * 46 + labelPaddingY * 2) };
}

const noRelationships = [];
function extendSignature(signature, text) {
  let [first, second, count] = signature;
  for (let i = 0; i < text.length; i++) {
    first = Math.imul(first ^ text.charCodeAt(i), 16777619) >>> 0;
    second = Math.imul(second ^ text.charCodeAt(i), 2246822519) >>> 0;
  }
  return [first, second, count + 1];
}

function routingBatch(scene, relationships, measure) {
  let measures = scene.batches.get(relationships);
  if (!measures) {
    measures = new Map(); scene.batches.set(relationships, measures);
    if (scene.batches.size > 3) scene.batches.delete(scene.batches.keys().next().value);
  }
  if (measures.has(measure)) return measures.get(measure);
  const edges = spatialIndex(scene.tree), labels = spatialIndex(), geometries = new Map();
  let signature = [2166136261, 2246822519, 0];
  for (const relationship of relationships) {
    if (!scene.boxes[relationship.sourceId] || !scene.boxes[relationship.targetId]) continue;
    const label = labelGeometry(relationship.text, { x: 0, y: 0 }, measure);
    const reservation = reservedLabel(label);
    const controls = routeControls(relationship, scene, reservation, edges, labels, signature.join('.'));
    const geometry = buildGeometry(relationship, scene.boxes, label, controls);
    geometries.set(relationship.id, { relationship, geometry });
    for (const segment of edgeSegments(geometry, relationship.id)) edges.insert(segment);
    const reserved = buildGeometry(relationship, scene.boxes, reservation, controls).label;
    labels.insert({ bounds: expand(reserved, 6) });
    signature = extendSignature(signature, `${relationship.id}:${geometry.path}:${reservation.width},${reservation.height}`);
  }
  const batch = { edges, labels, geometries, prefix: signature.join('.') };
  measures.set(measure, batch);
  return batch;
}

/** Controls stay relative to their endpoints; only automatic curves avoid obstacles. */
export function relationshipGeometry(relationship, boxes, measure = fallbackMeasure, context = {}) {
  const source = boxes[relationship.sourceId], target = boxes[relationship.targetId];
  if (!source || !target || source === target) return null;
  const label = labelGeometry(relationship.text, { x: 0, y: 0 }, measure);
  if (relationship.control1 && relationship.control2) return buildGeometry(relationship, boxes, label, defaultControls(source, target, label));
  const scene = routingScene(boxes, context.nodes, context.rootId);
  let batch = routingBatch(scene, context.relationships ?? noRelationships, measure);
  const found = batch.geometries.get(relationship.id);
  if (found?.relationship === relationship) return found.geometry;
  if (found) {
    const previous = found.relationship;
    const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y;
    if (previous.sourceId === relationship.sourceId && previous.targetId === relationship.targetId && previous.text === relationship.text && samePoint(previous.control1, relationship.control1) && samePoint(previous.control2, relationship.control2)) return found.geometry;
    batch = routingBatch(scene, context.relationships.filter(item => item.id !== relationship.id), measure);
  }
  const controls = routeControls(relationship, scene, reservedLabel(label), batch.edges, batch.labels, batch.prefix);
  return buildGeometry(relationship, boxes, label, controls);
}

export function relationshipBounds(layout, relationships, measure = fallbackMeasure, context = {}) {
  let bounds = { x: 0, y: 0, width: layout.width, height: layout.height };
  for (const relationship of relationships ?? []) {
    const geometry = relationshipGeometry(relationship, layout.boxes, measure, { ...context, relationships });
    if (geometry) bounds = union(bounds, geometry.bounds);
  }
  return bounds;
}
