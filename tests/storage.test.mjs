import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore, atomicWrite } from '../electron/storage.mjs';
import { addNode, createDocument } from '../src/core.mjs';

async function storeFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindmap-test-'));
  if (process.env.INKMAP_KEEP_TEST_ARTIFACTS !== '1') t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir);
  const session = await store.boot();
  return { store, session, dir };
}

async function simulatedTrash(dir) {
  const bin = path.join(dir, 'test-recycle-bin');
  await fs.mkdir(bin);
  const items = [];
  const trash = async source => {
    const relative = path.relative(path.join(dir, '导图'), source);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const destination = path.join(bin, String(items.length));
    await fs.rename(source, destination);
    items.push({ source, destination });
  };
  return { trash, items };
}

const childrenAt = (library, folder) => {
  if (path.relative(library.root, folder) === '') return library.entries;
  const visit = entries => {
    for (const entry of entries) {
      if (entry.kind !== 'folder') continue;
      if (path.relative(entry.path, folder) === '') return entry.children;
      const found = visit(entry.children ?? []);
      if (found) return found;
    }
  };
  return visit(library.entries);
};
const labelsAt = (library, folder) => childrenAt(library, folder).map(entry => entry.title || entry.name);
const storagePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
const storageImage = (id, dataUrl = storagePng) => ({ id, dataUrl, width: 240, height: 120, naturalWidth: 480, naturalHeight: 240 });

test('autosave writes underneath the app, serializes edits, and restores on restart', async t => {
  const { store, session, dir } = await storeFixture(t);
  assert.equal(path.dirname(session.path), path.join(dir, '导图'));
  const first = addNode(session.doc, 'root').doc;
  const second = addNode(first, 'root').doc;
  await Promise.all([store.save(first, session.token), store.save(second, session.token)]);
  const restarted = await new LocalStore(dir).boot();
  assert.deepEqual(restarted.doc, second);
  assert.equal(restarted.path, session.path);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mindmap', 'backups', second.id + '.mindmap'), 'utf8')), first);
});

test('stale session cannot overwrite another file', async t => {
  const { store, session } = await storeFixture(t);
  const next = await store.create();
  await assert.rejects(store.save(session.doc, session.token), /文件已切换/);
  assert.equal(store.snapshot().path, next.path);
});

test('external edits survive a conflicting save, and recovery becomes a separate file', async t => {
  const { store, session, dir } = await storeFixture(t);
  const edited = addNode(session.doc, 'root').doc;
  const external = structuredClone(session.doc); external.title = '外部修改';
  await atomicWrite(session.path, JSON.stringify(external));
  await assert.rejects(store.save(edited, session.token), /其他地方/);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), external);
  const restored = await new LocalStore(dir).boot();
  assert.notEqual(restored.path, session.path);
  assert.ok(restored.notice.includes('恢复'));
  assert.equal(Object.keys(restored.doc.nodes).length, Object.keys(edited.nodes).length);
});

test('valid recovery survives a damaged original file and keeps every pending node', async t => {
  const { store, session, dir } = await storeFixture(t);
  const edited = addNode(session.doc, 'root', 'child', '尚未保存的内容').doc;
  await fs.writeFile(session.path, '{externally damaged');
  await assert.rejects(store.save(edited, session.token), /其他地方/);
  const restored = await new LocalStore(dir).boot();
  assert.match(restored.notice, /恢复/);
  assert.notEqual(restored.path, session.path);
  assert.deepEqual(restored.doc.nodes, edited.nodes);
  assert.equal(await fs.readFile(session.path, 'utf8'), '{externally damaged');
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('recovery of a maximum-length title remains valid and can be saved again', async t => {
  const { store, session, dir } = await storeFixture(t);
  const edited = addNode(session.doc, 'root', 'child', '需要恢复').doc;
  edited.title = '长'.repeat(200);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: edited }));
  const restarted = new LocalStore(dir);
  const restored = await restarted.boot();
  assert.match(restored.notice, /恢复/);
  assert.equal(restored.doc.title.length, 200);
  assert.ok(restored.doc.title.endsWith('（恢复）'));
  assert.deepEqual(restored.doc.nodes, edited.nodes);
  const next = addNode(restored.doc, 'root').doc;
  await restarted.save(next, restored.token);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, next);
});

test('an externally moved current file saves to a new library path without recreating its old path', async t => {
  const { store, session, dir } = await storeFixture(t);
  const externalPath = path.join(dir, 'externally-moved.mindmap');
  await fs.rename(session.path, externalPath);
  const edited = addNode(session.doc, 'root', 'child', '移动之后的新记录').doc;
  const saved = await store.save(edited, session.token);
  assert.equal(path.dirname(saved.path), store.maps);
  assert.notEqual(saved.path, session.path);
  assert.equal(store.snapshot().token, session.token);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), edited);
  await assert.rejects(fs.access(session.path), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(externalPath, 'utf8')), session.doc);
  const restored = await new LocalStore(dir).boot();
  assert.deepEqual(restored.doc, edited);
  assert.equal(restored.path, saved.path);
});

test('malformed workspace metadata does not prevent opening the local app', async t => {
  for (const state of [null, [], { recent: [null, 123, { path: false }] }]) {
    const { store, dir } = await storeFixture(t);
    await atomicWrite(store.statePath, JSON.stringify(state));
    const restarted = new LocalStore(dir);
    const session = await restarted.boot();
    assert.ok(session.token);
    assert.equal(session.doc.nodes[session.doc.rootId].text, '');
    assert.ok(session.recent.every(item => typeof item.path === 'string' && path.isAbsolute(item.path)));
  }
});

test('invalid open leaves active document intact; save-as produces a usable native file', async t => {
  const { store, session, dir } = await storeFixture(t);
  const malformed = path.join(dir, 'bad.mindmap');
  await fs.writeFile(malformed, '{}');
  await assert.rejects(store.open(malformed));
  assert.equal(store.snapshot().token, session.token);
  const before = store.snapshot();
  const target = path.join(dir, '导图', '副本.mindmap');
  const result = await store.saveAs(session.doc, session.token, target);
  assert.deepEqual(result, { path: target });
  const copy = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.notEqual(copy.id, session.doc.id);
  assert.deepEqual({ ...copy, id: session.doc.id }, session.doc);
  assert.deepEqual(store.snapshot(), before);
});

test('save-as writes only an independent copy and preserves the active session, recent list and recovery', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '副本中的未保存内容').doc;
  pending.nodes.root.images = [storageImage('copiedImage')];
  pending.columnWidths = { 0: 400 };
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: pending }));
  const before = structuredClone(store.current);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const recovery = await fs.readFile(store.recoveryPath, 'utf8');
  const original = await fs.readFile(session.path, 'utf8');
  const target = path.join(dir, 'Desktop', '分享副本.mindmap');
  const remember = store.remember;
  store.remember = async () => { throw new Error('另存副本不应修改工作区'); };
  assert.deepEqual(await store.saveAs(pending, session.token, target), { path: target });
  assert.deepEqual(store.current, before);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.equal(await fs.readFile(session.path, 'utf8'), original);
  const copy = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.notEqual(copy.id, pending.id);
  assert.deepEqual({ ...copy, id: pending.id }, pending);
  store.remember = remember;
  const next = addNode(pending, 'root', 'child', '仍写入库内原图').doc;
  assert.deepEqual(await store.save(next, session.token), { path: session.path });
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), next);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), copy);
});

test('save-as cannot bypass a conflict by targeting the active path and never consumes recovery', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root').doc;
  const external = structuredClone(session.doc); external.title = '外部修改保留';
  await fs.writeFile(session.path, JSON.stringify(external));
  await assert.rejects(store.save(pending, session.token), /其他地方/);
  const recovery = await fs.readFile(store.recoveryPath, 'utf8');
  await assert.rejects(store.saveAs(pending, session.token, session.path), /副本.*不同/);
  if (process.platform === 'win32') await assert.rejects(store.saveAs(pending, session.token, session.path.toUpperCase()), /副本.*不同/);
  const target = path.join(dir, '保留我的修改.mindmap');
  await store.saveAs(pending, session.token, target);
  assert.equal(store.snapshot().path, session.path);
  assert.equal(store.snapshot().token, session.token);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), external);
  await assert.rejects(store.save(pending, session.token), /其他地方/);
});

test('opening an external map imports an independent library copy and never edits the original', async t => {
  const { store, session, dir } = await storeFixture(t);
  const externalPath = path.join(dir, '外部原件.mindmap');
  const external = addNode(createDocument('导入笔记'), 'root', 'child', '保留文字和子节点').doc;
  external.nodes.root.images = [storageImage('importImage')];
  external.columnWidths = { 0: 450, 1: 320 };
  const bytes = JSON.stringify(external);
  await fs.writeFile(externalPath, bytes);
  const opened = await store.open(externalPath);
  assert.equal(path.dirname(opened.path), store.maps);
  assert.notEqual(opened.doc.id, external.id);
  assert.notEqual(opened.token, session.token);
  assert.deepEqual({ ...opened.doc, id: external.id }, external);
  assert.ok(opened.recent.every(item => item.path !== externalPath));
  const changed = addNode(opened.doc, 'root').doc;
  await store.save(changed, opened.token);
  assert.equal(await fs.readFile(externalPath, 'utf8'), bytes);
  const again = await store.open(externalPath);
  assert.notEqual(again.path, opened.path);
  assert.notEqual(again.doc.id, opened.doc.id);
  assert.deepEqual(JSON.parse(await fs.readFile(opened.path, 'utf8')), changed);
  assert.equal(await fs.readFile(externalPath, 'utf8'), bytes);
});

test('boot imports an existing legacy external current path into the library', async t => {
  const { store, dir } = await storeFixture(t);
  const externalPath = path.join(dir, '桌面旧工作图.mindmap');
  const external = createDocument('旧工作图');
  const bytes = JSON.stringify(external);
  await fs.writeFile(externalPath, bytes);
  await atomicWrite(store.statePath, JSON.stringify({ current: externalPath, recent: [] }));
  const opened = await new LocalStore(dir).boot();
  assert.equal(path.dirname(opened.path), store.maps);
  assert.notEqual(opened.doc.id, external.id);
  assert.deepEqual(opened.doc.nodes, external.nodes);
  assert.equal(await fs.readFile(externalPath, 'utf8'), bytes);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, 'utf8')).current, opened.path);
});

test('missing legacy external paths rehome queued edits into one unique library file with the same token', async t => {
  const { store, session, dir } = await storeFixture(t);
  const missing = path.join(dir, 'Desktop', '已经不存在.mindmap');
  store.current.path = missing;
  await store.remember();
  const originalBytes = await fs.readFile(session.path, 'utf8');
  const first = addNode(session.doc, 'root', 'child', '第一次修改').doc;
  const second = addNode(first, 'root', 'child', '紧接着修改').doc;
  const [a, b] = await Promise.all([store.save(first, session.token), store.save(second, session.token)]);
  assert.equal(a.path, b.path);
  assert.equal(path.dirname(a.path), store.maps);
  assert.notEqual(a.path, session.path);
  assert.equal(store.snapshot().token, session.token);
  assert.equal(store.snapshot().doc.id, session.doc.id);
  assert.deepEqual(JSON.parse(await fs.readFile(a.path, 'utf8')), second);
  assert.equal(await fs.readFile(session.path, 'utf8'), originalBytes);
  await assert.rejects(fs.access(missing), { code: 'ENOENT' });
  assert.equal((await new LocalStore(dir).boot()).path, a.path);
});

test('a missing library parent moves pending work to the root without recreating the removed folder', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('原文件夹');
  const folder = path.join(store.maps, '原文件夹');
  const session = await store.create(createDocument('独立记录'), folder);
  const archived = path.join(dir, '外部移动的文件夹');
  await fs.rename(folder, archived);
  const pending = addNode(session.doc, 'root').doc;
  const saved = await store.save(pending, session.token);
  assert.equal(path.dirname(saved.path), store.maps);
  assert.equal(store.snapshot().token, session.token);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), pending);
  await assert.rejects(fs.access(folder), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(archived, path.basename(session.path)), 'utf8')), session.doc);
});

test('completed document writes succeed when metadata fails and retry metadata without changing content', async t => {
  const { store, session } = await storeFixture(t);
  const edited = addNode(session.doc, 'root').doc;
  const remember = store.remember;
  store.remember = async () => { throw new Error('工作区暂时不可写'); };
  assert.deepEqual(await store.save(edited, session.token), { path: session.path });
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), edited);
  assert.equal(store.saveMetadataPending, true);
  await fs.access(store.recoveryPath);
  store.remember = remember;
  assert.deepEqual(await store.save(edited, session.token), { path: session.path });
  assert.equal(store.saveMetadataPending, false);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('recovery cleanup failures retry after a completed save without a permanent save error', async t => {
  const { store, session } = await storeFixture(t);
  const edited = addNode(session.doc, 'root').doc;
  const clearRecovery = store.clearRecovery;
  store.clearRecovery = async () => { throw new Error('恢复记录暂时无法清理'); };
  assert.deepEqual(await store.save(edited, session.token), { path: session.path });
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), edited);
  await fs.access(store.recoveryPath);
  store.clearRecovery = clearRecovery;
  await store.save(edited, session.token);
  assert.equal(store.saveMetadataPending, false);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('boot follows a completed rehome journal when recording the new path failed', async t => {
  const { store, session, dir } = await storeFixture(t);
  const missing = path.join(dir, 'Desktop', '旧工作路径.mindmap');
  store.current.path = missing;
  await store.remember();
  store.remember = async () => { throw new Error('路径记录暂时不可写'); };
  const edited = addNode(session.doc, 'root').doc;
  const saved = await store.save(edited, session.token);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, 'utf8')).current, missing);
  const recovered = await new LocalStore(dir).boot();
  assert.equal(recovered.path, saved.path);
  assert.deepEqual(recovered.doc, edited);
  assert.equal(recovered.notice, undefined);
  await assert.rejects(fs.access(missing), { code: 'ENOENT' });
});

for (const failure of ['remember', 'clearRecovery']) test(`boot retains a completed journal while ${failure} fails and retries on the next save`, async t => {
  const { store, session, dir } = await storeFixture(t);
  const edited = addNode(session.doc, 'root').doc;
  await fs.writeFile(session.path, JSON.stringify(edited, null, 2));
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: edited }));
  const restarted = new LocalStore(dir);
  const original = restarted[failure];
  restarted[failure] = async () => { throw new Error('元数据暂时不可写'); };
  const opened = await restarted.boot();
  assert.equal(opened.path, session.path);
  assert.deepEqual(opened.doc, edited);
  assert.equal(restarted.saveMetadataPending, true);
  await fs.access(store.recoveryPath);
  restarted[failure] = original;
  await restarted.save(opened.doc, opened.token);
  assert.equal(restarted.saveMetadataPending, false);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

for (const action of ['open', 'new', 'draft']) test(`${action} returns the established session when workspace recording fails`, async t => {
  const { store, session } = await storeFixture(t);
  const originalBytes = await fs.readFile(session.path, 'utf8');
  const target = path.join(store.maps, '独立目标.mindmap');
  const incoming = createDocument('独立目标');
  incoming.nodes.root.text = '切换后的独立内容';
  if (action === 'open') await fs.writeFile(target, JSON.stringify(incoming));
  const remember = store.remember;
  store.remember = async () => { throw new Error('位置记录只读'); };
  const opened = action === 'open' ? await store.open(target)
    : action === 'new' ? await store.create(incoming)
    : await store.openDraft();
  assert.notEqual(opened.token, session.token);
  assert.equal(opened.token, store.snapshot().token);
  assert.match(opened.notice, /位置记录未能保存/);
  if (action === 'draft') assert.equal(opened.path, '');
  else assert.deepEqual(opened.doc, incoming);
  await assert.rejects(store.save(addNode(session.doc, 'root').doc, session.token), /文件已切换/);
  assert.equal(await fs.readFile(session.path, 'utf8'), originalBytes);
  store.remember = remember;
  const edited = addNode(opened.doc, 'root', 'child', '可以继续保存').doc;
  const saved = await store.save(edited, opened.token);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), edited);
  assert.equal(await fs.readFile(session.path, 'utf8'), originalBytes);
});

test('new maps with the same title do not overwrite existing maps', async t => {
  const { store } = await storeFixture(t);
  const a = await store.create(createDocument());
  const b = await store.create(createDocument());
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.doc.id, b.doc.id);
});

test('library reads real nested folders, sorts naturally, and marks damaged maps without listing metadata', async t => {
  const { store } = await storeFixture(t);
  await Promise.all([store.createFolder('项目10'), store.createFolder('项目2')]);
  const folder = path.join(store.maps, '项目2');
  const nested = await store.createFolder('资料', folder);
  assert.equal(nested.root, store.maps);
  await store.create(createDocument('观点10'), folder);
  await store.create(createDocument('观点2'), folder);
  await fs.writeFile(path.join(folder, '损坏.mindmap'), '{broken');
  await fs.writeFile(path.join(folder, '说明.md'), 'not a mindmap');
  await fs.mkdir(path.join(folder, '.mindmap'));
  await fs.writeFile(path.join(folder, '.mindmap', '内部.mindmap'), JSON.stringify(createDocument('内部')));
  const library = await store.library();
  assert.deepEqual(library.entries.filter(entry => entry.kind === 'folder').map(entry => entry.name), ['项目2', '项目10']);
  const children = library.entries.find(entry => entry.path === folder).children;
  assert.equal(children[0].kind, 'folder');
  assert.equal(children[0].name, '资料');
  assert.deepEqual(children.filter(entry => entry.title).map(entry => entry.title), ['观点2', '观点10']);
  assert.equal(children.find(entry => entry.name === '损坏.mindmap').invalid, true);
  assert.ok(children.every(entry => path.isAbsolute(entry.path)));
  assert.ok(!children.some(entry => ['.mindmap', '说明.md'].includes(entry.name)));
  await fs.writeFile(path.join(folder, '外部新建.mindmap'), JSON.stringify(createDocument('外部新建')));
  assert.ok((await store.library()).entries.find(entry => entry.path === folder).children.some(entry => entry.title === '外部新建'));
});

test('moving an active map waits for queued saves, changes the session, and remains writable after restart', async t => {
  const { store, session, dir } = await storeFixture(t);
  await store.createFolder('研究');
  const folder = path.join(store.maps, '研究');
  const edited = addNode(session.doc, 'root').doc;
  const pendingSave = store.save(edited, session.token);
  const moving = store.moveLibraryItem(session.path, folder);
  await pendingSave;
  const result = await moving;
  const movedPath = path.join(folder, path.basename(session.path));
  assert.equal(result.session.path, movedPath);
  assert.notEqual(result.session.token, session.token);
  assert.deepEqual(result.session.doc, edited);
  await assert.rejects(fs.access(session.path), { code: 'ENOENT' });
  await assert.rejects(store.save(edited, session.token), /文件已切换/);
  const next = addNode(edited, 'root').doc;
  await store.save(next, result.session.token);
  const restarted = await new LocalStore(dir).boot();
  assert.equal(restarted.path, movedPath);
  assert.deepEqual(restarted.doc, next);
  assert.ok(!restarted.recent.some(item => item.path === session.path));
});

test('a completed active-file move returns its new session even when workspace metadata cannot be saved', async t => {
  const { store, session, dir } = await storeFixture(t);
  await store.createFolder('移动目标');
  const folder = path.join(store.maps, '移动目标');
  const remember = store.remember;
  store.remember = async () => { throw new Error('位置记录只读'); };
  const moved = await store.arrangeLibraryItem(session.path, folder, 'inside');
  assert.equal(moved.session.path, path.join(folder, path.basename(session.path)));
  assert.notEqual(moved.session.token, session.token);
  assert.match(moved.notice, /操作已完成.*位置记录/);
  assert.deepEqual(JSON.parse(await fs.readFile(moved.session.path, 'utf8')), session.doc);
  await assert.rejects(fs.access(session.path), { code: 'ENOENT' });
  store.remember = remember;
  const edited = addNode(moved.session.doc, 'root').doc;
  await store.save(edited, moved.session.token);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, edited);
});

test('moving and renaming folders updates descendant active, recent, and recovery paths', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('原目录');
  await store.createFolder('归档');
  const sourceFolder = path.join(store.maps, '原目录');
  await store.createFolder('子目录', sourceFolder);
  const first = await store.create(createDocument('第一张'), sourceFolder);
  const active = await store.create(createDocument('第二张'), path.join(sourceFolder, '子目录'));
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: active.path, doc: active.doc }));
  const moved = await store.moveLibraryItem(sourceFolder, path.join(store.maps, '归档'));
  const movedFolder = path.join(store.maps, '归档', '原目录');
  assert.equal(moved.session.path, path.join(movedFolder, '子目录', '第二张.mindmap'));
  assert.ok(moved.session.recent.some(item => item.path === path.join(movedFolder, path.basename(first.path))));
  assert.equal(JSON.parse(await fs.readFile(store.recoveryPath, 'utf8')).path, moved.session.path);
  const renamed = await store.renameLibraryItem(movedFolder, '整理后');
  assert.equal(renamed.session.path, path.join(store.maps, '归档', '整理后', '子目录', '第二张.mindmap'));
  assert.equal(renamed.session.doc.title, '第二张');
  assert.equal(JSON.parse(await fs.readFile(store.recoveryPath, 'utf8')).path, renamed.session.path);
  const restarted = await new LocalStore(dir).boot();
  assert.equal(restarted.path, renamed.session.path);
  assert.deepEqual(restarted.doc, active.doc);
  await assert.rejects(fs.access(sourceFolder), { code: 'ENOENT' });
});

test('renaming a map updates its title, keeps its root text, and backs up the original file', async t => {
  const { store, session, dir } = await storeFixture(t);
  const edited = structuredClone(session.doc);
  edited.nodes.root.text = '原来的中心主题\n保留内容';
  edited.title = '原来的名称';
  await store.save(edited, session.token);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: edited }));
  const renamed = await store.renameLibraryItem(session.path, '新的名称.mindmap');
  assert.equal(renamed.session.path, path.join(store.maps, '新的名称.mindmap'));
  assert.equal(renamed.session.doc.title, '新的名称');
  assert.equal(renamed.session.doc.nodes.root.text, edited.nodes.root.text);
  assert.notEqual(renamed.session.token, session.token);
  const backup = JSON.parse(await fs.readFile(path.join(dir, '.mindmap', 'backups', `${edited.id}.mindmap`), 'utf8'));
  assert.deepEqual(backup, edited);
  const recovery = JSON.parse(await fs.readFile(store.recoveryPath, 'utf8'));
  assert.equal(recovery.path, renamed.session.path);
  assert.equal(recovery.doc.title, '新的名称');
  const next = addNode(renamed.session.doc, 'root').doc;
  await store.save(next, renamed.session.token);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, next);
  const invalidPath = path.join(store.maps, '损坏.mindmap');
  await fs.writeFile(invalidPath, 'broken bytes');
  const invalidRenamed = await store.renameLibraryItem(invalidPath, '仍损坏');
  assert.equal(await fs.readFile(path.join(store.maps, '仍损坏.mindmap'), 'utf8'), 'broken bytes');
  assert.equal(invalidRenamed.library.entries.find(entry => entry.name === '仍损坏.mindmap').invalid, true);
});

test('library name conflicts and traversal attempts never overwrite or move existing data', async t => {
  const { store, session, dir } = await storeFixture(t);
  await store.createFolder('目标');
  const target = path.join(store.maps, '目标');
  const targetMap = await store.create(createDocument(), target);
  const original = await fs.readFile(session.path, 'utf8');
  const targetOriginal = await fs.readFile(targetMap.path, 'utf8');
  await assert.rejects(store.moveLibraryItem(session.path, target), /同名/);
  await assert.rejects(store.renameLibraryItem(targetMap.path, '../越界'), /名称/);
  await assert.rejects(store.createFolder('../越界'), /名称/);
  await assert.rejects(store.createFolder('目标'), /同名/);
  await assert.rejects(store.createFolder('库外', dir), /导图库内/);
  await assert.rejects(store.create(createDocument(), dir), /导图库内/);
  await assert.rejects(store.moveLibraryItem(session.path, dir), /导图库内/);
  await assert.rejects(store.moveLibraryItem(store.maps, target), /根目录/);
  await assert.rejects(store.renameLibraryItem(store.maps, '别名'), /根目录/);
  await store.createFolder('子目录', target);
  await assert.rejects(store.moveLibraryItem(target, target), /自身/);
  await assert.rejects(store.moveLibraryItem(target, path.join(target, '子目录')), /自身/);
  await assert.rejects(store.renameLibraryItem(target, '.mindmap'), /名称/);
  await store.createFolder('同级');
  await assert.rejects(store.renameLibraryItem(target, '同级'), /同名/);
  assert.equal(await fs.readFile(session.path, 'utf8'), original);
  assert.equal(await fs.readFile(targetMap.path, 'utf8'), targetOriginal);
});

test('library skips junctions and rejects operations through links to outside folders', async t => {
  const { store, session, dir } = await storeFixture(t);
  const outside = path.join(dir, '库外');
  await fs.mkdir(outside);
  const outsideMap = path.join(outside, '外部.mindmap');
  const original = JSON.stringify(createDocument('外部'));
  await fs.writeFile(outsideMap, original);
  const junction = path.join(store.maps, '链接');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(!(await store.library()).entries.some(entry => entry.path === junction));
  await assert.rejects(store.open(path.join(junction, '外部.mindmap')), /符号链接|目录联接/);
  await assert.rejects(store.createFolder('不能创建', junction), /符号链接|目录联接/);
  await assert.rejects(store.moveLibraryItem(session.path, junction), /符号链接|目录联接/);
  await assert.rejects(store.renameLibraryItem(junction, '新链接'), /符号链接|目录联接/);
  await assert.rejects(store.saveAs(session.doc, session.token, path.join(junction, '副本.mindmap')), /符号链接|目录联接/);
  assert.equal(await fs.readFile(outsideMap, 'utf8'), original);
  assert.deepEqual(await fs.readdir(outside), ['外部.mindmap']);
});

test('deleting another map recycles its bytes and preserves the active session', async t => {
  const { store, session, dir } = await storeFixture(t);
  const active = await store.create(createDocument('正在编辑'));
  const original = await fs.readFile(session.path, 'utf8');
  const { trash, items } = await simulatedTrash(dir);
  const result = await store.deleteLibraryItem(session.path, trash);
  assert.equal(result.session, undefined);
  assert.equal(store.snapshot().token, active.token);
  assert.deepEqual(store.snapshot().doc, active.doc);
  assert.equal(await fs.readFile(items[0].destination, 'utf8'), original);
  assert.ok(!result.library.entries.some(entry => entry.path === session.path));
  assert.ok(!store.snapshot().recent.some(item => item.path === session.path));
  assert.equal((await new LocalStore(dir).boot()).path, active.path);
});

test('deleting the active map waits for saves and stays empty despite other maps with the same title', async t => {
  const { store, session, dir } = await storeFixture(t);
  const survivorBytes = await fs.readFile(session.path, 'utf8');
  const active = await store.create(createDocument());
  const edited = addNode(active.doc, 'root').doc;
  const { trash, items } = await simulatedTrash(dir);
  const saving = store.save(edited, active.token);
  const deleting = store.deleteLibraryItem(active.path, trash);
  await saving;
  const result = await deleting;
  assert.equal(result.session.path, '');
  assert.equal(result.session.doc, null);
  assert.equal(result.session.token, '');
  assert.equal(store.current, null);
  assert.deepEqual(JSON.parse(await fs.readFile(items[0].destination, 'utf8')), edited);
  await assert.rejects(store.save(edited, active.token), /文件已切换/);
  assert.equal(await fs.readFile(session.path, 'utf8'), survivorBytes);
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.equal(restarted.snapshot().path, '');
  assert.equal((await restarted.open(session.path)).path, session.path);
});

test('a successful recycle returns an empty session when workspace recording fails with other maps remaining', async t => {
  const { store, session, dir } = await storeFixture(t);
  const active = await store.create(createDocument('待移除'));
  const { trash, items } = await simulatedTrash(dir);
  const remember = store.remember;
  store.remember = async () => { throw new Error('位置记录只读'); };
  const removed = await store.deleteLibraryItem(active.path, trash);
  assert.equal(removed.session.path, '');
  assert.equal(removed.session.doc, null);
  assert.equal(removed.session.token, '');
  assert.match(removed.notice, /已移入回收站.*位置记录/);
  assert.deepEqual(JSON.parse(await fs.readFile(items[0].destination, 'utf8')), active.doc);
  await assert.rejects(fs.access(active.path), { code: 'ENOENT' });
  store.remember = remember;
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
  assert.deepEqual((await restarted.open(session.path)).doc, session.doc);
});

test('recycling the last map stays empty when workspace recording fails and allows an explicit new map', async t => {
  const { store, session, dir } = await storeFixture(t);
  const { trash } = await simulatedTrash(dir);
  const remember = store.remember;
  store.remember = async () => { throw new Error('位置记录只读'); };
  const removed = await store.deleteLibraryItem(session.path, trash);
  assert.equal(removed.session.path, '');
  assert.equal(removed.session.doc, null);
  assert.equal(removed.library.entries.length, 0);
  assert.equal(removed.session.token, '');
  assert.match(removed.notice, /已移入回收站.*位置记录/);
  await assert.rejects(fs.access(session.path), { code: 'ENOENT' });
  store.remember = remember;
  assert.equal((await new LocalStore(dir).boot()).doc, null);
  assert.deepEqual(await fs.readdir(store.maps), []);
  const created = await store.create();
  const edited = addNode(created.doc, 'root', 'child', '继续记录').doc;
  await store.save(edited, created.token);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, edited);
});

test('deleting a folder removes descendant state and recovery without touching adjacent folders', async t => {
  const { store, session, dir } = await storeFixture(t);
  await store.createFolder('资料');
  await store.createFolder('资料2');
  const folder = path.join(store.maps, '资料');
  await store.createFolder('子目录', folder);
  const first = await store.create(createDocument('旧图'), folder);
  const active = await store.create(createDocument('当前图'), path.join(folder, '子目录'));
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: active.path, doc: addNode(active.doc, 'root').doc }));
  const { trash, items } = await simulatedTrash(dir);
  const result = await store.deleteLibraryItem(folder, trash);
  assert.equal(result.session.path, '');
  assert.equal(result.session.doc, null);
  assert.ok(!result.session.recent.some(item => [first.path, active.path].includes(item.path)));
  assert.equal(await fs.readFile(path.join(items[0].destination, '子目录', '当前图.mindmap'), 'utf8'), JSON.stringify(active.doc, null, 2));
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(store.maps, '资料2'))).isDirectory());
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
  assert.ok(!(await restarted.library()).entries.some(entry => entry.path === folder || entry.title?.includes('恢复')));
});

test('deleting the final map stays empty across restarts until a new map is explicitly created', async t => {
  const { store, session, dir } = await storeFixture(t);
  const { trash } = await simulatedTrash(dir);
  const removed = await store.deleteLibraryItem(session.path, trash);
  assert.equal(removed.library.entries.length, 0);
  assert.equal(removed.session.path, '');
  assert.equal(removed.session.doc, null);
  assert.equal(removed.session.token, '');
  await assert.rejects(store.save(session.doc, session.token), /文件已切换/);
  assert.deepEqual(await fs.readdir(store.maps), []);
  const workspace = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  assert.equal(workspace.current, null);
  assert.equal(workspace.draftOnly, false);
  assert.equal(workspace.emptyCanvas, true);
  assert.deepEqual(workspace.recent, []);

  const restarted = new LocalStore(dir);
  const empty = await restarted.boot();
  assert.equal(empty.path, '');
  assert.equal(empty.doc, null);
  assert.equal(empty.token, '');
  assert.deepEqual(await fs.readdir(store.maps), []);
  const collision = path.join(store.maps, '新的想法.mindmap');
  const collisionBytes = JSON.stringify(createDocument('已有文件'));
  await fs.writeFile(collision, collisionBytes);
  const created = await restarted.create(createDocument('新的想法'));
  assert.equal(created.path, path.join(store.maps, '新的想法 2.mindmap'));
  assert.ok(created.token);
  const edited = structuredClone(created.doc);
  edited.nodes.root.text = '新的想法';
  const saved = await restarted.save(edited, created.token);
  assert.equal(saved.path, path.join(store.maps, '新的想法 2.mindmap'));
  assert.equal(restarted.snapshot().token, created.token);
  assert.equal(await fs.readFile(collision, 'utf8'), collisionBytes);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), edited);
  const afterEdit = addNode(edited, 'root').doc;
  await restarted.save(afterEdit, created.token);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, afterEdit);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, 'utf8')).draftOnly, false);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, 'utf8')).emptyCanvas, false);
});

test('deleting an inactive map while the canvas is empty preserves the empty session', async t => {
  const { store, session, dir } = await storeFixture(t);
  const active = await store.create(createDocument('最后打开'));
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(active.path, trash);
  const result = await store.deleteLibraryItem(session.path, trash);
  assert.equal(result.session, undefined);
  assert.equal(store.snapshot().doc, null);
  assert.equal(store.snapshot().token, '');
  assert.deepEqual(await fs.readdir(store.maps), []);
  assert.equal((await new LocalStore(dir).boot()).doc, null);
});

test('a recovery cleanup failure cannot resurrect an explicitly deleted map on restart', async t => {
  const { store, session, dir } = await storeFixture(t);
  const active = await store.create(createDocument('已删除'));
  const pending = addNode(active.doc, 'root', 'child', '不应恢复').doc;
  const recoveryBytes = JSON.stringify({ path: active.path, doc: pending });
  await atomicWrite(store.recoveryPath, recoveryBytes);
  store.clearRecovery = async () => { throw new Error('恢复日志暂时无法删除'); };
  const { trash } = await simulatedTrash(dir);
  const removed = await store.deleteLibraryItem(active.path, trash);
  assert.equal(removed.session.doc, null);
  assert.match(removed.notice, /已移入回收站/);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recoveryBytes);
  assert.match(JSON.parse(await fs.readFile(store.statePath, 'utf8')).discardedRecoveryHash, /^[a-f0-9]{64}$/);

  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(session.path)]);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('an unreadable recovery journal stops deletion before recycling or changing the session', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '待保存内容').doc;
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: pending }));
  const snapshot = store.snapshot();
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const recovery = await fs.readFile(store.recoveryPath, 'utf8');
  const readFile = fs.readFile;
  fs.readFile = async (file, ...args) => {
    if (file === store.recoveryPath) throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    return readFile(file, ...args);
  };
  try {
    await assert.rejects(store.deleteLibraryItem(session.path, () => assert.fail('The file must not reach recycling.')), /恢复记录.*尚未删除/);
  } finally { fs.readFile = readFile; }
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
  assert.deepEqual((await new LocalStore(dir).boot()).doc.nodes, pending.nodes);
});

test('failure to persist deletion protection leaves the file and recovery untouched', async t => {
  const { store, session } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '待保存内容').doc;
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: pending }));
  const snapshot = store.snapshot();
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const recovery = await fs.readFile(store.recoveryPath, 'utf8');
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === store.deletionPath) throw Object.assign(new Error('guard write denied'), { code: 'EACCES' });
    return rename(source, target);
  };
  try {
    await assert.rejects(store.deleteLibraryItem(session.path, () => assert.fail('The file must not reach recycling.')), /保护恢复记录.*尚未删除/);
  } finally { fs.rename = rename; }
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
});

test('durable deletion protection prevents resurrection when journal cleanup and workspace recording both fail', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '不应恢复的已删除内容').doc;
  const recovery = JSON.stringify({ path: session.path, doc: pending });
  await atomicWrite(store.recoveryPath, recovery);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  store.clearRecovery = async () => { throw new Error('journal is locked'); };
  store.remember = async () => { throw new Error('workspace is locked'); };
  const { trash } = await simulatedTrash(dir);
  const removed = await store.deleteLibraryItem(session.path, trash);
  assert.equal(removed.session.doc, null);
  assert.match(removed.notice, /已移入回收站.*位置记录/);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.match(JSON.parse(await fs.readFile(store.deletionPath, 'utf8')).recoveryHash, /^[a-f0-9]{64}$/);
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.deepEqual(await fs.readdir(store.maps), []);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(store.deletionPath), { code: 'ENOENT' });
});

test('successful journal cleanup is deferred until the empty workspace can be recorded', async t => {
  const { store, session, dir } = await storeFixture(t);
  const recovery = JSON.stringify({ path: session.path, doc: addNode(session.doc, 'root').doc });
  await atomicWrite(store.recoveryPath, recovery);
  store.remember = async () => { throw new Error('workspace is locked'); };
  const { trash } = await simulatedTrash(dir);
  const removed = await store.deleteLibraryItem(session.path, trash);
  assert.equal(removed.session.doc, null);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  await fs.access(store.deletionPath);
  const replacement = JSON.stringify(createDocument('同路径新文件'));
  await fs.writeFile(session.path, replacement);
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.equal(await fs.readFile(session.path, 'utf8'), replacement);
  await assert.rejects(fs.access(store.deletionPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('a second active deletion cannot overwrite protection for a previously deleted map while metadata remains unavailable', async t => {
  const { store, session, dir } = await storeFixture(t);
  const recovery = JSON.stringify({ path: session.path, doc: addNode(session.doc, 'root', 'child', 'A不应复活').doc });
  await atomicWrite(store.recoveryPath, recovery);
  const workspace = await fs.readFile(store.statePath, 'utf8');
  store.remember = async () => { throw new Error('workspace remains locked'); };
  store.clearRecovery = async () => { throw new Error('journal remains locked'); };
  const { trash, items } = await simulatedTrash(dir);
  await store.deleteLibraryItem(session.path, trash);
  const guard = await fs.readFile(store.deletionPath, 'utf8');
  const second = await store.create(createDocument('B仍需保留'));
  const secondBytes = await fs.readFile(second.path, 'utf8');
  const active = store.snapshot();
  await assert.rejects(store.deleteLibraryItem(second.path, trash), /上次删除.*尚未删除/);
  assert.equal(items.length, 1, '第二张导图必须在调用回收站之前停止');
  assert.deepEqual(store.snapshot(), active);
  assert.equal(await fs.readFile(second.path, 'utf8'), secondBytes);
  assert.equal(await fs.readFile(store.deletionPath, 'utf8'), guard);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);

  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).doc, null);
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(second.path)]);
  assert.equal(await fs.readFile(second.path, 'utf8'), secondBytes);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
  await restarted.open(second.path);
  assert.equal((await restarted.deleteLibraryItem(second.path, trash)).session.doc, null);
  assert.equal(items.length, 2);
});

test('a fully saved active map protects the empty selection even without a recovery journal', async t => {
  const { store, session, dir } = await storeFixture(t);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
  const original = await fs.readFile(session.path, 'utf8');
  const snapshot = store.snapshot();
  const { trash, items } = await simulatedTrash(dir);
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === store.deletionPath) throw new Error('guard write denied');
    return rename(source, target);
  };
  try { await assert.rejects(store.deleteLibraryItem(session.path, trash), /尚未删除/); }
  finally { fs.rename = rename; }
  assert.equal(items.length, 0);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(session.path, 'utf8'), original);

  store.remember = async () => { throw new Error('workspace is locked'); };
  const removed = await store.deleteLibraryItem(session.path, trash);
  assert.equal(removed.session.doc, null);
  assert.equal(JSON.parse(await fs.readFile(store.deletionPath, 'utf8')).recoveryHash, null);
  const replacement = JSON.stringify(createDocument('不应自动打开的新实体'));
  await fs.writeFile(session.path, replacement);
  assert.equal((await new LocalStore(dir).boot()).doc, null);
  assert.equal(await fs.readFile(session.path, 'utf8'), replacement);
  await assert.rejects(fs.access(store.deletionPath), { code: 'ENOENT' });
});

test('deletion protection survives repeated failed startup records even when the journal disappears independently', async t => {
  const { store, session, dir } = await storeFixture(t);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: addNode(session.doc, 'root').doc }));
  const workspace = await fs.readFile(store.statePath, 'utf8');
  store.remember = async () => { throw new Error('workspace is locked'); };
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(session.path, trash);
  const guard = await fs.readFile(store.deletionPath, 'utf8');
  const replacement = JSON.stringify(createDocument('外部重建文件'));
  await fs.writeFile(session.path, replacement);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) await fs.rename(store.recoveryPath, path.join(dir, 'removed-recovery-fixture.json'));
    const restarted = new LocalStore(dir);
    restarted.remember = async () => { throw new Error('workspace is still locked'); };
    const result = await restarted.boot();
    assert.equal(result.doc, null);
    assert.match(result.notice, /位置记录/);
    assert.equal(await fs.readFile(store.deletionPath, 'utf8'), guard);
    assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
    assert.equal(await fs.readFile(session.path, 'utf8'), replacement);
  }
  assert.equal((await new LocalStore(dir).boot()).doc, null);
  assert.equal(await fs.readFile(session.path, 'utf8'), replacement);
  await assert.rejects(fs.access(store.deletionPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(session.path)]);
});

test('failed recycling and failed guard rollback keep pending edits recoverable from the original entry', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '回收失败后仍需恢复').doc;
  const recovery = JSON.stringify({ path: session.path, doc: pending });
  await atomicWrite(store.recoveryPath, recovery);
  const snapshot = store.snapshot();
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const rm = fs.rm;
  fs.rm = async (file, ...args) => {
    if (file === store.deletionPath) throw Object.assign(new Error('rollback denied'), { code: 'EACCES' });
    return rm(file, ...args);
  };
  try {
    await assert.rejects(store.deleteLibraryItem(session.path, async () => { throw new Error('回收站不可用'); }), /回收站不可用/);
  } finally { fs.rm = rm; }
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  await fs.access(store.deletionPath);
  const restored = await new LocalStore(dir).boot();
  assert.match(restored.notice, /恢复/);
  assert.deepEqual(restored.doc.nodes, pending.nodes);
  assert.notEqual(restored.path, session.path);
  assert.deepEqual(JSON.parse(await fs.readFile(session.path, 'utf8')), session.doc);
  await assert.rejects(fs.access(store.deletionPath), { code: 'ENOENT' });
});

test('a replaced deleted path stays unselected when its pre-delete workspace could not be updated', async t => {
  const { store, session, dir } = await storeFixture(t);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: addNode(session.doc, 'root').doc }));
  store.clearRecovery = async () => { throw new Error('journal is locked'); };
  store.remember = async () => { throw new Error('workspace is locked'); };
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(session.path, trash);
  const replacement = createDocument('外部重建的文件');
  const bytes = JSON.stringify(replacement, null, 2);
  await fs.writeFile(session.path, bytes);
  assert.equal((await new LocalStore(dir).boot()).doc, null);
  assert.equal(await fs.readFile(session.path, 'utf8'), bytes);
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(session.path)]);
});

test('a committed deletion guard survives a later failed recycle while an explicit same-path open remains selected', async t => {
  const { store, session, dir } = await storeFixture(t);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: addNode(session.doc, 'root').doc }));
  store.clearRecovery = async () => { throw new Error('journal is locked'); };
  store.remember = async () => { throw new Error('workspace is locked'); };
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(session.path, trash);
  const originalGuard = await fs.readFile(store.deletionPath, 'utf8');
  const replacement = createDocument('明确打开的新文件');
  replacement.nodes.root.text = '应该保留并打开的新内容';
  await fs.writeFile(session.path, JSON.stringify(replacement, null, 2));
  // Simulate a new session that explicitly opens the new entry while cleanup is pending.
  const current = new LocalStore(dir);
  await current.open(session.path);
  const rm = fs.rm;
  fs.rm = async (file, ...args) => {
    if (file === current.deletionPath) throw new Error('rollback denied');
    return rm(file, ...args);
  };
  try {
    await assert.rejects(current.deleteLibraryItem(session.path, async () => { throw new Error('再次回收失败'); }), /再次回收失败/);
  } finally { fs.rm = rm; }
  assert.equal(await fs.readFile(store.deletionPath, 'utf8'), originalGuard, '不可覆盖已经证明成功删除的保护记录');
  const restarted = await new LocalStore(dir).boot();
  assert.equal(restarted.path, session.path);
  assert.deepEqual(restarted.doc, replacement);
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(session.path)]);
  await assert.rejects(fs.access(store.recoveryPath), { code: 'ENOENT' });
});

test('unreadable or invalid deletion protection and unknown source identity stop recovery without changing files', async t => {
  const { store, session, dir } = await storeFixture(t);
  const pending = addNode(session.doc, 'root', 'child', '必须保留').doc;
  const recovery = JSON.stringify({ path: session.path, doc: pending });
  await atomicWrite(store.recoveryPath, recovery);
  const rm = fs.rm;
  fs.rm = async (file, ...args) => {
    if (file === store.deletionPath) throw new Error('rollback denied');
    return rm(file, ...args);
  };
  try { await assert.rejects(store.deleteLibraryItem(session.path, async () => { throw new Error('回收失败'); }), /回收失败/); }
  finally { fs.rm = rm; }
  const guard = await fs.readFile(store.deletionPath, 'utf8');
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const files = await fs.readdir(store.maps);
  for (const fault of ['guard-read', 'guard-json', 'source-stat']) {
    const readFile = fs.readFile, lstat = fs.lstat;
    if (fault === 'guard-json') await fs.writeFile(store.deletionPath, '{invalid');
    if (fault === 'guard-read') fs.readFile = async (file, ...args) => {
      if (file === store.deletionPath) throw Object.assign(new Error('guard read denied'), { code: 'EACCES' });
      return readFile(file, ...args);
    };
    if (fault === 'source-stat') fs.lstat = async (file, ...args) => {
      if (file === session.path) throw Object.assign(new Error('source stat denied'), { code: 'EACCES' });
      return lstat(file, ...args);
    };
    try { await assert.rejects(new LocalStore(dir).boot(), /无法核验删除恢复记录/); }
    finally { fs.readFile = readFile; fs.lstat = lstat; }
    assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
    assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
    assert.deepEqual(await fs.readdir(store.maps), files);
    if (fault === 'guard-json') await fs.writeFile(store.deletionPath, guard);
  }
  assert.deepEqual((await new LocalStore(dir).boot()).doc.nodes, pending.nodes);
});

test('the empty canvas and discarded journal marker still allow recovery of a newer document', async t => {
  const { store, session, dir } = await storeFixture(t);
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: session.doc }));
  store.clearRecovery = async () => { throw new Error('恢复日志暂时无法删除'); };
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(session.path, trash);

  const newer = createDocument('后续未完成保存');
  newer.nodes.root.text = '需要保留的新内容';
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: path.join(store.maps, '后续.mindmap'), doc: newer }));
  const restarted = new LocalStore(dir);
  const recovered = await restarted.boot();
  assert.match(recovered.notice, /恢复/);
  assert.deepEqual(recovered.doc.nodes, newer.nodes);
  assert.notEqual(recovered.doc.id, newer.id);
  assert.notEqual(recovered.path, session.path);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, 'utf8')).emptyCanvas, false);
  assert.equal((await restarted.library()).entries.length, 1);
});

test('legacy draftOnly workspaces remain editable without opening another library map', async t => {
  const { store, session, dir } = await storeFixture(t);
  const original = await fs.readFile(session.path, 'utf8');
  await atomicWrite(store.statePath, JSON.stringify({ current: null, recent: [], draftOnly: true }));
  const restarted = new LocalStore(dir);
  const draft = await restarted.boot();
  assert.equal(draft.path, '');
  assert.ok(draft.token);
  assert.equal(draft.doc.nodes.root.text, '');
  assert.notEqual(draft.doc.id, session.doc.id);
  assert.deepEqual(await fs.readdir(store.maps), [path.basename(session.path)]);
  const edited = addNode(draft.doc, 'root', 'child', '继续草稿').doc;
  const saved = await restarted.save(edited, draft.token);
  assert.notEqual(saved.path, '');
  assert.notEqual(saved.path, session.path);
  assert.equal(await fs.readFile(session.path, 'utf8'), original);
  assert.deepEqual((await new LocalStore(dir).boot()).doc, edited);
});

test('recycle failure preserves file, recovery, workspace, and active token', async t => {
  const { store, session } = await storeFixture(t);
  const snapshot = store.snapshot();
  await atomicWrite(store.recoveryPath, JSON.stringify({ path: session.path, doc: session.doc }));
  const original = await fs.readFile(session.path, 'utf8');
  const workspace = await fs.readFile(store.statePath, 'utf8');
  const recovery = await fs.readFile(store.recoveryPath, 'utf8');
  await assert.rejects(store.deleteLibraryItem(session.path, async () => { throw new Error('回收站不可用'); }), /回收站不可用/);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(session.path, 'utf8'), original);
  assert.equal(await fs.readFile(store.statePath, 'utf8'), workspace);
  assert.equal(await fs.readFile(store.recoveryPath, 'utf8'), recovery);
  await store.save(addNode(session.doc, 'root').doc, session.token);
});

test('remaining invalid maps do not prevent an empty canvas after the last valid map is deleted', async t => {
  const { store, session, dir } = await storeFixture(t);
  await fs.writeFile(path.join(store.maps, '损坏.mindmap'), '{broken');
  const { trash } = await simulatedTrash(dir);
  const result = await store.deleteLibraryItem(session.path, trash);
  assert.equal(result.session.path, '');
  assert.equal(result.session.doc, null);
  assert.equal(result.library.entries.length, 1);
  assert.equal(result.library.entries[0].invalid, true);
  assert.equal((await new LocalStore(dir).boot()).doc, null);
  assert.deepEqual(await fs.readdir(store.maps), ['损坏.mindmap']);
});

test('deletion rejects the library root, outside paths, and junctions before calling trash', async t => {
  const { store, dir } = await storeFixture(t);
  const outside = path.join(dir, '库外');
  await fs.mkdir(outside);
  const external = path.join(outside, '外部.mindmap');
  const bytes = JSON.stringify(createDocument('外部'));
  await fs.writeFile(external, bytes);
  const link = path.join(store.maps, '链接');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const trash = () => assert.fail('Rejected paths must never reach the recycle operation.');
  await assert.rejects(store.deleteLibraryItem(store.maps, trash), /根目录/);
  await assert.rejects(store.deleteLibraryItem(external, trash), /导图库内/);
  await assert.rejects(store.deleteLibraryItem(link, trash), /符号链接|目录联接/);
  await assert.rejects(store.deleteLibraryItem(path.join(link, '外部.mindmap'), trash), /符号链接|目录联接/);
  assert.equal(await fs.readFile(external, 'utf8'), bytes);
});

test('default library ordering groups folders first and sorts display titles by pinyin and natural English numbers', async t => {
  const { store } = await storeFixture(t);
  await store.createFolder('排序');
  const folder = path.join(store.maps, '排序');
  for (const name of ['中国', '北京', '阿尔法', 'Item10', 'Item2']) await store.createFolder(name, folder);
  const titles = ['Item10', '中国', 'Item2', '北京', '阿尔法'];
  for (let index = 0; index < titles.length; index++) {
    const session = await store.create(createDocument(`底层文件${index}`), folder);
    const doc = structuredClone(session.doc);
    doc.title = titles[index];
    await store.save(doc, session.token);
  }
  const entries = childrenAt(await store.library(), folder);
  assert.deepEqual(entries.map(entry => entry.kind), [...Array(5).fill('folder'), ...Array(5).fill('map')]);
  assert.deepEqual(entries.filter(entry => entry.kind === 'folder').map(entry => entry.name), ['阿尔法', '北京', '中国', 'Item2', 'Item10']);
  assert.deepEqual(entries.filter(entry => entry.kind === 'map').map(entry => entry.title), ['阿尔法', '北京', '中国', 'Item2', 'Item10']);
  assert.deepEqual(entries.filter(entry => entry.kind === 'map').map(entry => entry.name), ['底层文件4.mindmap', '底层文件3.mindmap', '底层文件1.mindmap', '底层文件2.mindmap', '底层文件0.mindmap']);
});

test('same-level manual order can mix maps and folders, survives edits and restart, and appends new items in default order', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('排序');
  const folder = path.join(store.maps, '排序');
  await store.createFolder('分类', folder);
  const a = await store.create(createDocument('A'), folder);
  const b = await store.create(createDocument('B'), folder);
  const c = await store.create(createDocument('C'), folder);
  const bytes = await Promise.all([a, b, c].map(item => fs.readFile(item.path, 'utf8')));
  const first = await store.arrangeLibraryItem(c.path, path.join(folder, '分类'), 'before');
  assert.equal(first.session, undefined);
  const sorted = await store.arrangeLibraryItem(a.path, b.path, 'after');
  assert.deepEqual(labelsAt(sorted.library, folder), ['C', '分类', 'B', 'A']);
  assert.equal(store.snapshot().token, c.token);
  assert.deepEqual(await Promise.all([a, b, c].map(item => fs.readFile(item.path, 'utf8'))), bytes);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['A.mindmap', 'B.mindmap', 'C.mindmap', '分类'].sort());
  const edited = structuredClone(c.doc);
  edited.title = '新的显示名称';
  await store.save(edited, c.token);
  assert.deepEqual(labelsAt(await store.library(), folder), ['新的显示名称', '分类', 'B', 'A']);
  const restarted = new LocalStore(dir);
  await restarted.boot();
  assert.deepEqual(labelsAt(await restarted.library(), folder), ['新的显示名称', '分类', 'B', 'A']);
  await restarted.create(createDocument('AA'), folder);
  await restarted.createFolder('AA目录', folder);
  await restarted.create(createDocument('A0'), folder);
  assert.deepEqual(labelsAt(await restarted.library(), folder), ['新的显示名称', '分类', 'B', 'A', 'AA目录', 'A0', 'AA']);
  const ordering = JSON.parse(await fs.readFile(store.orderPath, 'utf8'));
  assert.deepEqual(Object.keys(ordering.folders), ['排序']);
  assert.ok(ordering.folders['排序'].every(item => !item.name.includes('\\') && item.identity));
});

test('cross-folder arrangement and folder renames retain descendant manual order and the writable active session', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('来源');
  await store.createFolder('目标');
  const source = path.join(store.maps, '来源'), target = path.join(store.maps, '目标');
  await store.createFolder('子目录', source);
  const child = path.join(source, '子目录');
  const a = await store.create(createDocument('A'), child);
  const b = await store.create(createDocument('B'), child);
  await store.arrangeLibraryItem(b.path, a.path, 'before');
  const t1 = await store.create(createDocument('T1'), target);
  const t2 = await store.create(createDocument('T2'), target);
  await store.arrangeLibraryItem(t2.path, t1.path, 'before');
  const active = await store.open(b.path);
  const moved = await store.arrangeLibraryItem(source, t1.path, 'before');
  const movedFolder = path.join(target, '来源');
  assert.deepEqual(labelsAt(moved.library, target), ['T2', '来源', 'T1']);
  assert.deepEqual(labelsAt(moved.library, path.join(movedFolder, '子目录')), ['B', 'A']);
  assert.equal(moved.session.path, path.join(movedFolder, '子目录', 'B.mindmap'));
  assert.notEqual(moved.session.token, active.token);
  await assert.rejects(store.save(active.doc, active.token), /文件已切换/);
  const renamed = await store.renameLibraryItem(movedFolder, '归档');
  assert.deepEqual(labelsAt(renamed.library, target), ['T2', '归档', 'T1']);
  assert.deepEqual(labelsAt(renamed.library, path.join(target, '归档', '子目录')), ['B', 'A']);
  await store.save(addNode(renamed.session.doc, 'root').doc, renamed.session.token);
  const returned = await store.arrangeLibraryItem(path.join(target, '归档'), store.maps, 'inside');
  assert.equal(labelsAt(returned.library, store.maps).at(-1), '归档');
  assert.deepEqual(labelsAt(returned.library, path.join(store.maps, '归档', '子目录')), ['B', 'A']);
  const restarted = new LocalStore(dir);
  assert.equal((await restarted.boot()).path, returned.session.path);
  assert.deepEqual(labelsAt(await restarted.library(), path.join(store.maps, '归档', '子目录')), ['B', 'A']);
  const order = JSON.parse(await fs.readFile(store.orderPath, 'utf8')).folders;
  assert.ok(Object.hasOwn(order, '归档/子目录'));
  assert.ok(!Object.keys(order).some(key => key.startsWith('来源/') || key.startsWith('目标/来源/') || key.startsWith('目标/归档/')));
});

test('renaming, moving, and deleting manually ordered maps maintains positions without stale path reuse', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('排序');
  const folder = path.join(store.maps, '排序');
  const a = await store.create(createDocument('A'), folder);
  const b = await store.create(createDocument('B'), folder);
  const c = await store.create(createDocument('C'), folder);
  await store.arrangeLibraryItem(c.path, a.path, 'before');
  const renamed = await store.renameLibraryItem(c.path, 'Z');
  assert.deepEqual(labelsAt(renamed.library, folder), ['Z', 'A', 'B']);
  await store.moveLibraryItem(b.path, store.maps);
  assert.deepEqual(labelsAt(await store.library(), folder), ['Z', 'A']);
  await store.moveLibraryItem(path.join(store.maps, 'B.mindmap'), folder);
  assert.deepEqual(labelsAt(await store.library(), folder), ['Z', 'A', 'B']);
  const { trash } = await simulatedTrash(dir);
  await store.deleteLibraryItem(path.join(folder, 'Z.mindmap'), trash);
  await store.create(createDocument('Z'), folder);
  assert.deepEqual(labelsAt(await store.library(), folder), ['A', 'B', 'Z']);
  await store.arrangeLibraryItem(path.join(folder, 'Z.mindmap'), a.path, 'before');
  await fs.rename(path.join(folder, 'Z.mindmap'), path.join(dir, 'externally-moved.mindmap'));
  await store.create(createDocument('Z'), folder);
  assert.deepEqual(labelsAt(await store.library(), folder), ['A', 'B', 'Z']);
  await store.renameLibraryItem(path.join(folder, 'Z.mindmap'), 'AA');
  assert.deepEqual(labelsAt(await store.library(), folder), ['A', 'B', 'AA']);
});

test('folder identity distinguishes recreated names and prototype-like folder names persist safely', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('__proto__');
  const folder = path.join(store.maps, '__proto__');
  await store.createFolder('Z', folder);
  const a = await store.create(createDocument('A'), folder);
  await store.arrangeLibraryItem(path.join(folder, 'Z'), a.path, 'before');
  assert.deepEqual(labelsAt(await store.library(), folder), ['Z', 'A']);
  const restarted = new LocalStore(dir);
  await restarted.boot();
  assert.deepEqual(labelsAt(await restarted.library(), folder), ['Z', 'A']);
  await fs.rename(path.join(folder, 'Z'), path.join(dir, 'old-Z'));
  await restarted.createFolder('Z', folder);
  assert.deepEqual(labelsAt(await restarted.library(), folder), ['A', 'Z']);
  assert.ok(Object.hasOwn(JSON.parse(await fs.readFile(store.orderPath, 'utf8')).folders, '__proto__'));
});

test('arrangement rejects collisions, cycles, invalid targets and outside paths without changing order or session', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('来源');
  await store.createFolder('目标');
  const source = path.join(store.maps, '来源'), target = path.join(store.maps, '目标');
  await store.createFolder('子目录', source);
  const a = await store.create(createDocument('A'), source);
  const conflict = await store.create(createDocument('A'), target);
  const b = await store.create(createDocument('B'), target);
  await store.arrangeLibraryItem(b.path, conflict.path, 'before');
  const order = await fs.readFile(store.orderPath, 'utf8');
  const session = store.snapshot();
  const bytes = await Promise.all([a, conflict].map(item => fs.readFile(item.path, 'utf8')));
  await assert.rejects(store.arrangeLibraryItem(a.path, conflict.path, 'before'), /同名/);
  await assert.rejects(store.arrangeLibraryItem(source, source, 'inside'), /自身/);
  await assert.rejects(store.arrangeLibraryItem(source, path.join(source, '子目录'), 'inside'), /自身/);
  await assert.rejects(store.arrangeLibraryItem(source, a.path, 'before'), /自身/);
  await assert.rejects(store.arrangeLibraryItem(store.maps, target, 'inside'), /根目录/);
  await assert.rejects(store.arrangeLibraryItem(a.path, store.maps, 'before'), /根目录/);
  await assert.rejects(store.arrangeLibraryItem(a.path, b.path, 'inside'), /有效/);
  await assert.rejects(store.arrangeLibraryItem(a.path, dir, 'inside'), /导图库内/);
  await assert.rejects(store.arrangeLibraryItem(a.path, target, 'sideways'), /位置/);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  const link = path.join(store.maps, '链接');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.arrangeLibraryItem(a.path, link, 'inside'), /符号链接|目录联接/);
  assert.equal(await fs.readFile(store.orderPath, 'utf8'), order);
  assert.deepEqual(store.snapshot(), session);
  assert.deepEqual(await Promise.all([a, conflict].map(item => fs.readFile(item.path, 'utf8'))), bytes);
});

test('ordering metadata failure keeps same-level order and returns the valid new session after a real move', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('目标');
  const folder = path.join(store.maps, '目标');
  const a = await store.create(createDocument('A'), folder);
  const b = await store.create(createDocument('B'), folder);
  await store.arrangeLibraryItem(b.path, a.path, 'before');
  const source = await store.create(createDocument('移动我'));
  const order = await fs.readFile(store.orderPath, 'utf8');
  const saveOrder = store.saveOrder;
  store.saveOrder = async () => { throw new Error('排序文件只读'); };
  await assert.rejects(store.arrangeLibraryItem(a.path, b.path, 'before'), /只读/);
  assert.deepEqual(labelsAt(await store.library(), folder), ['B', 'A']);
  assert.equal(await fs.readFile(store.orderPath, 'utf8'), order);
  const moved = await store.arrangeLibraryItem(source.path, b.path, 'before');
  assert.match(moved.notice, /文件已移动.*排序未能保存/);
  assert.equal(moved.session.path, path.join(folder, '移动我.mindmap'));
  assert.notEqual(moved.session.token, source.token);
  await assert.rejects(fs.access(source.path), { code: 'ENOENT' });
  await store.save(addNode(moved.session.doc, 'root').doc, moved.session.token);
  store.saveOrder = saveOrder;
  assert.equal((await new LocalStore(dir).boot()).path, moved.session.path);
});

test('a target disappearing after relocation still returns the moved active session', async t => {
  const { store, dir } = await storeFixture(t);
  await store.createFolder('目标');
  const folder = path.join(store.maps, '目标');
  const target = await store.create(createDocument('目标图'), folder);
  const source = await store.create(createDocument('移动我'));
  const relocate = store.relocate.bind(store);
  store.relocate = async (...args) => {
    const result = await relocate(...args);
    await fs.rename(target.path, path.join(dir, 'externally-moved-target.mindmap'));
    return result;
  };
  const moved = await store.arrangeLibraryItem(source.path, target.path, 'before');
  assert.match(moved.notice, /文件已移动.*排序未能保存/);
  assert.equal(moved.session.path, path.join(folder, '移动我.mindmap'));
  await store.save(addNode(moved.session.doc, 'root').doc, moved.session.token);
  assert.equal((await new LocalStore(dir).boot()).path, moved.session.path);
});

test('images and manual column widths survive autosave, backups, rename, move, save-as, and recovery', async t => {
  const { store, session, dir } = await storeFixture(t);
  const doc = structuredClone(session.doc);
  doc.columnWidths = { 0: 440, 1: 600 };
  doc.nodes.root.images = [storageImage('firstImage'), storageImage('secondImage')];
  await store.save(doc, session.token);
  const edited = addNode(doc, 'root').doc;
  await store.save(edited, session.token);
  const backup = JSON.parse(await fs.readFile(path.join(dir, '.mindmap', 'backups', doc.id + '.mindmap'), 'utf8'));
  assert.deepEqual(backup.nodes.root.images, doc.nodes.root.images);
  assert.deepEqual(backup.columnWidths, doc.columnWidths);
  await store.createFolder('图片');
  const renamed = await store.renameLibraryItem(session.path, '图片笔记');
  assert.deepEqual(renamed.session.doc.nodes.root.images, doc.nodes.root.images);
  const moved = await store.moveLibraryItem(renamed.session.path, path.join(store.maps, '图片'));
  assert.deepEqual(moved.session.doc.columnWidths, doc.columnWidths);
  const copied = await store.saveAs(moved.session.doc, moved.session.token, path.join(store.maps, '图片副本.mindmap'));
  const copyDoc = JSON.parse(await fs.readFile(copied.path, 'utf8'));
  assert.notEqual(copyDoc.id, moved.session.doc.id);
  assert.deepEqual(copyDoc.nodes, moved.session.doc.nodes);
  assert.deepEqual(copyDoc.columnWidths, moved.session.doc.columnWidths);
  const restarted = new LocalStore(dir);
  const reopened = await restarted.boot();
  assert.deepEqual(reopened.doc, moved.session.doc);
  assert.equal(reopened.path, moved.session.path);
  const pending = structuredClone(reopened.doc);
  pending.nodes.root.images[0].width = 300;
  pending.columnWidths[1] = 720;
  const external = structuredClone(reopened.doc);
  external.title = '外部编辑';
  await atomicWrite(reopened.path, JSON.stringify(external));
  await assert.rejects(restarted.save(pending, reopened.token), /其他地方/);
  const recovered = await new LocalStore(dir).boot();
  assert.ok(recovered.notice.includes('恢复'));
  assert.deepEqual(recovered.doc.nodes.root.images, pending.nodes.root.images);
  assert.deepEqual(recovered.doc.columnWidths, pending.columnWidths);
  assert.deepEqual(JSON.parse(await fs.readFile(reopened.path, 'utf8')), external);
});

test('image documents larger than the former 20 MiB limit remain listed, renamable, and reopenable', async t => {
  const { store, session, dir } = await storeFixture(t);
  const payload = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from(storagePng.split(',')[1], 'base64').copy(payload);
  const dataUrl = 'data:image/png;base64,' + payload.toString('base64');
  const doc = structuredClone(session.doc);
  doc.columnWidths = { 0: 420 };
  doc.nodes.root.images = [storageImage('large1', dataUrl), storageImage('large2', dataUrl), storageImage('large3', dataUrl)];
  await store.save(doc, session.token);
  assert.ok((await fs.stat(session.path)).size > 20 * 1024 * 1024);
  const entry = (await store.library()).entries.find(item => item.path === session.path);
  assert.equal(entry.invalid, undefined);
  const renamed = await store.renameLibraryItem(session.path, '大图片笔记');
  assert.equal(renamed.session.doc.title, '大图片笔记');
  assert.equal(renamed.session.doc.nodes.root.images.length, 3);
  assert.equal(renamed.session.doc.nodes.root.images[0].dataUrl, dataUrl);
  const reopened = await new LocalStore(dir).boot();
  assert.equal(reopened.path, renamed.session.path);
  assert.deepEqual(reopened.doc.columnWidths, { 0: 420 });
  assert.equal(reopened.doc.nodes.root.images[2].dataUrl, dataUrl);
});
