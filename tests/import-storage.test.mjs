import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../electron/storage.mjs';
import { addNode, createDocument, toMermaid } from '../src/core.mjs';

const flowchart = 'flowchart LR\n  A["阅读"] --> B["笔记"]\n  A --> C["想法"]\n  B -.->|"启发"| C\n';
const textOf = doc => Object.values(doc.nodes).map(node => node.text);
const importStage = file => typeof file === 'string' && /^import-.*\.tmp$/i.test(path.basename(file));
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mindmap-import-storage-'));
  if (process.env.INKMAP_KEEP_TEST_ARTIFACTS !== '1') t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new LocalStore(home);
  const session = await store.boot();
  return { home, store, session };
}
async function libraryBytes(store) {
  const result = {};
  const walk = async folder => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else result[path.relative(store.maps, file)] = await fs.readFile(file, 'utf8');
    }
  };
  await walk(store.maps);
  return result;
}
async function noStages(store) {
  assert.deepEqual((await fs.readdir(path.dirname(store.statePath))).filter(name => /^import-.*\.tmp$/i.test(name)), []);
}

for (const extension of ['md', 'markdown', 'mmd', 'mermaid', 'MMD']) {
  test(`${extension} imports an independent editable native copy and preserves the original`, async t => {
    const { home, store, session } = await fixture(t);
    const source = path.join(home, `阅读来源.${extension}`);
    const bytes = /^(md|markdown)$/i.test(extension) ? `# 读书笔记\n\n\`\`\`mermaid\n${flowchart}\`\`\`\n` : flowchart;
    await fs.writeFile(source, bytes);
    const imported = await store.open(source);
    assert.equal(path.extname(imported.path), '.mindmap');
    assert.equal(path.dirname(imported.path), store.maps);
    assert.notEqual(imported.token, session.token);
    assert.notEqual(imported.doc.id, session.doc.id);
    assert.ok(['阅读', '笔记', '想法'].every(text => textOf(imported.doc).includes(text)));
    assert.equal(imported.doc.relationships.length, 1);
    assert.equal(imported.doc.relationships[0].text, '启发');
    assert.ok(imported.recent.every(entry => entry.path !== source));
    const edited = addNode(imported.doc, imported.doc.rootId, 'child', '导入后新增').doc;
    await store.save(edited, imported.token);
    assert.deepEqual(JSON.parse(await fs.readFile(imported.path, 'utf8')), edited);
    assert.equal(await fs.readFile(source, 'utf8'), bytes);
    const restored = await new LocalStore(home).boot();
    assert.equal(restored.path, imported.path);
    assert.deepEqual(restored.doc, edited);
    await noStages(store);
  });
}

test('own Markdown export preserves tree labels and relationship endpoints on import', async t => {
  const { home, store } = await fixture(t);
  let original = createDocument('往返阅读');
  original.nodes.root.text = '中英 Reading & "理解"\n第二行';
  const first = addNode(original, 'root', 'child', '笔记 #1');
  const second = addNode(first.doc, 'root', 'child', '结论 < Conclusion');
  original = second.doc;
  original.relationships = [{ id: 'reference', sourceId: first.selectedId, targetId: second.selectedId, text: '参考 | Reference\n进一步思考' }];
  const source = path.join(home, '往返阅读.md');
  await fs.writeFile(source, toMermaid(original));
  const imported = await store.open(source);
  assert.equal(imported.doc.nodes[imported.doc.rootId].text, original.nodes.root.text);
  assert.deepEqual(textOf(imported.doc).sort(), textOf(original).sort());
  const link = imported.doc.relationships[0];
  assert.equal(link.text, original.relationships[0].text);
  assert.equal(imported.doc.nodes[link.sourceId].text, '笔记 #1');
  assert.equal(imported.doc.nodes[link.targetId].text, '结论 < Conclusion');
});

test('Markdown inside a library subfolder imports without listing or modifying its source', async t => {
  const { store } = await fixture(t);
  await store.createFolder('阅读');
  const source = path.join(store.maps, '阅读', '笔记.markdown');
  const bytes = '# 阅读计划\n\n## 今天\n\n- 阅读第一章\n  - 记录问题\n\n## 明天\n\n继续整理。\n';
  await fs.writeFile(source, bytes);
  const imported = await store.open(source);
  assert.ok(store.containsLibraryPath(imported.path));
  assert.equal(path.extname(imported.path), '.mindmap');
  assert.ok(['阅读计划', '今天', '阅读第一章', '记录问题', '明天', '继续整理。'].every(text => textOf(imported.doc).includes(text)));
  const flatten = entries => entries.flatMap(entry => [entry, ...flatten(entry.children ?? [])]);
  const entries = flatten((await store.library()).entries);
  assert.ok(entries.some(entry => entry.path === imported.path));
  assert.ok(entries.every(entry => entry.path !== source));
  assert.equal(await fs.readFile(source, 'utf8'), bytes);
});

test('repeated imports with matching titles never overwrite existing native maps', async t => {
  const { home, store } = await fixture(t);
  const source = path.join(home, '重复.mmd');
  await fs.writeFile(source, flowchart);
  const a = await store.open(source);
  const originalBytes = await fs.readFile(a.path, 'utf8');
  const b = await store.open(source);
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.doc.id, b.doc.id);
  assert.equal(await fs.readFile(a.path, 'utf8'), originalBytes);
  assert.equal(await fs.readFile(source, 'utf8'), flowchart);
});

test('invalid, empty, unsupported, missing and oversized imports preserve active state and library', async t => {
  const { home, store, session } = await fixture(t);
  const cases = [
    ['损坏.mmd', 'flowchart LR\nA -->'],
    ['空白.md', ' \n\t'],
    ['不支持.mermaid', 'sequenceDiagram\nAlice->>Bob: Hello'],
    ['后缀.txt', flowchart],
    ['过大.md', 'x'.repeat(4 * 1024 * 1024 + 1)],
  ];
  const before = await libraryBytes(store);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  for (const [name, bytes] of cases) {
    const source = path.join(home, name);
    await fs.writeFile(source, bytes);
    await assert.rejects(store.open(source), name);
    assert.deepEqual(store.snapshot(), session, name);
    assert.deepEqual(await libraryBytes(store), before, name);
    assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace, name);
    assert.equal(await fs.readFile(source, 'utf8'), bytes, name);
  }
  await assert.rejects(store.open(path.join(home, '不存在.mmd')));
  assert.deepEqual(store.snapshot(), session);
  await noStages(store);
});

test('failed partial import staging and failed publication leave no native junk or switched session', async t => {
  const { home, store, session } = await fixture(t);
  const source = path.join(home, '写入失败.mmd');
  await fs.writeFile(source, flowchart);
  const before = await libraryBytes(store);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  for (const operation of ['writeFile', 'link']) {
    const original = fs[operation];
    let injected = false;
    fs[operation] = async (...args) => {
      if (importStage(args[0])) {
        injected = true;
        if (operation === 'writeFile') await original(args[0], '{"partial":', args[2]);
        throw Object.assign(new Error('模拟磁盘已满'), { code: 'ENOSPC' });
      }
      return original(...args);
    };
    try { await assert.rejects(store.open(source), /模拟磁盘已满/); }
    finally { fs[operation] = original; }
    assert.equal(injected, true, `${operation} fault reached import staging`);
    assert.deepEqual(store.snapshot(), session);
    assert.deepEqual(await libraryBytes(store), before);
    assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
    assert.equal(await fs.readFile(source, 'utf8'), flowchart);
    await noStages(store);
  }
});

test('import publication retries a concurrent filename collision without overwriting it', async t => {
  const { home, store } = await fixture(t);
  const source = path.join(home, '名称碰撞.mmd');
  await fs.writeFile(source, flowchart);
  const original = fs.link;
  const competing = JSON.stringify(createDocument('保留并发创建的导图'));
  let collision;
  fs.link = async (...args) => {
    if (!collision && importStage(args[0])) {
      collision = args[1];
      await fs.writeFile(collision, competing, { flag: 'wx' });
    }
    return original(...args);
  };
  let imported;
  try { imported = await store.open(source); }
  finally { fs.link = original; }
  assert.ok(collision);
  assert.notEqual(imported.path, collision);
  assert.equal(await fs.readFile(collision, 'utf8'), competing);
  assert.ok(textOf(imported.doc).includes('阅读'));
  await noStages(store);
});

test('workspace recording failure returns the established imported session and remains editable', async t => {
  const { home, store, session } = await fixture(t);
  const source = path.join(home, '位置记录.mermaid');
  await fs.writeFile(source, flowchart);
  const original = store.remember;
  store.remember = async () => { throw new Error('位置记录只读'); };
  let imported;
  try { imported = await store.open(source); }
  finally { store.remember = original; }
  assert.notEqual(imported.token, session.token);
  assert.equal(imported.token, store.snapshot().token);
  assert.match(imported.notice, /位置记录未能保存/);
  const edited = addNode(imported.doc, imported.doc.rootId, 'child', '继续编辑').doc;
  await store.save(edited, imported.token);
  assert.deepEqual(JSON.parse(await fs.readFile(imported.path, 'utf8')), edited);
  assert.equal(await fs.readFile(source, 'utf8'), flowchart);
});

test('native library files with a UTF-8 BOM open and save without a false disk conflict', async t => {
  const { store } = await fixture(t);
  const native = createDocument('带 BOM 的原生导图');
  native.nodes.root.text = '正确读取中文';
  const source = path.join(store.maps, '带 BOM.mindmap');
  await fs.writeFile(source, '\uFEFF' + JSON.stringify(native));
  const opened = await store.open(source);
  assert.equal(opened.path, source);
  assert.deepEqual(opened.doc, native);
  const edited = addNode(opened.doc, opened.doc.rootId, 'child', '正常保存').doc;
  await store.save(edited, opened.token);
  assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), edited);
});

test('malformed UTF-8 import is rejected without changing its bytes or active state', async t => {
  const { home, store, session } = await fixture(t);
  const source = path.join(home, '错误编码.md');
  const bytes = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
  await fs.writeFile(source, bytes);
  const before = await libraryBytes(store);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  await assert.rejects(store.open(source));
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual(store.snapshot(), session);
  assert.deepEqual(await libraryBytes(store), before);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
});
