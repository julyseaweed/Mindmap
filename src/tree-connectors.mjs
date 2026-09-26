const line = (start, end) => ({ start, c1: start, c2: end, end });
const quadratic = (start, control, end) => ({
  start,
  c1: { x: start.x + (control.x - start.x) * 2 / 3, y: start.y + (control.y - start.y) * 2 / 3 },
  c2: { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 },
  end,
});

// Drawing and relationship avoidance use the same connector geometry.
export function treeConnector(start, end, rootBranch = false) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const move = `M ${start.x} ${start.y}`;
  if (Math.abs(dx) < .001 || Math.abs(dy) < .001) {
    return { path: `${move} L ${end.x} ${end.y}`, curves: [line(start, end)] };
  }
  if (rootBranch) {
    const c1 = { x: start.x + dx * .54, y: start.y };
    const c2 = { x: end.x - dx * .54, y: end.y };
    return { path: `${move} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, curves: [{ start, c1, c2, end }] };
  }
  const x = (start.x + end.x) / 2;
  const radius = Math.min(8, Math.abs(dx) / 2, Math.abs(dy) / 2);
  const rx = Math.sign(dx) * radius, ry = Math.sign(dy) * radius;
  const a = { x: x - rx, y: start.y }, b = { x, y: start.y + ry };
  const c = { x, y: end.y - ry }, d = { x: x + rx, y: end.y };
  const firstCorner = { x, y: start.y }, lastCorner = { x, y: end.y };
  return {
    path: `${move} H ${a.x} Q ${x} ${start.y}, ${b.x} ${b.y} V ${c.y} Q ${x} ${end.y}, ${d.x} ${d.y} H ${end.x}`,
    curves: [line(start, a), quadratic(a, firstCorner, b), line(b, c), quadratic(c, lastCorner, d), line(d, end)],
  };
}
