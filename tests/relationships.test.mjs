import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../electron/storage.mjs';
import { addRelationship, clone, copyBranch, createDocument, deleteNode, deleteNodeOnly, deleteRelationship, moveNode, pasteBranch, toMermaid, validateDocument } from '../src/core.mjs';

const fixture = () => ({
  ...createDocument(),
  nodes: {
    root: { id: 'root', text: '中心', children: ['a', 'b'], collapsed: false },
    a: { id: 'a', text: 'A', children: ['a1', 'a2'], collapsed: false },
    a1: { id: 'a1', text: 'A1', children: [], collapsed: false },
    a2: { id: 'a2', text: 'A2', children: [], collapsed: false },
    b: { id: 'b', text: 'B', children: [], collapsed: false },
  },
});
const relationship = (id = 'r1', sourceId = 'a', targetId = 'b') => ({ id, sourceId, targetId, text: '相互影响\nRelationship', control1: { x: 80.5, y: -70 }, control2: { x: -120, y: 45.25 } });

test('relationships and control offsets survive validation, JSON serialization, save and restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindmap-relationship-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir);
  const session = await store.boot();
  const doc = { ...fixture(), id: session.doc.id, relationships: [relationship()] };
  const validated = validateDocument(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(validated, doc);
  assert.notEqual(validated.relationships[0].control1, doc.relationships[0].control1);
  await store.save(validated, session.token);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')).relationships, doc.relationships);
  const restarted = await new LocalStore(dir).boot();
  assert.deepEqual(restarted.doc, doc);
});

test('old documents and optional automatic controls remain compatible without adding fields', () => {
  const old = fixture();
  assert.deepEqual(validateDocument(old), old);
  assert.equal(Object.hasOwn(clone(old), 'relationships'), false);
  const doc = { ...old, relationships: [{ id: 'r1', sourceId: 'root', targetId: 'a', text: '' }] };
  assert.deepEqual(validateDocument(doc), doc);
  assert.deepEqual(validateDocument({ ...old, relationships: [] }).relationships, []);
});

test('invalid relationships are rejected instead of losing their content on save', () => {
  const invalid = [
    null, {}, { ...relationship(), id: '' }, { ...relationship(), id: 'bad id' },
    { ...relationship(), id: 'constructor' }, { ...relationship(), sourceId: 'missing' },
    { ...relationship(), targetId: 'missing' }, { ...relationship(), targetId: 'a' },
    { ...relationship(), sourceId: 1 }, { ...relationship(), text: null },
    { ...relationship(), text: 'a'.repeat(8001) },
    ...[null, [], {}, { x: NaN, y: 1 }, { x: Infinity, y: 0 }, { x: 0, y: -100001 }, { x: '1', y: 0 }].flatMap(point => [
      { ...relationship(), control1: point }, { ...relationship(), control2: point },
    ]),
  ];
  for (const value of invalid) assert.throws(() => validateDocument({ ...fixture(), relationships: [value] }));
  for (const value of [null, {}, 'relationships']) assert.throws(() => validateDocument({ ...fixture(), relationships: value }));
  assert.throws(() => validateDocument({ ...fixture(), relationships: [relationship(), relationship('r1', 'b', 'a')] }));
  assert.throws(() => validateDocument({ ...fixture(), relationships: [relationship(), relationship('r2')] }));
  const valid = relationship();
  valid.text = '字'.repeat(8000);
  valid.control1 = { x: -100000, y: 100000 };
  assert.deepEqual(validateDocument({ ...fixture(), relationships: [valid] }).relationships, [valid]);
});

test('relationship creation deduplicates directed pairs, allows reverse direction and is immutable', () => {
  const doc = fixture();
  const { doc: linked, relationshipId } = addRelationship(doc, 'a', 'b');
  assert.equal(doc.relationships, undefined);
  assert.deepEqual(linked.relationships, [{ id: relationshipId, sourceId: 'a', targetId: 'b', text: '' }]);
  assert.deepEqual(addRelationship(linked, 'a', 'b'), { doc: linked, relationshipId });
  const reverse = addRelationship(linked, 'b', 'a');
  assert.equal(reverse.doc.relationships.length, 2);
  assert.notEqual(reverse.relationshipId, relationshipId);
  assert.throws(() => addRelationship(doc, 'a', 'a'), /不同的节点/);
  assert.throws(() => addRelationship(doc, 'a', 'missing'), /不同的节点/);
  assert.deepEqual(validateDocument(reverse.doc), reverse.doc);
});

test('relationship edits and deletion cannot mutate previous undo snapshots or remove nodes', () => {
  const doc = { ...fixture(), relationships: [relationship(), relationship('r2', 'a1', 'b')] };
  const edited = clone(doc);
  edited.relationships[0].text = '修改';
  edited.relationships[0].control1.x = 222;
  edited.relationships[0].control2.y = -222;
  assert.deepEqual(doc.relationships[0], relationship());
  const deleted = deleteRelationship(doc, 'r1');
  assert.deepEqual(deleted.nodes, doc.nodes);
  assert.deepEqual(deleted.relationships, [doc.relationships[1]]);
  assert.equal(doc.relationships.length, 2);
  assert.equal(deleteRelationship(doc, 'missing'), doc);
});

test('branch deletion prunes only relationships touching removed nodes', () => {
  const doc = { ...fixture(), relationships: [relationship(), relationship('r2', 'a1', 'a2'), relationship('r3', 'root', 'b')] };
  const removed = deleteNode(doc, 'a').doc;
  assert.deepEqual(removed.relationships, [doc.relationships[2]]);
  assert.deepEqual(validateDocument(removed), removed);
  assert.equal(doc.relationships.length, 3);
  assert.equal(deleteNode(doc, 'root').doc, doc);
});

test('deleting one node preserves child relationships without silently rewiring its own', () => {
  const doc = { ...fixture(), relationships: [relationship(), relationship('r2', 'a1', 'a2'), relationship('r3', 'b', 'a1')] };
  const removed = deleteNodeOnly(doc, 'a').doc;
  assert.deepEqual(removed.nodes.root.children, ['a1', 'a2', 'b']);
  assert.deepEqual(removed.relationships, doc.relationships.slice(1));
  assert.deepEqual(validateDocument(removed), removed);
  const moved = moveNode(doc, 'a1', 'b');
  assert.deepEqual(moved.relationships, doc.relationships);
  assert.notEqual(moved.relationships[0].control1, doc.relationships[0].control1);
});

test('branch clipboard keeps only internal links and pasting creates independent identities', () => {
  const doc = { ...fixture(), relationships: [relationship(), relationship('r2', 'a1', 'a2'), relationship('r3', 'a', 'a1')] };
  const branch = copyBranch(doc, 'a');
  assert.deepEqual(branch.relationships, doc.relationships.slice(1));
  assert.deepEqual(copyBranch(doc, 'root').relationships, doc.relationships);
  assert.deepEqual(copyBranch(doc, 'a1').relationships, []);
  const before = structuredClone(branch);
  const first = pasteBranch(doc, 'b', branch);
  const second = pasteBranch(first.doc, 'b', branch);
  assert.equal(first.doc.relationships.length, 5);
  assert.equal(second.doc.relationships.length, 7);
  const allIds = second.doc.relationships.map(link => link.id);
  assert.equal(new Set(allIds).size, allIds.length);
  for (const result of [first, second]) {
    const pastedIds = new Set([result.selectedId, ...result.doc.nodes[result.selectedId].children]);
    for (const link of result.doc.relationships.slice(-2)) {
      assert.ok(pastedIds.has(link.sourceId));
      assert.ok(pastedIds.has(link.targetId));
      assert.deepEqual(link.control1, relationship().control1);
      assert.deepEqual(link.control2, relationship().control2);
      assert.ok(!branch.relationships.some(original => original.id === link.id));
    }
  }
  second.doc.relationships.at(-1).control1.x = 1000;
  assert.deepEqual(branch, before);
  assert.deepEqual(doc.relationships[0], relationship());
});

test('creation, file validation and paste enforce the shared relationship capacity', () => {
  const doc = createDocument();
  for (let i = 0; i < 46; i++) {
    const id = `node${i}`;
    doc.nodes.root.children.push(id);
    doc.nodes[id] = { id, text: '', children: [], collapsed: false };
  }
  const ids = Object.keys(doc.nodes);
  doc.relationships = [];
  for (const sourceId of ids) for (const targetId of ids) {
    if (sourceId !== targetId && doc.relationships.length < 2000) doc.relationships.push({ id: `r${doc.relationships.length}`, sourceId, targetId, text: '' });
  }
  assert.deepEqual(validateDocument(doc), doc);
  const last = ids.at(-1), prior = ids.at(-2);
  assert.throws(() => addRelationship(doc, last, prior), /数量上限/);
  assert.throws(() => validateDocument({ ...doc, relationships: [...doc.relationships, relationship('extra', last, prior)] }));
  const branch = { ...fixture(), relationships: [relationship()] };
  assert.throws(() => pasteBranch(doc, 'root', branch), /联系容量上限/);
  assert.equal(doc.relationships.length, 2000);
});

test('Mermaid exports dashed relationships, horizontal labels and escaped punctuation without shape metadata', () => {
  const doc = fixture();
  doc.nodes.a.collapsed = true;
  doc.relationships = [
    { ...relationship('r1', 'a1', 'b'), text: '中文 "quote" & #hash <tag> | pipe `tick` \\ path\n第二行' },
    { id: 'r2', sourceId: 'b', targetId: 'a', text: '' },
  ];
  const output = toMermaid(doc, false);
  assert.match(output, /N2 -\.->\|"中文 #34;quote#34; #38; #35;hash #60;tag#62; #124; pipe #96;tick#96; #92; path<br\/>第二行"\| N4/);
  assert.match(output, /N4 -\.-> N1/);
  assert.equal((output.match(/ --> /g) ?? []).length, 4);
  assert.equal((output.match(/ -\.->/g) ?? []).length, 2);
  assert.ok(!output.includes('control1') && !output.includes('80.5'));
  assert.ok(toMermaid(doc).startsWith('```mermaid\n'));
});
