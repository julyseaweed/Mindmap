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
  const lines = [];
  for (const line of text.split('\n')) {
    let current = '';
    for (const char of line) {
      if (current && measure(current + char) > labelMaxWidth - labelPaddingX * 2) { lines.push(current); current = ''; }
      current += char;
    }
    lines.push(current);
  }
  const width = Math.max(text ? 24 : 96, Math.min(labelMaxWidth, Math.max(...lines.map(measure)) + labelPaddingX * 2));
  const height = Math.max(1, lines.length) * lineHeight + labelPaddingY * 2;
  return { x: point.x - width / 2, y: point.y - height / 2, width, height, lines };
}

/** Controls stay relative to their endpoints when the tree is moved or reflowed. */
export function relationshipGeometry(relationship, boxes, measure = fallbackMeasure) {
  const source = boxes[relationship.sourceId], target = boxes[relationship.targetId];
  if (!source || !target || source === target) return null;
  const sourceCenter = center(source), targetCenter = center(target);
  const labelSize = labelGeometry(relationship.text, { x: 0, y: 0 }, measure);
  const defaults = defaultControls(source, target, labelSize);
  const control1 = relationship.control1 ?? defaults.control1, control2 = relationship.control2 ?? defaults.control2;
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

export function relationshipBounds(layout, relationships, measure = fallbackMeasure) {
  let bounds = { x: 0, y: 0, width: layout.width, height: layout.height };
  for (const relationship of relationships ?? []) {
    const geometry = relationshipGeometry(relationship, layout.boxes, measure);
    if (geometry) bounds = union(bounds, geometry.bounds);
  }
  return bounds;
}
