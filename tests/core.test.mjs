import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, createDocument, welcomeDocument, addNode, deleteNode, deleteNodeOnly, moveNode, parentOf, visibleNodes, toMermaid, layoutTree, validateDocument, descendants, reorderNode, copyBranch, pasteBranch, getTextSegments, updateTextSegment, insertNodeImages, removeNodeImage } from '../src/core.mjs';

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
const nodeImage = (id = 'image1', overrides = {}) => ({ id, dataUrl: pngDataUrl, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200, ...overrides });
const largePngUrl = size => 'data:image/png;base64,' + 'iVBORw0KGgoA' + 'A'.repeat(Math.floor((size - 'data:image/png;base64,'.length) / 4) * 4 - 12);

test('continuous child/sibling creation maintains order and expands collapsed parents', () => {
  let doc = createDocument();
  const first = addNode(doc, 'root');
  const second = addNode(first.doc, first.selectedId, 'sibling');
  assert.deepEqual(second.doc.nodes.root.children, [first.selectedId, second.selectedId]);
  second.doc.nodes.root.collapsed = true;
  const third = addNode(second.doc, 'root');
  assert.equal(third.doc.nodes.root.collapsed, false);
  assert.equal(doc.nodes.root.children.length, 0);
});

test('reparenting and ordering preserve descendants and reject cycles', () => {
  const doc = welcomeDocument();
  const moved = moveNode(doc, 'capture', 'keep');
  assert.equal(parentOf(moved, 'capture'), 'keep');
  assert.deepEqual(descendants(moved, 'capture'), ['capture', 'enter', 'tab']);
  assert.equal(moveNode(doc, 'capture', 'tab'), doc);
  assert.equal(moveNode(doc, 'root', 'tab'), doc);
  assert.deepEqual(reorderNode(doc, 'connect', -1).nodes.root.children, ['connect', 'capture', 'keep']);
  const before = moveNode(doc, 'keep', 'capture', 'before');
  assert.deepEqual(before.nodes.root.children, ['keep', 'capture', 'connect']);
  assert.equal(validateDocument(moved).nodes.tab.text, doc.nodes.tab.text);
});

test('deletion removes whole subtrees and selects a surviving sibling', () => {
  const doc = welcomeDocument();
  const result = deleteNode(doc, 'connect');
  assert.equal(Object.keys(result.doc.nodes).length, 6);
  assert.equal(result.selectedId, 'capture');
  assert.equal(result.doc.nodes.edit, undefined);
  assert.equal(deleteNode(doc, 'root').doc, doc);
});

test('deleting only a node promotes its children in place and preserves folded descendants and images', () => {
  const doc = welcomeDocument();
  doc.nodes.connect.collapsed = true;
  doc.nodes.connect.images = [nodeImage('removed')];
  doc.nodes.edit.images = [nodeImage('retained')];
  doc.nodes.edit.collapsed = true;
  doc.nodes.edit.children = ['nested'];
  doc.nodes.nested = { id: 'nested', text: '保留的后代', children: [], collapsed: false };
  doc.columnWidths = { 1: 300, 2: 240 };
  const before = structuredClone(doc);
  const { doc: next, selectedId } = deleteNodeOnly(doc, 'connect');
  assert.deepEqual(next.nodes.root.children, ['capture', 'edit', 'drag', 'keep']);
  assert.equal(selectedId, 'edit');
  assert.equal(next.nodes.connect, undefined);
  assert.equal(Object.keys(next.nodes).length, Object.keys(doc.nodes).length - 1);
  for (const id of ['edit', 'drag', 'nested']) assert.deepEqual(next.nodes[id], before.nodes[id]);
  assert.deepEqual(next.columnWidths, before.columnWidths);
  assert.deepEqual(validateDocument(next), next);
  assert.deepEqual(doc, before);
  const mermaid = toMermaid(next);
  assert.ok(mermaid.includes('保留的后代'));
  assert.ok(!mermaid.includes(before.nodes.connect.text));
});

test('deleting only a leaf selects a surviving node and cannot delete the root', () => {
  const doc = welcomeDocument();
  assert.deepEqual(deleteNodeOnly(doc, 'root'), { doc, selectedId: 'root' });
  assert.deepEqual(deleteNodeOnly(doc, 'export'), deleteNode(doc, 'export'));
  assert.equal(deleteNodeOnly(doc, 'enter').selectedId, 'tab');
  assert.equal(deleteNodeOnly(doc, 'tab').selectedId, 'enter');
});

test('folded branches remain in the Mermaid export with safely escaped text', () => {
  const doc = welcomeDocument();
  doc.nodes.capture.collapsed = true;
  doc.nodes.tab.text = '中文 "quotes" & #hash <script> `tick` \\ path\n第二行';
  assert.ok(!visibleNodes(doc).some(node => node.id === 'tab'));
  const output = toMermaid(doc);
  assert.ok(output.startsWith('```mermaid\n'));
  assert.ok(output.includes('flowchart LR'));
  assert.ok(output.includes('#34;quotes#34;'));
  assert.ok(output.includes('#60;script#62;'));
  assert.ok(output.includes('#35;hash'));
  assert.ok(output.includes('<br/>第二行'));
  assert.equal((output.match(/ --> /g) || []).length, Object.keys(doc.nodes).length - 1);
});

test('layout prevents overlaps within every column and wraps CJK/multiline text', () => {
  let doc = welcomeDocument();
  doc.nodes.tab.text = '非常长的中文内容'.repeat(12) + '\n第二行';
  for (let i = 0; i < 60; i++) doc = addNode(doc, i % 2 ? 'keep' : 'connect').doc;
  const layout = layoutTree(doc);
  const boxes = Object.values(layout.boxes);
  for (const box of boxes) {
    const parent = parentOf(doc, box.id);
    if (parent) assert.ok(box.x > layout.boxes[parent].x + layout.boxes[parent].width);
    for (const other of boxes) {
      if (box.id !== other.id && box.depth === other.depth) {
        assert.equal(box.x, other.x);
        assert.equal(box.width, other.width);
        assert.ok(box.y + box.height <= other.y || other.y + other.height <= box.y);
      }
    }
  }
  assert.ok(layout.boxes.tab.lines.length > 2);
  assert.ok(layout.boxes.tab.width <= 260);
});

test('invalid graphs, duplicate parents, unreachable nodes and excessive depth are rejected', () => {
  const doc = welcomeDocument();
  doc.nodes.tab.children.push('root');
  assert.throws(() => validateDocument(doc));
  const duplicate = welcomeDocument(); duplicate.nodes.keep.children.push('tab');
  assert.throws(() => validateDocument(duplicate));
  const dangling = welcomeDocument(); dangling.nodes.root.children.pop();
  assert.throws(() => validateDocument(dangling));
  const malformed = welcomeDocument(); malformed.nodes.root.text = '<script>hello</script>';
  assert.equal(validateDocument(malformed).nodes.root.text, '<script>hello</script>');
  assert.throws(() => validateDocument({}));
});

test('node layout keeps English words whole without changing explicit column widths or document text', () => {
  const doc = createDocument();
  doc.nodes.root.text = 'one simple word\n中文English中文';
  doc.columnWidths = { 0: 152 };
  const before = structuredClone(doc);
  const layout = layoutTree(doc, text => [...text].length * 14);
  assert.equal(layout.boxes.root.width, 152);
  assert.deepEqual(layout.boxes.root.lines.map(line => line.trimEnd()), ['one simple', 'word', '中文English中', '文']);
  assert.equal(layout.boxes.root.height, 4 * 21 + 6);
  assert.deepEqual(doc, before);
});

test('automatic columns retain the width cap when word boundaries leave shorter lines', () => {
  const doc = createDocument();
  doc.nodes.root.text = 'abcdefghijklmnop qrstuvwxyzabcdef';
  const layout = layoutTree(doc, text => [...text].length * 10);
  assert.equal(layout.boxes.root.width, 260);
  assert.deepEqual(layout.boxes.root.lines.map(line => line.trimEnd()), ['abcdefghijklmnop', 'qrstuvwxyzabcdef']);
});

test('legacy validation keeps its old shape while new image and column fields round-trip without aliases', () => {
  const legacy = createDocument();
  assert.deepEqual(validateDocument(legacy), legacy);
  assert.ok(!Object.hasOwn(validateDocument(legacy), 'columnWidths'));
  assert.ok(!Object.hasOwn(validateDocument(legacy).nodes.root, 'images'));
  const doc = welcomeDocument();
  doc.columnWidths = { 0: 300, 1: 440, 128: 112 };
  doc.nodes.capture.images = [nodeImage('captureImage')];
  doc.nodes.tab.images = [];
  const validated = validateDocument(doc);
  assert.deepEqual(validated, doc);
  validated.nodes.capture.images[0].width = 220;
  validated.columnWidths[1] = 500;
  assert.equal(doc.nodes.capture.images[0].width, 200);
  assert.equal(doc.columnWidths[1], 440);
  const copied = clone(doc);
  copied.nodes.capture.images[0].height = 50;
  copied.nodes.capture.children.pop();
  copied.columnWidths[1] = 200;
  assert.equal(doc.nodes.capture.images[0].height, 100);
  assert.deepEqual(doc.nodes.capture.children, ['tab', 'enter']);
  assert.equal(doc.columnWidths[1], 440);
  const added = addNode(doc, 'capture');
  const moved = moveNode(added.doc, 'capture', 'keep');
  assert.deepEqual(moved.nodes.capture.images, doc.nodes.capture.images);
  assert.deepEqual(moved.columnWidths, doc.columnWidths);
  const removed = deleteNode(moved, added.selectedId).doc;
  assert.deepEqual(removed.nodes.capture.images, doc.nodes.capture.images);
  assert.deepEqual(removed.columnWidths, doc.columnWidths);
});

test('supported image encodings and panoramic display dimensions are accepted, unsafe data is rejected', () => {
  const doc = createDocument();
  doc.nodes.root.images = [
    nodeImage('png'),
    nodeImage('jpeg', { dataUrl: 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64'), width: 0.5, height: 0.25 }),
    nodeImage('webp', { dataUrl: 'data:image/webp;base64,' + Buffer.from('RIFF0000WEBP').toString('base64'), width: 1200, height: 12000, naturalWidth: 16384, naturalHeight: 1 }),
  ];
  assert.deepEqual(validateDocument(doc), doc);
  const invalid = [
    { dataUrl: 'javascript:alert(1)' },
    { dataUrl: 'https://example.com/image.png' },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { dataUrl: 'data:image/png;base64,PGh0bWw+PC9odG1sPg==' },
    { dataUrl: 'data:image/png;base64,iVBORw0KGgoA<bad>' },
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=A===' },
    { dataUrl: 'data:image/png;base64,' },
    { width: 0 }, { width: -1 }, { width: 1201 }, { width: NaN }, { width: '200' },
    { height: 0 }, { height: Infinity }, { height: 12000.1 },
    { naturalWidth: 0 }, { naturalWidth: 16385 }, { naturalHeight: 1.2 },
    { id: 'bad" id' },
  ];
  for (const overrides of invalid) {
    const broken = createDocument();
    broken.nodes.root.images = [nodeImage('invalid', overrides)];
    assert.throws(() => validateDocument(broken), undefined, JSON.stringify(overrides));
  }
  const duplicate = welcomeDocument();
  duplicate.nodes.capture.images = [nodeImage('same')];
  duplicate.nodes.keep.images = [nodeImage('same')];
  assert.throws(() => validateDocument(duplicate));
});

test('legacy pictures keep their placement until a text block is edited', () => {
  const doc = createDocument();
  doc.nodes.root.text = '上方文字';
  doc.nodes.root.images = [nodeImage('one'), nodeImage('two')];
  const before = structuredClone(doc);
  assert.deepEqual(getTextSegments(doc.nodes.root), ['上方文字', '', '']);
  assert.deepEqual(validateDocument(doc), before);
  const updated = updateTextSegment(doc.nodes.root, 1, '两图之间');
  assert.deepEqual(updated.textSegments, ['上方文字', '两图之间', '']);
  assert.equal(updated.text, '上方文字\n两图之间');
  assert.deepEqual(doc, before);
});

test('pictures insert at the selected text range and support independent blocks on both sides', () => {
  const doc = createDocument();
  doc.nodes.root.text = 'Before SELECT After';
  let node = insertNodeImages(doc.nodes.root, [nodeImage('one')], { segment: 0, start: 7, end: 13 });
  assert.deepEqual(node.textSegments, ['Before ', ' After']);
  assert.equal(node.text, 'Before \n After');
  node = updateTextSegment(node, 1, 'Caption');
  node = insertNodeImages(node, [nodeImage('two'), nodeImage('three')], { segment: 1, start: 0, end: 0 });
  assert.deepEqual(node.images.map(image => image.id), ['one', 'two', 'three']);
  assert.deepEqual(node.textSegments, ['Before ', '', '', 'Caption']);
  node = updateTextSegment(node, 2, 'Middle');
  assert.deepEqual(node.textSegments, ['Before ', '', 'Middle', 'Caption']);
  assert.equal(node.text, 'Before \nMiddle\nCaption');
  const appended = insertNodeImages(node, [nodeImage('four')]);
  assert.deepEqual(appended.textSegments, ['Before ', '', 'Middle', 'Caption', '']);
  assert.deepEqual(appended.images.map(image => image.id), ['one', 'two', 'three', 'four']);
  assert.equal(doc.nodes.root.text, 'Before SELECT After');
});

test('removing pictures preserves every text block and existing newlines', () => {
  const original = { ...createDocument().nodes.root, text: 'Top\n\nMiddle\nBottom', images: [nodeImage('one'), nodeImage('two')], textSegments: ['Top\n', '\nMiddle', 'Bottom'] };
  const first = removeNodeImage(original, 'one');
  assert.deepEqual(first.textSegments, ['Top\n\nMiddle', 'Bottom']);
  assert.deepEqual(first.images.map(image => image.id), ['two']);
  assert.equal(first.text, original.text);
  const final = removeNodeImage(first, 'two');
  assert.equal(final.text, original.text);
  assert.equal(final.images, undefined);
  assert.equal(final.textSegments, undefined);
  assert.strictEqual(removeNodeImage(original, 'missing'), original);
});

test('mixed content validation, cloning and branch clipboard preserve order without array aliases', () => {
  const doc = createDocument();
  doc.nodes.root = insertNodeImages({ ...doc.nodes.root, text: '上下' }, [nodeImage('one')], { segment: 0, start: 1, end: 1 });
  const before = structuredClone(doc);
  const validated = validateDocument(doc), copied = clone(doc);
  assert.deepEqual(validated, before);
  validated.nodes.root.textSegments[0] = 'changed';
  copied.nodes.root.textSegments[1] = 'changed';
  assert.deepEqual(doc, before);
  const branch = copyBranch(doc, 'root');
  const target = createDocument();
  const inserted = pasteBranch(target, 'root', branch);
  const pasted = inserted.doc.nodes[inserted.selectedId];
  assert.deepEqual(pasted.textSegments, ['上', '下']);
  assert.equal(pasted.text, '上\n下');
  assert.notEqual(pasted.images[0].id, doc.nodes.root.images[0].id);
  pasted.textSegments[0] = 'other';
  assert.deepEqual(branch.nodes.root.textSegments, ['上', '下']);
  assert.deepEqual(doc, before);
  assert.ok(toMermaid(doc).includes('上<br/>下'));
});

test('malformed mixed content and text exceeding the projected limit are rejected', () => {
  const doc = createDocument();
  doc.nodes.root = insertNodeImages({ ...doc.nodes.root, text: 'AB' }, [nodeImage('one')], { segment: 0, start: 1, end: 1 });
  for (const textSegments of [null, 'A\nB', [], ['A'], ['A', 'B', ''], ['A', 2], ['different', 'B'], ['A'.repeat(8001), 'B']]) {
    assert.throws(() => validateDocument({ ...doc, nodes: { root: { ...doc.nodes.root, textSegments } } }));
  }
  assert.throws(() => updateTextSegment(doc.nodes.root, 1, 'B'.repeat(8000)));
  assert.throws(() => updateTextSegment(doc.nodes.root, 2, 'extra'));
  assert.throws(() => insertNodeImages(doc.nodes.root, [nodeImage('two')], { segment: 0, start: 2, end: 2 }));
  const full = { ...createDocument().nodes.root, text: 'A'.repeat(8000) };
  assert.throws(() => insertNodeImages(full, [nodeImage('two')], { segment: 0, start: 4000, end: 4000 }));
});

test('mixed content layout wraps blocks separately and reserves only the active empty block', () => {
  const doc = createDocument();
  doc.nodes.root = insertNodeImages({ ...doc.nodes.root, text: 'AboveBelow' }, [nodeImage('one', { width: 120, height: 60 })], { segment: 0, start: 5, end: 5 });
  doc.nodes.root = insertNodeImages(doc.nodes.root, [nodeImage('two', { width: 80, height: 40 })]);
  const before = structuredClone(doc);
  const box = layoutTree(doc).boxes.root;
  assert.deepEqual(box.content.map(block => block.kind), ['text', 'image', 'text', 'image', 'text']);
  assert.deepEqual(box.content.filter(block => block.kind === 'text').map(block => block.lines), [['Above'], ['Below'], []]);
  assert.equal(box.textHeight, 42);
  assert.equal(box.height, 42 + 60 + 40 + 3 * 8 + 6);
  const editing = layoutTree(doc, undefined, { nodeId: 'root', segment: 2 }).boxes.root;
  assert.equal(editing.content[4].height, 21);
  assert.equal(editing.height, box.height + 21 + 8);
  assert.equal(layoutTree(doc, undefined, { nodeId: 'other', segment: 2 }).boxes.root.height, box.height);
  assert.deepEqual(doc, before);
});

test('image counts and serialized image byte budgets are enforced across all nodes', () => {
  const tooManyOnNode = createDocument();
  tooManyOnNode.nodes.root.images = Array.from({ length: 33 }, (_, index) => nodeImage('image' + index));
  assert.throws(() => validateDocument(tooManyOnNode));
  const full = createDocument();
  for (let group = 0; group < 8; group++) {
    const id = 'node' + group;
    full.nodes.root.children.push(id);
    full.nodes[id] = { id, text: '', collapsed: false, children: [], images: Array.from({ length: 32 }, (_, index) => nodeImage('image' + (group * 32 + index))) };
  }
  assert.equal(Object.values(validateDocument(full).nodes).reduce((count, node) => count + (node.images?.length ?? 0), 0), 256);
  full.nodes.root.images = [nodeImage('overflow')];
  assert.throws(() => validateDocument(full));
  const tooLarge = createDocument();
  tooLarge.nodes.root.images = [nodeImage('large', { dataUrl: largePngUrl(12 * 1024 * 1024 + 8) })];
  assert.throws(() => validateDocument(tooLarge));
  const total = createDocument();
  const largeDataUrl = largePngUrl(10 * 1024 * 1024);
  total.nodes.root.images = Array.from({ length: 5 }, (_, index) => nodeImage('large' + index, { dataUrl: largeDataUrl }));
  assert.throws(() => validateDocument(total));
});

test('column widths require bounded numeric widths and canonical depth keys', () => {
  const valid = createDocument();
  valid.columnWidths = { 0: 100, 1: 400.5, 128: 1600 };
  assert.deepEqual(validateDocument(valid).columnWidths, valid.columnWidths);
  assert.equal(layoutTree(valid).boxes.root.width, 152);
  for (const columnWidths of [null, [], { '-1': 200 }, { '01': 200 }, { '1.5': 200 }, { 129: 200 }, { 1: 99 }, { 1: 1601 }, { 1: Infinity }, { 1: '300' }]) {
    assert.throws(() => validateDocument({ ...createDocument(), columnWidths }));
  }
});

test('resizing a column rewraps every node in that column and recomputes row spacing and later columns', () => {
  const doc = welcomeDocument();
  doc.nodes.capture.text = '很长的中文内容'.repeat(8);
  doc.nodes.connect.text = 'Another long paragraph with words and spaces '.repeat(5);
  const before = layoutTree(doc);
  const wide = layoutTree({ ...doc, columnWidths: { 1: 600 } });
  const narrow = layoutTree({ ...doc, columnWidths: { 1: 112 } });
  for (const id of ['capture', 'connect', 'keep']) {
    assert.equal(wide.boxes[id].width, 600);
    assert.equal(narrow.boxes[id].width, 112);
    assert.equal(wide.boxes[id].textHeight, wide.boxes[id].lines.length * 21);
  }
  assert.ok(wide.boxes.capture.lines.length < before.boxes.capture.lines.length);
  assert.ok(narrow.boxes.capture.lines.length > before.boxes.capture.lines.length);
  assert.ok(wide.boxes.tab.x > before.boxes.tab.x);
  assert.equal(wide.boxes.tab.x, wide.boxes.capture.x + 600 + 64);
  const siblings = ['capture', 'connect', 'keep'].map(id => narrow.boxes[id]);
  for (let index = 1; index < siblings.length; index++) assert.ok(siblings[index].y >= siblings[index - 1].y + siblings[index - 1].height + 28);
});

test('images impose column minimum width and stack below text without adding a blank line to image-only nodes', () => {
  const doc = welcomeDocument();
  doc.columnWidths = { 1: 112 };
  doc.nodes.capture.text = '';
  doc.nodes.capture.images = [nodeImage('first', { width: 320, height: 150 }), nodeImage('second', { width: 180, height: 40 })];
  doc.nodes.connect.text = 'Text';
  doc.nodes.connect.images = [nodeImage('third', { width: 100, height: 80 })];
  const layout = layoutTree(doc);
  const first = layout.boxes.capture;
  assert.equal(first.width, 332);
  assert.equal(first.textHeight, 0);
  assert.deepEqual(first.lines, []);
  assert.equal(first.height, 150 + 40 + 8 + 6);
  assert.deepEqual(first.images, [{ id: 'first', width: 320, height: 150 }, { id: 'second', width: 180, height: 40 }]);
  assert.equal(layout.boxes.connect.width, 332);
  assert.equal(layout.boxes.keep.width, 332);
  assert.equal(layout.boxes.connect.height, 21 + 8 + 80 + 6);
  assert.equal(doc.nodes.capture.images[0].width, 320);
  const empty = createDocument();
  empty.nodes.root.text = '';
  assert.equal(layoutTree(empty).boxes.root.textHeight, 21);
  const exported = toMermaid(doc);
  assert.ok(exported.includes('Text'));
  assert.ok(!exported.includes('data:image'));
  assert.ok(!exported.includes('<img'));
});

const freezeTree = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
};

const chainDocument = depth => {
  const doc = createDocument();
  let parent = doc.nodes.root;
  for (let index = 1; index <= depth; index++) {
    const id = 'level' + index;
    parent.children.push(id);
    parent = doc.nodes[id] = { id, text: 'Level ' + index, children: [], collapsed: false };
  }
  return doc;
};

const wideDocument = count => {
  const doc = createDocument();
  for (let index = 1; index < count; index++) {
    const id = 'child' + index;
    doc.nodes.root.children.push(id);
    doc.nodes[id] = { id, text: String(index), children: [], collapsed: false };
  }
  return doc;
};

test('copying a branch includes hidden descendants, exact text and images in an independent document', () => {
  const source = welcomeDocument();
  source.nodes.capture.text = '分支标题\nSecond line';
  source.nodes.capture.collapsed = true;
  source.nodes.capture.images = [nodeImage('branchImage')];
  source.nodes.tab.images = [nodeImage('nestedImage', { width: 87.5, height: 43.75 })];
  source.columnWidths = { 0: 800, 1: 320, 2: 240, 128: 900 };
  const original = clone(source);
  freezeTree(source);
  const branch = copyBranch(source, 'capture');
  assert.notEqual(branch.id, source.id);
  assert.equal(branch.rootId, 'capture');
  assert.equal(branch.title, '分支标题 Second line');
  assert.deepEqual(Object.keys(branch.nodes).sort(), ['capture', 'enter', 'tab']);
  for (const id of ['capture', 'tab', 'enter']) assert.deepEqual(branch.nodes[id], source.nodes[id]);
  assert.deepEqual(branch.columnWidths, { 0: 320, 1: 240 });
  assert.deepEqual(validateDocument(branch), branch);
  branch.nodes.capture.children.reverse();
  branch.nodes.tab.images[0].width = 100;
  branch.columnWidths[0] = 500;
  assert.deepEqual(source, original);
  const root = copyBranch(source, source.rootId);
  assert.deepEqual(root.nodes, source.nodes);
  assert.deepEqual(root.columnWidths, { 0: 800, 1: 320, 2: 240 });
  const empty = createDocument();
  assert.ok(!Object.hasOwn(copyBranch(empty, empty.rootId), 'columnWidths'));
});

test('cross-document and repeated branch pastes append in order with fresh node and image identities', () => {
  const source = welcomeDocument();
  source.nodes.capture.collapsed = true;
  source.nodes.capture.images = [nodeImage('sharedImage')];
  source.nodes.tab.images = [nodeImage('nestedImage')];
  const branch = freezeTree(copyBranch(source, 'capture'));
  const target = addNode(createDocument('目标导图'), 'root', 'child', 'Existing').doc;
  target.nodes.root.collapsed = true;
  target.nodes.root.images = [nodeImage('sharedImage')];
  const original = clone(target);
  freezeTree(target);
  const first = pasteBranch(target, 'root', branch);
  const second = pasteBranch(first.doc, 'root', branch);
  assert.deepEqual(second.doc.nodes.root.children, [...target.nodes.root.children, first.selectedId, second.selectedId]);
  assert.equal(second.doc.id, target.id);
  assert.equal(second.doc.title, target.title);
  assert.equal(second.doc.rootId, target.rootId);
  assert.equal(second.doc.nodes.root.collapsed, false);
  const originalIds = new Set([...Object.keys(source.nodes), ...Object.keys(target.nodes), 'sharedImage', 'nestedImage']);
  const generatedIds = new Set();
  const compare = (oldId, newId) => {
    const oldNode = branch.nodes[oldId], newNode = second.doc.nodes[newId];
    assert.ok(!originalIds.has(newId));
    assert.ok(!generatedIds.has(newId));
    generatedIds.add(newId);
    assert.equal(newNode.text, oldNode.text);
    assert.equal(newNode.collapsed, oldNode.collapsed);
    assert.equal(newNode.children.length, oldNode.children.length);
    for (let index = 0; index < (oldNode.images?.length ?? 0); index++) {
      const oldImage = oldNode.images[index], newImage = newNode.images[index];
      assert.ok(!originalIds.has(newImage.id));
      assert.ok(!generatedIds.has(newImage.id));
      generatedIds.add(newImage.id);
      assert.deepEqual({ ...newImage, id: oldImage.id }, oldImage);
    }
    oldNode.children.forEach((child, index) => compare(child, newNode.children[index]));
  };
  compare(branch.rootId, first.selectedId);
  compare(branch.rootId, second.selectedId);
  assert.equal(generatedIds.size, 10);
  assert.deepEqual(validateDocument(second.doc), second.doc);
  assert.deepEqual(target, original);
  second.doc.nodes[second.selectedId].images[0].width = 600;
  assert.equal(branch.nodes.capture.images[0].width, 200);
  assert.equal(first.doc.nodes[first.selectedId].images[0].width, 200);
  const sameDocument = pasteBranch(source, 'capture', copyBranch(source, source.rootId));
  assert.equal(Object.keys(sameDocument.doc.nodes).length, Object.keys(source.nodes).length * 2);
  assert.deepEqual(validateDocument(sameDocument.doc), sameDocument.doc);
});

test('branch column widths are rebased at deep targets without replacing existing destination columns', () => {
  const source = chainDocument(4);
  source.columnWidths = { 0: 900, 1: 800, 2: 400, 3: 350, 4: 300, 5: 250 };
  const target = chainDocument(3);
  target.columnWidths = { 0: 210, 4: 600, 8: 777 };
  freezeTree(source);
  freezeTree(target);
  const branch = copyBranch(source, 'level2');
  assert.deepEqual(branch.columnWidths, { 0: 400, 1: 350, 2: 300 });
  const pasted = pasteBranch(target, 'level3', branch);
  assert.deepEqual(pasted.doc.columnWidths, { 0: 210, 4: 600, 5: 350, 6: 300, 8: 777 });
  assert.equal(parentOf(pasted.doc, pasted.selectedId), 'level3');
  assert.deepEqual(target.columnWidths, { 0: 210, 4: 600, 8: 777 });
  assert.deepEqual(branch.columnWidths, { 0: 400, 1: 350, 2: 300 });
});

test('paste accepts the last available node and depth, rejecting over-capacity branches without mutations', () => {
  const leaf = freezeTree(createDocument());
  const target = freezeTree(wideDocument(1999));
  const last = pasteBranch(target, 'root', leaf);
  assert.equal(Object.keys(last.doc.nodes).length, 2000);
  freezeTree(last.doc);
  assert.throws(() => pasteBranch(last.doc, 'root', leaf), /无法粘贴.*上限/);
  assert.equal(Object.keys(last.doc.nodes).length, 2000);
  assert.equal(last.doc.nodes.root.children.length, 1999);
  const deep = freezeTree(chainDocument(127));
  const depth128 = pasteBranch(deep, 'level127', leaf);
  freezeTree(depth128.doc);
  assert.throws(() => pasteBranch(depth128.doc, depth128.selectedId, leaf), /无法粘贴.*上限/);
  assert.deepEqual(depth128.doc.nodes[depth128.selectedId].children, []);
  const hidden = chainDocument(1);
  hidden.nodes.root.collapsed = true;
  assert.throws(() => pasteBranch(deep, 'level127', freezeTree(hidden)), /无法粘贴.*上限/);
  assert.deepEqual(deep.nodes.level127.children, []);
  assert.equal(Object.keys(leaf.nodes).length, 1);
});

test('paste enforces combined image count and byte limits even when each document separately validates', () => {
  const target = wideDocument(9);
  for (let group = 1; group <= 8; group++) {
    target.nodes['child' + group].images = Array.from({ length: 32 }, (_, index) => nodeImage('image' + (group * 32 + index)));
  }
  const branch = createDocument();
  branch.nodes.root.images = [nodeImage('extraImage')];
  const original = clone(target);
  freezeTree(target);
  freezeTree(branch);
  assert.deepEqual(validateDocument(target), target);
  assert.deepEqual(validateDocument(branch), branch);
  assert.throws(() => pasteBranch(target, 'root', branch), /无法粘贴.*上限/);
  assert.deepEqual(target, original);
  const big = createDocument();
  const dataUrl = largePngUrl(10 * 1024 * 1024);
  big.nodes.root.images = Array.from({ length: 4 }, (_, index) => nodeImage('big' + index, { dataUrl }));
  const extra = createDocument();
  extra.nodes.root.images = [nodeImage('extra', { dataUrl })];
  freezeTree(big);
  freezeTree(extra);
  assert.equal(validateDocument(big).nodes.root.images.length, 4);
  assert.equal(validateDocument(extra).nodes.root.images.length, 1);
  assert.throws(() => pasteBranch(big, 'root', extra), /无法粘贴.*上限/);
  assert.deepEqual(big.nodes.root.children, []);
  assert.equal(big.nodes.root.images.length, 4);
  assert.equal(extra.nodes.root.images[0].id, 'extra');
});

test('copy and paste reject missing selections and malformed clipboard trees before changing a document', () => {
  const target = freezeTree(welcomeDocument());
  const malformed = createDocument();
  malformed.nodes.root.children.push('root');
  freezeTree(malformed);
  assert.throws(() => copyBranch(target, 'missing'), /请选择要复制的节点/);
  assert.throws(() => copyBranch(malformed, 'root'));
  assert.throws(() => pasteBranch(target, 'missing', createDocument()), /请选择要粘贴到的节点/);
  assert.throws(() => pasteBranch(target, 'root', malformed), /无法粘贴/);
  assert.deepEqual(target.nodes.root.children, ['capture', 'connect', 'keep']);
  assert.deepEqual(malformed.nodes.root.children, ['root']);
});
