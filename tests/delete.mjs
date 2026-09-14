import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'delete-'));
const maps = path.join(home, '导图');
const trash = path.join(home, 'test-trash');
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const errors = [];
let app;
let page;

const eventually = async (check, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
};
const exists = file => fs.stat(file).then(() => true, () => false);
const session = () => page.evaluate(() => window.inkmap.boot());
const library = () => page.getByRole('complementary', { name: '导图库' });
const rootText = () => page.locator('[data-node-id="root"] .node-text');
const noSaveErrors = async () => assert.equal(await page.locator('.app-error, .save-error').count(), 0);
const mapFiles = async (folder = maps) => {
  const files = [];
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) files.push(...await mapFiles(file));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.mindmap')) files.push(file);
  }
  return files;
};
const fixture = async (file, title, text) => {
  const doc = createDocument(title);
  doc.nodes.root.text = text;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
};

const firstFolder = path.join(maps, '第一组');
const secondFolder = path.join(maps, '第二组');
const firstFile = path.join(firstFolder, '同名.mindmap');
const secondFile = path.join(secondFolder, '同名.mindmap');
const unrelatedFile = path.join(maps, '待删.mindmap');
const firstDoc = await fixture(firstFile, '同名', '第一张的独立内容');
const secondDoc = await fixture(secondFile, '同名', '第二张的独立内容');
await fixture(unrelatedFile, '待删', '无关资料');
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({
  current: firstFile,
  recent: [firstFile, secondFile, unrelatedFile].map(file => ({ path: file, title: path.basename(file, '.mindmap'), updatedAt: new Date().toISOString() })),
}, null, 2));

const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  await library().waitFor();
  await library().locator('.library-scroll').waitFor();
  assert.equal(await library().locator('.library-root').count(), 0);
  // Replace the native trash operation with a reversible move strictly inside this test home.
  await app.evaluate(async ({ shell }, config) => {
    const fileSystem = process.getBuiltinModule('fs').promises;
    const paths = process.getBuiltinModule('path');
    const inside = (parent, target) => {
      const relative = paths.relative(parent, target);
      return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep));
    };
    const taskHome = paths.resolve(config.home);
    const mapRoot = paths.resolve(config.maps);
    const trashRoot = paths.resolve(config.trash);
    if (paths.dirname(mapRoot) !== taskHome || paths.dirname(trashRoot) !== taskHome || paths.basename(mapRoot) !== '导图' || paths.basename(trashRoot) !== 'test-trash') throw new Error('回收测试目录不在隔离路径内。');
    await fileSystem.mkdir(trashRoot, { recursive: true });
    const realMaps = await fileSystem.realpath(mapRoot);
    const realTrash = await fileSystem.realpath(trashRoot);
    const realHome = await fileSystem.realpath(taskHome);
    if (!inside(realHome, realMaps) || !inside(realHome, realTrash)) throw new Error('回收测试目录解析后超出隔离路径。');
    globalThis.__deleteTestTrash = [];
    shell.trashItem = async target => {
      const source = paths.resolve(target);
      if (!paths.isAbsolute(target) || source === mapRoot || !inside(mapRoot, source)) throw new Error('拒绝移动隔离导图库之外的文件。');
      const realSource = await fileSystem.realpath(source);
      if (realSource === realMaps || !inside(realMaps, realSource)) throw new Error('源路径解析后超出隔离导图库。');
      const destination = paths.resolve(trashRoot, `${Date.now()}-${globalThis.__deleteTestTrash.length}-${paths.basename(source)}`);
      if (!inside(trashRoot, destination) || paths.dirname(destination) !== trashRoot) throw new Error('回收目标超出测试目录。');
      await fileSystem.rename(source, destination);
      globalThis.__deleteTestTrash.push({ source, destination });
    };
  }, { home, maps, trash });
};
const close = async () => {
  if (!app) return;
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭时没有完成保存。')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
};
const deleteRow = async row => {
  const target = await row.getAttribute('data-library-path');
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  assert.equal(await library().locator('.library-row.is-selected').count(), 1);
  assert.equal(await library().locator('.library-row.is-selected').getAttribute('data-library-path'), target);
  assert.equal(await menu.getByRole('menuitem', { name: '重命名', exact: true }).count(), 1);
  assert.equal(await menu.getByRole('menuitem', { name: '移动到…', exact: true }).count(), 1);
  await menu.getByRole('menuitem', { name: '删除', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await page.locator('.app:not(.busy)').waitFor();
  await noSaveErrors();
};
const namedRow = label => library().locator('.library-row').filter({ has: page.getByRole('button', { name: label, exact: true }) });
const editRoot = async text => {
  await page.locator('[data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  await page.keyboard.press('Control+Enter');
  await page.locator('.app[data-save-state="saved"]').waitFor();
  await noSaveErrors();
};

try {
  await launch();
  assert.equal(await page.evaluate(() => typeof window.inkmap.deleteLibraryItem), 'function');
  await library().locator('.library-row.is-current').waitFor();
  assert.equal((await session()).doc.id, firstDoc.id);
  assert.equal(await rootText().innerText(), firstDoc.nodes.root.text);

  // Removing another map leaves both the active path and its canvas unchanged.
  await deleteRow(namedRow('待删'));
  await eventually(async () => !await exists(unrelatedFile), '非当前导图未删除');
  assert.equal((await session()).path, firstFile);
  assert.equal((await session()).doc.id, firstDoc.id);
  assert.equal(await rootText().innerText(), firstDoc.nodes.root.text);

  // The replacement has the same title and filename, but a different id and contents.
  await deleteRow(library().locator('.library-row.is-current'));
  await eventually(async () => (await session()).path === secondFile, '删除当前导图后未切换到剩余导图');
  await page.waitForFunction(text => document.querySelector('[data-node-id="root"] .node-text')?.textContent === text, secondDoc.nodes.root.text);
  assert.equal((await session()).doc.id, secondDoc.id);
  assert.equal(await page.locator('.document-title').innerText(), '同名');
  assert.equal(await exists(firstFile), false);
  assert.equal(await exists(secondFile), true);

  // Deleting the directory containing the current map enters an unsaved blank session.
  await deleteRow(namedRow('第二组'));
  await eventually(async () => !await exists(secondFolder), '含当前导图的文件夹未删除');
  assert.deepEqual(await mapFiles(), []);
  let draft = await session();
  assert.equal(Object.keys(draft.doc.nodes).length, 1);
  assert.equal(draft.doc.nodes[draft.doc.rootId].text, '');
  await deleteRow(namedRow('第一组'));
  assert.deepEqual(await fs.readdir(maps), []);
  await library().getByText('暂无导图', { exact: true }).waitFor();
  assert.equal(await library().locator('.library-row.is-selected').count(), 0);

  const removed = await app.evaluate(() => globalThis.__deleteTestTrash);
  assert.deepEqual(removed.map(item => item.source), [unrelatedFile, firstFile, secondFolder, firstFolder]);
  for (const item of removed) assert.equal(await exists(item.destination), true);
  const secondTrash = removed.find(item => item.source === secondFolder);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(secondTrash.destination, '同名.mindmap'), 'utf8')), secondDoc);
  await close();
  assert.deepEqual(await fs.readdir(maps), []);

  // Restarting an intentionally empty library must not create a placeholder on disk.
  await launch();
  assert.deepEqual(await fs.readdir(maps), []);
  draft = await session();
  assert.equal(draft.doc.nodes[draft.doc.rootId].text, '');
  await library().getByText('暂无导图', { exact: true }).waitFor();
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await editor.waitFor();
  await page.waitForFunction(() => {
    const editor = document.activeElement;
    return editor?.getAttribute('aria-label') === '编辑节点' && editor.selectionStart === 0 && editor.selectionEnd === editor.value.length;
  });
  const emptyScroll = library().locator('.library-scroll');
  const emptyScrollBox = await emptyScroll.boundingBox();
  await page.keyboard.insertText('重新开始');
  // Clear the selection while the first autosave is pending; its reply must not select the new file again.
  await emptyScroll.click({ position: { x: emptyScrollBox.width / 2, y: emptyScrollBox.height - 10 } });
  assert.equal(await library().locator('.library-row.is-selected').count(), 0);
  await page.locator('.app[data-save-state="saved"]').waitFor();
  const persisted = await eventually(async () => {
    const active = await session();
    if (!active.path || !await exists(active.path)) return false;
    const stored = JSON.parse(await fs.readFile(active.path, 'utf8'));
    return stored.nodes.root.text === '重新开始' && { ...active, stored };
  }, '空白会话输入后没有建立导图文件');
  assert.equal(path.dirname(persisted.path), maps);
  await library().locator('.library-row.is-current').waitFor();
  assert.equal(await library().locator('.library-row.is-selected').count(), 0, '首次保存不能抢回用户已清除的选择');
  assert.equal(await library().locator('.library-row.is-current .library-entry').getAttribute('title'), path.basename(persisted.path));
  await editRoot('重新开始\n第二次保存');
  await eventually(async () => JSON.parse(await fs.readFile(persisted.path, 'utf8')).nodes.root.text === '重新开始\n第二次保存', '持久化后未能继续保存');
  assert.equal((await session()).path, persisted.path);
  assert.deepEqual(await mapFiles(), [persisted.path]);
  await noSaveErrors();
  await close();
  await launch();
  assert.equal((await session()).path, persisted.path);
  assert.equal((await session()).doc.nodes.root.text, '重新开始\n第二次保存');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, reversibleTrash: trash, currentFile: persisted.path, checks: ['right-click actions', 'delete inactive map', 'switch to same-title map', 'delete active parent folder', 'empty draft', 'empty restart', 'first edit persists', 'continue saving', 'reopen persisted map'] }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(results, 'delete-failure.png') }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
