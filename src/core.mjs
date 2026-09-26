import { wrapText } from './text-wrap.mjs';

export const FORMAT = 'inkmap';
const nodeStyle = {
  fontSize: 14, lineHeight: 23, borderWidth: 1, paddingX: 8, paddingY: 4,
  contentGap: 8, minWidth: 100, rootMinWidth: 152, maxAutoWidth: 260, maxWidth: 1600,
};
// The layout, editor, image handles and print view share these dimensions.
export const NODE_STYLE = Object.freeze({
  ...nodeStyle,
  insetX: 2 * (nodeStyle.paddingX + nodeStyle.borderWidth),
  insetY: 2 * (nodeStyle.paddingY + nodeStyle.borderWidth),
});
const cloneRelationship = relationship => ({
  ...relationship,
  ...(relationship.control1 ? { control1: { ...relationship.control1 } } : {}),
  ...(relationship.control2 ? { control2: { ...relationship.control2 } } : {}),
});
export const clone = value => {
  if (value?.format !== FORMAT || value.version !== 1 || !value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) return structuredClone(value);
  // Document fields are primitives apart from these containers; share immutable image strings.
  return { ...value, nodes: Object.fromEntries(Object.entries(value.nodes).map(([id, node]) => [id, {
    ...node, children: [...node.children], ...(node.images ? { images: node.images.map(image => ({ ...image })) } : {}),
  }])), ...(value.columnWidths ? { columnWidths: { ...value.columnWidths } } : {}),
    ...(value.relationships ? { relationships: value.relationships.map(cloneRelationship) } : {}) };
};
export const uid = () => 'n' + crypto.randomUUID().replaceAll('-', '');

export function createDocument(title = '未命名导图') {
  return { format: FORMAT, version: 1, id: uid(), title, rootId: 'root', nodes: {
    root: { id: 'root', text: '', children: [], collapsed: false },
  } };
}

export function welcomeDocument() {
  const doc = createDocument('从一个想法开始');
  doc.nodes = {
    root: { id: 'root', text: '从一个想法开始', children: ['capture', 'connect', 'keep'], collapsed: false },
    capture: { id: 'capture', text: '记下此刻的想法', children: ['tab', 'enter'], collapsed: false },
    tab: { id: 'tab', text: 'Tab，展开一个子主题', children: [], collapsed: false },
    enter: { id: 'enter', text: 'Enter，接着写下一个', children: [], collapsed: false },
    connect: { id: 'connect', text: '让思路自然生长', children: ['edit', 'drag'], collapsed: false },
    edit: { id: 'edit', text: '双击修改 · Shift + Enter 换行', children: [], collapsed: false },
    drag: { id: 'drag', text: '拖动节点，重新组织想法', children: [], collapsed: false },
    keep: { id: 'keep', text: '留在本地，带走灵感', children: ['export'], collapsed: false },
    export: { id: 'export', text: '一键复制到 Obsidian', children: [], collapsed: false },
  };
  return doc;
}

export function validateDocument(value) {
  const fail = () => { throw new Error('这不是有效的导图文件，或文件内容已损坏。'); };
  if (!value || value.format !== FORMAT || value.version !== 1 || typeof value.id !== 'string' || !/^[a-zA-Z][\w-]{0,79}$/.test(value.id)) fail();
  if (typeof value.title !== 'string' || value.title.length > 200 || !value.nodes || Array.isArray(value.nodes)) fail();
  const entries = Object.entries(value.nodes);
  if (!entries.length || entries.length > 2000 || !Object.hasOwn(value.nodes, value.rootId)) fail();
  const nodes = {};
  let imageCount = 0, imageBytes = 0;
  const imageIds = new Set();
  const imageTypes = new Map([['data:image/png;base64', 'png'], ['data:image/jpeg;base64', 'jpeg'], ['data:image/webp;base64', 'webp']]);
  const validateImage = image => {
    if (!image || typeof image.id !== 'string' || !/^[a-zA-Z][\w-]{0,79}$/.test(image.id) || imageIds.has(image.id) || typeof image.dataUrl !== 'string' || image.dataUrl.length > 12 * 1024 * 1024) fail();
    if (!Number.isFinite(image.width) || image.width <= 0 || image.width > 1200 || !Number.isFinite(image.height) || image.height <= 0 || image.height > 12000 || !Number.isInteger(image.naturalWidth) || !Number.isInteger(image.naturalHeight) || image.naturalWidth < 1 || image.naturalHeight < 1 || image.naturalWidth > 16384 || image.naturalHeight > 16384) fail();
    imageIds.add(image.id);
    if (++imageCount > 256 || (imageBytes += image.dataUrl.length) > 48 * 1024 * 1024) fail();
    const comma = image.dataUrl.indexOf(',');
    const type = imageTypes.get(image.dataUrl.slice(0, comma));
    const data = image.dataUrl.slice(comma + 1);
    if (!type || !data.length || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) fail();
    const padding = data.indexOf('=');
    if (padding !== -1 && (padding < data.length - 2 || !/^={1,2}$/.test(data.slice(padding)))) fail();
    let signature;
    try { signature = atob(data.slice(0, Math.min(32, data.length))); } catch { fail(); }
    if (type === 'png' ? !signature.startsWith('\x89PNG\r\n\x1a\n') : type === 'jpeg' ? !signature.startsWith('\xff\xd8\xff') : !signature.startsWith('RIFF') || signature.slice(8, 12) !== 'WEBP') fail();
    return { id: image.id, dataUrl: image.dataUrl, width: image.width, height: image.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
  };
  for (const [id, node] of entries) {
    if (!/^[a-zA-Z][\w-]{0,79}$/.test(id) || ['constructor', 'prototype'].includes(id) || !node || node.id !== id || typeof node.text !== 'string' || node.text.length > 8000 || !Array.isArray(node.children) || node.children.some(child => typeof child !== 'string' || !Object.hasOwn(value.nodes, child))) fail();
    nodes[id] = { id, text: node.text, children: [...node.children], collapsed: !!node.collapsed };
    if (Object.hasOwn(node, 'images')) {
      if (!Array.isArray(node.images) || node.images.length > 32) fail();
      nodes[id].images = node.images.map(validateImage);
    }
  }
  const seen = new Set();
  const queue = [[value.rootId, 0]];
  while (queue.length) {
    const [id, depth] = queue.pop();
    if (seen.has(id) || depth > 128) fail();
    seen.add(id);
    for (const child of nodes[id].children) queue.push([child, depth + 1]);
  }
  if (seen.size !== entries.length) fail();
  const validated = { format: FORMAT, version: 1, id: value.id, title: value.title.trim() || '未命名导图', rootId: value.rootId, nodes };
  if (Object.hasOwn(value, 'columnWidths')) {
    if (!value.columnWidths || typeof value.columnWidths !== 'object' || Array.isArray(value.columnWidths)) fail();
    const columnWidths = {};
    for (const [depth, width] of Object.entries(value.columnWidths)) {
      if (!/^(0|[1-9]\d{0,2})$/.test(depth) || Number(depth) > 128 || !Number.isFinite(width) || width < NODE_STYLE.minWidth || width > NODE_STYLE.maxWidth) fail();
      columnWidths[depth] = width;
    }
    validated.columnWidths = columnWidths;
  }
  if (Object.hasOwn(value, 'relationships')) {
    if (!Array.isArray(value.relationships) || value.relationships.length > 2000) fail();
    const relationshipIds = new Set(), pairs = new Set();
    validated.relationships = value.relationships.map(relationship => {
      if (!relationship || typeof relationship.id !== 'string' || !/^[a-zA-Z][\w-]{0,79}$/.test(relationship.id) || ['constructor', 'prototype'].includes(relationship.id) || relationshipIds.has(relationship.id)) fail();
      if (typeof relationship.sourceId !== 'string' || typeof relationship.targetId !== 'string' || relationship.sourceId === relationship.targetId || !Object.hasOwn(nodes, relationship.sourceId) || !Object.hasOwn(nodes, relationship.targetId)) fail();
      if (typeof relationship.text !== 'string' || relationship.text.length > 8000) fail();
      const pair = `${relationship.sourceId}:${relationship.targetId}`;
      if (pairs.has(pair)) fail();
      relationshipIds.add(relationship.id);
      pairs.add(pair);
      const result = { id: relationship.id, sourceId: relationship.sourceId, targetId: relationship.targetId, text: relationship.text };
      for (const key of ['control1', 'control2']) {
        if (!Object.hasOwn(relationship, key)) continue;
        const point = relationship[key];
        if (!point || typeof point !== 'object' || Array.isArray(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000) fail();
        result[key] = { x: point.x, y: point.y };
      }
      return result;
    });
  }
  return validated;
}

export function parentOf(doc, id) {
  return Object.values(doc.nodes).find(node => node.children.includes(id))?.id ?? null;
}

export function descendants(doc, id) {
  const all = [];
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    all.push(current);
    stack.push(...doc.nodes[current].children);
  }
  return all;
}

const branchDepths = (doc, rootId = doc.rootId) => {
  const depths = new Map();
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop();
    depths.set(id, depth);
    for (const child of doc.nodes[id].children) stack.push([child, depth + 1]);
  }
  return depths;
};

export function copyBranch(doc, id) {
  const source = validateDocument(doc);
  if (!Object.hasOwn(source.nodes, id)) throw new Error('请选择要复制的节点。');
  const sourceDepth = branchDepths(source).get(id);
  const depths = branchDepths(source, id);
  const branch = {
    format: FORMAT, version: 1, id: uid(),
    title: source.nodes[id].text.replace(/\s+/g, ' ').trim().slice(0, 200) || '未命名导图',
    rootId: id,
    nodes: Object.fromEntries([...depths.keys()].map(nodeId => [nodeId, source.nodes[nodeId]])),
  };
  if (source.relationships) branch.relationships = source.relationships.filter(relationship => depths.has(relationship.sourceId) && depths.has(relationship.targetId));
  if (source.columnWidths) {
    const maxDepth = Math.max(...depths.values());
    const widths = Object.entries(source.columnWidths)
      .filter(([depth]) => Number(depth) >= sourceDepth && Number(depth) <= sourceDepth + maxDepth)
      .map(([depth, width]) => [Number(depth) - sourceDepth, width]);
    if (widths.length) branch.columnWidths = Object.fromEntries(widths);
  }
  return validateDocument(branch);
}

export function pasteBranch(doc, targetId, branch) {
  let next, source;
  try { next = validateDocument(doc); }
  catch { throw new Error('无法粘贴：当前导图内容无效或已超过容量上限。'); }
  try { source = validateDocument(branch); }
  catch { throw new Error('无法粘贴：复制的节点内容无效或已超过容量上限。'); }
  if (!Object.hasOwn(next.nodes, targetId)) throw new Error('请选择要粘贴到的节点。');
  const capacityError = () => new Error('无法粘贴：已超过导图的节点、层级、图片或联系容量上限。');
  const targetDepth = branchDepths(next).get(targetId) + 1;
  const sourceDepths = branchDepths(source);
  const maxSourceDepth = Math.max(...sourceDepths.values());
  if (Object.keys(next.nodes).length + sourceDepths.size > 2000 || targetDepth + maxSourceDepth > 128) throw capacityError();

  // Exclude original IDs too, so copying into another document always creates a new identity.
  const usedIds = new Set();
  for (const document of [next, source]) {
    for (const relationship of document.relationships ?? []) usedIds.add(relationship.id);
    for (const node of Object.values(document.nodes)) {
      usedIds.add(node.id);
      for (const image of node.images ?? []) usedIds.add(image.id);
    }
  }
  const freshId = () => {
    let id;
    do { id = uid(); } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  const ids = new Map([...sourceDepths.keys()].map(id => [id, freshId()]));
  for (const node of Object.values(source.nodes)) {
    const id = ids.get(node.id);
    next.nodes[id] = {
      ...node, id, children: node.children.map(child => ids.get(child)),
      ...(node.images ? { images: node.images.map(image => ({ ...image, id: freshId() })) } : {}),
    };
  }
  const selectedId = ids.get(source.rootId);
  next.nodes[targetId].children.push(selectedId);
  next.nodes[targetId].collapsed = false;
  if (source.relationships?.length) {
    next.relationships ??= [];
    next.relationships.push(...source.relationships.map(relationship => ({
      ...cloneRelationship(relationship), id: freshId(), sourceId: ids.get(relationship.sourceId), targetId: ids.get(relationship.targetId),
    })));
  }
  for (const [depth, width] of Object.entries(source.columnWidths ?? {})) {
    if (Number(depth) > maxSourceDepth) continue;
    const destinationDepth = targetDepth + Number(depth);
    if (!Object.hasOwn(next.columnWidths ?? {}, destinationDepth)) {
      next.columnWidths ??= {};
      next.columnWidths[destinationDepth] = width;
    }
  }
  try { return { doc: validateDocument(next), selectedId }; }
  catch { throw capacityError(); }
}

export function addNode(doc, selectedId, kind = 'child', text = '') {
  const next = clone(doc);
  const parentId = kind === 'sibling' ? parentOf(doc, selectedId) ?? selectedId : selectedId;
  const parent = next.nodes[parentId];
  const id = uid();
  next.nodes[id] = { id, text, children: [], collapsed: false };
  const index = kind === 'sibling' && parentId !== selectedId ? parent.children.indexOf(selectedId) + 1 : parent.children.length;
  parent.children.splice(index, 0, id);
  parent.collapsed = false;
  return { doc: validateDocument(next), selectedId: id };
}

export function addRelationship(doc, sourceId, targetId) {
  if (sourceId === targetId || !Object.hasOwn(doc.nodes, sourceId) || !Object.hasOwn(doc.nodes, targetId)) throw new Error('请选择两个不同的节点建立联系。');
  const existing = doc.relationships?.find(relationship => relationship.sourceId === sourceId && relationship.targetId === targetId);
  if (existing) return { doc, relationshipId: existing.id };
  if ((doc.relationships?.length ?? 0) >= 2000) throw new Error('已达到导图的联系数量上限。');
  const next = clone(doc);
  const usedIds = new Set([...Object.keys(next.nodes), ...(next.relationships ?? []).map(relationship => relationship.id)]);
  let id;
  do { id = uid(); } while (usedIds.has(id));
  next.relationships ??= [];
  next.relationships.push({ id, sourceId, targetId, text: '' });
  return { doc: next, relationshipId: id };
}

export function deleteRelationship(doc, id) {
  if (!doc.relationships?.some(relationship => relationship.id === id)) return doc;
  const next = clone(doc);
  next.relationships = next.relationships.filter(relationship => relationship.id !== id);
  return next;
}

const pruneRelationships = doc => {
  if (doc.relationships) doc.relationships = doc.relationships.filter(relationship => Object.hasOwn(doc.nodes, relationship.sourceId) && Object.hasOwn(doc.nodes, relationship.targetId));
};

export function deleteNode(doc, id) {
  const parentId = parentOf(doc, id);
  if (!parentId) return { doc, selectedId: id };
  const next = clone(doc);
  const index = next.nodes[parentId].children.indexOf(id);
  next.nodes[parentId].children.splice(index, 1);
  for (const child of descendants(next, id)) delete next.nodes[child];
  pruneRelationships(next);
  return { doc: next, selectedId: next.nodes[parentId].children[Math.max(0, index - 1)] ?? parentId };
}

export function deleteNodeOnly(doc, id) {
  const parentId = parentOf(doc, id);
  if (!parentId) return { doc, selectedId: id };
  const next = clone(doc);
  const children = next.nodes[id].children;
  const siblings = next.nodes[parentId].children;
  const index = siblings.indexOf(id);
  siblings.splice(index, 1, ...children);
  delete next.nodes[id];
  pruneRelationships(next);
  return { doc: next, selectedId: children[0] ?? siblings[Math.max(0, index - 1)] ?? parentId };
}

export function moveNode(doc, id, targetId, position = 'inside') {
  if (id === doc.rootId || !doc.nodes[targetId] || descendants(doc, id).includes(targetId)) return doc;
  const newParent = position === 'inside' ? targetId : parentOf(doc, targetId);
  if (!newParent) return doc;
  const next = clone(doc);
  const oldParent = parentOf(next, id);
  next.nodes[oldParent].children = next.nodes[oldParent].children.filter(child => child !== id);
  const parent = next.nodes[newParent];
  const index = position === 'inside' ? parent.children.length : parent.children.indexOf(targetId) + (position === 'after' ? 1 : 0);
  parent.children.splice(index, 0, id);
  parent.collapsed = false;
  return validateDocument(next);
}

export function reorderNode(doc, id, direction) {
  const parentId = parentOf(doc, id);
  if (!parentId) return doc;
  const siblings = doc.nodes[parentId].children;
  const index = siblings.indexOf(id);
  const target = siblings[index + direction];
  return target ? moveNode(doc, id, target, direction < 0 ? 'before' : 'after') : doc;
}

export function visibleNodes(doc) {
  const nodes = [];
  const visit = (id, depth) => {
    nodes.push({ ...doc.nodes[id], depth });
    if (!doc.nodes[id].collapsed) doc.nodes[id].children.forEach(child => visit(child, depth + 1));
  };
  visit(doc.rootId, 0);
  return nodes;
}

const escapes = { '&': '#38;', '#': '#35;', '"': '#34;', '<': '#60;', '>': '#62;', '`': '#96;', '\\': '#92;' };
export const escapeMermaid = (text) => text.replace(/[&#"<>`\\]/g, char => escapes[char]).replace(/\r\n?|\n/g, '<br/>');

export function toMermaid(doc, fenced = true) {
  const order = [];
  const visit = id => { order.push(id); doc.nodes[id].children.forEach(visit); };
  visit(doc.rootId);
  const ids = new Map(order.map((id, index) => [id, 'N' + index]));
  const treeEdges = order.flatMap(id => doc.nodes[id].children.map(child => ({ parent: id, line: `    ${ids.get(id)} --> ${ids.get(child)}` })));
  const branchEdges = treeEdges.flatMap((edge, index) => edge.parent === doc.rootId ? [] : [index]);
  const lines = [
    '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#ffffff","primaryTextColor":"#111111","primaryBorderColor":"#111111","lineColor":"#111111"},"flowchart":{"curve":"basis","nodeSpacing":26,"rankSpacing":80,"htmlLabels":true}}}%%',
    'flowchart LR',
    ...order.map(id => `    ${ids.get(id)}["${escapeMermaid(doc.nodes[id].text || ' ')}"]`),
    '',
    ...treeEdges.map(edge => edge.line),
    ...(doc.relationships ?? []).map(relationship => `    ${ids.get(relationship.sourceId)} -.->${relationship.text ? `|"${escapeMermaid(relationship.text).replaceAll('|', '#124;')}"|` : ''} ${ids.get(relationship.targetId)}`),
    '',
    '    classDef default fill:#ffffff,stroke:#111111,stroke-width:1px,color:#111111',
    '    linkStyle default stroke:#111111,stroke-width:1px',
    ...(branchEdges.length ? [`    linkStyle ${branchEdges.join(',')} interpolate step`] : []),
  ];
  const result = lines.join('\n');
  return fenced ? '```mermaid\n' + result + '\n```\n' : result;
}

export function layoutTree(doc, measure = text => [...text].reduce((width, char) => width + (/[^\u0000-\u00ff]/.test(char) ? 14 : 7.5), 0)) {
  const boxes = {};
  const maxWidth = [];
  // First determine the final width of each visible depth, including image constraints.
  for (const node of visibleNodes(doc)) {
    const minimum = node.id === doc.rootId ? NODE_STYLE.rootMinWidth : NODE_STYLE.minWidth;
    // Size columns from unwrapped text, not shorter wrapped lines that would wrap again.
    const textWidth = Math.min(NODE_STYLE.maxAutoWidth, Math.max(...node.text.split('\n').map(measure)) + NODE_STYLE.insetX);
    const requested = doc.columnWidths?.[String(node.depth)];
    const imageWidth = Math.max(0, ...(node.images ?? []).map(image => image.width + NODE_STYLE.insetX));
    maxWidth[node.depth] = Math.max(maxWidth[node.depth] || 0, minimum, requested ?? textWidth, imageWidth);
  }
  const size = (id, depth) => {
    const node = doc.nodes[id];
    const width = maxWidth[depth];
    const images = (node.images ?? []).map(image => ({ id: image.id, width: image.width, height: image.height }));
    const lines = !node.text && images.length ? [] : wrapText(node.text, width - NODE_STYLE.insetX, measure);
    const textHeight = lines.length * NODE_STYLE.lineHeight;
    const imageHeight = images.reduce((height, image) => height + image.height, 0) + Math.max(0, images.length - 1) * NODE_STYLE.contentGap;
    const height = Math.max(NODE_STYLE.lineHeight, textHeight + imageHeight + (textHeight && images.length ? NODE_STYLE.contentGap : 0)) + NODE_STYLE.insetY;
    const children = node.collapsed ? [] : node.children;
    const childHeights = children.map(child => size(child, depth + 1));
    const span = Math.max(height, childHeights.reduce((a, b) => a + b, 0) + Math.max(0, children.length - 1) * 28);
    boxes[id] = { id, depth, width, height, textHeight, lines, ...(images.length ? { images } : {}), span, x: 0, y: 0 };
    return span;
  };
  size(doc.rootId, 0);
  const columns = [0];
  for (let i = 1; i < maxWidth.length; i++) columns[i] = columns[i - 1] + maxWidth[i - 1] + (i === 1 ? 88 : 64);
  const place = (id, top) => {
    const box = boxes[id];
    box.x = columns[box.depth];
    box.y = top + (box.span - box.height) / 2;
    if (!doc.nodes[id].collapsed) {
      let y = top;
      const children = doc.nodes[id].children;
      const span = children.reduce((sum, child) => sum + boxes[child].span, 0) + Math.max(0, children.length - 1) * 28;
      y += (box.span - span) / 2;
      for (const child of children) { place(child, y); y += boxes[child].span + 28; }
    }
  };
  place(doc.rootId, 0);
  return { boxes, width: columns.at(-1) + maxWidth.at(-1), height: boxes[doc.rootId].span };
}
