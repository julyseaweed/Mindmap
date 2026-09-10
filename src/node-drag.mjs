import { descendants, parentOf } from './core.mjs';

const contains = (box, point) => point.x >= box.x && point.x <= box.x + box.width
  && point.y >= box.y && point.y <= box.y + box.height;

const changesOrder = (doc, sourceId, target) => {
  const oldParentId = parentOf(doc, sourceId);
  const newParentId = target.position === 'inside' ? target.id : parentOf(doc, target.id);
  if (!newParentId) return false;
  if (oldParentId !== newParentId) return true;
  const siblings = doc.nodes[oldParentId].children;
  const remaining = siblings.filter(id => id !== sourceId);
  const nextIndex = target.position === 'inside' ? remaining.length
    : remaining.indexOf(target.id) + (target.position === 'after' ? 1 : 0);
  return nextIndex !== siblings.indexOf(sourceId);
};

export function resolveNodeDrop(doc, boxes, sourceId, point) {
  const sourceBox = boxes[sourceId];
  if (sourceId === doc.rootId || !Object.hasOwn(doc.nodes, sourceId) || !sourceBox
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const excluded = new Set(descendants(doc, sourceId));
  const hits = Object.values(boxes).filter(box => Object.hasOwn(doc.nodes, box.id) && contains(box, point));
  // The dragged branch is never a destination, including when it covers a sibling's gap.
  if (hits.some(box => excluded.has(box.id))) return null;
  if (hits.length) {
    const hit = hits[0];
    const portion = (point.y - hit.y) / hit.height;
    const position = hit.id === doc.rootId ? 'inside' : portion < .25 ? 'before' : portion > .75 ? 'after' : 'inside';
    const target = { id: hit.id, position };
    return changesOrder(doc, sourceId, target) ? target : null;
  }

  if (point.x < sourceBox.x - 44 || point.x > sourceBox.x + sourceBox.width + 44) return null;
  const parentId = parentOf(doc, sourceId);
  if (!parentId) return null;
  // Empty-space dragging only reorders siblings; other families in this column keep their parent.
  const siblings = doc.nodes[parentId].children.filter(id => id !== sourceId && boxes[id])
    .map(id => boxes[id]).sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2);
  if (!siblings.length) return null;
  const following = siblings.find(box => point.y < box.y + box.height / 2);
  const target = following ? { id: following.id, position: 'before' }
    : { id: siblings.at(-1).id, position: 'after' };
  return changesOrder(doc, sourceId, target) ? target : null;
}
