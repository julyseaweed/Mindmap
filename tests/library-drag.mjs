import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'library-drag-'));
const maps = path.join(home, '导图');
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
const errors = [];
const work = path.join(maps, '工作');
const reading = path.join(maps, '阅读');
const descendant = path.join(work, '子目录');
const alpha = path.join(maps, 'z-alpha.mindmap');
const zebra = path.join(maps, 'a-zebra.mindmap');
const collision = path.join(maps, '碰撞.mindmap');
const collisionTarget = path.join(work, '碰撞.mindmap');
const insideAlpha = path.join(work, 'z-inside.mindmap');
const activeFile = path.join(maps, 'm-current.mindmap');

const writeFixture = async (file, title, text) => {
  const doc = createDocument(title);
  doc.nodes.root.text = text;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
};
await fs.mkdir(descendant, { recursive: true });
await fs.mkdir(reading, { recursive: true });
await writeFixture(alpha, '阿尔法', '排序源甲的内容');
await writeFixture(zebra, '斑马', '排序源乙的内容');
await writeFixture(collision, '冲突来源', '碰撞时必须保留来源');
await writeFixture(collisionTarget, '冲突目标', '碰撞时必须保留目标');
await writeFixture(insideAlpha, '阿页', '子目录排序内容');
const activeDoc = await writeFixture(activeFile, '中心', '当前导图内容');
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: activeFile, recent: [{ path: activeFile, title: activeDoc.title, updatedAt: new Date().toISOString() }] }, null, 2));

const eventually = async (check, message, timeout = 12000) => {
  const until = Date.now() + timeout;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
};
const library = () => page.getByRole('complementary', { name: '导图库' });
const row = file => library().locator(`[data-library-path=${JSON.stringify(file)}]`);
const session = () => page.evaluate(() => window.inkmap.boot());
const snapshot = () => page.evaluate(() => window.inkmap.library());
const exists = file => fs.stat(file).then(() => true, () => false);
const topOrder = () => library().locator('.library-tree > .library-item > .library-row').evaluateAll(rows => rows.map(element => element.getAttribute('data-library-path')));
const childOrder = folder => row(folder).locator('..').locator(':scope > .library-children > .library-item > .library-row').evaluateAll(rows => rows.map(element => element.getAttribute('data-library-path')));
const expectOrder = async expected => eventually(async () => JSON.stringify(await topOrder()) === JSON.stringify(expected), `排序未更新为 ${expected.map(file => path.basename(file)).join(', ')}`);
const expectSelection = async selected => {
  assert.equal(await library().locator('.library-row.is-selected').count(), 1);
  assert.equal(await library().locator('.library-row.is-selected').getAttribute('data-library-path'), selected);
};
const openFolder = async folder => {
  const button = row(folder).locator('.library-entry');
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
};
const filesystemMaps = async (folder = maps) => {
  const found = {};
  const items = await fs.readdir(folder, { withFileTypes: true });
  for (const item of items) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) Object.assign(found, await filesystemMaps(file));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.mindmap')) found[path.relative(maps, file)] = await fs.readFile(file, 'utf8');
  }
  return found;
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  await library().waitFor();
  await row(activeFile).waitFor();
  await page.evaluate(() => {
    window.__libraryDragEvents = [];
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target.closest('[data-library-path]') : null;
      window.__libraryDragEvents.push({ type, target: target?.getAttribute('data-library-path'), x: event.clientX, y: event.clientY });
      if (window.__libraryDragEvents.length > 80) window.__libraryDragEvents.shift();
    }, true);
  });
};
const close = async () => {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭前未完成保存。')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
};

// Exercise native HTML drag events with real mouse movement, including the preview before release.
const dragRow = async (sourcePath, targetPath, position, valid = true) => {
  const source = row(sourcePath);
  const target = targetPath === maps ? library().locator('.library-scroll') : row(targetPath);
  await eventually(async () => await source.getAttribute('draggable') === 'true', '拖动源尚不可操作');
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox);
  const sourceX = sourceBox.x + Math.min(sourceBox.width * .5, 120);
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + Math.min(targetBox.width * .5, 120);
  const targetY = targetPath === maps ? targetBox.y + targetBox.height - 14 : targetBox.y + targetBox.height * (position === 'before' ? .1 : position === 'after' ? .9 : .5);
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 12, sourceY + 3, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 18 });
  // Entering a different row may only emit dragenter; moving inside it also emits dragover.
  await page.mouse.move(targetX + 1, targetY);
  await page.mouse.move(targetX, targetY);
  if (valid) {
    await eventually(async () => await target.getAttribute('data-drop-position') === position, `鼠标拖动 ${path.basename(sourcePath)} → ${path.basename(targetPath)} (${position}) 未显示正确放置位置`, 4000);
    await expectSelection(sourcePath);
  }
  await page.mouse.up();
  await page.locator('.app:not(.busy)').waitFor();
};
const assertCurrentUnchanged = async () => {
  const active = await session();
  assert.equal(active.path, activeFile);
  assert.equal(active.doc.id, activeDoc.id);
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), activeDoc.nodes.root.text);
};
const editCurrent = async text => {
  await page.locator('[data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  await page.keyboard.press('Control+Enter');
  await page.locator('.app[data-save-state="saved"]').waitFor();
  const active = await session();
  await eventually(async () => JSON.parse(await fs.readFile(active.path, 'utf8')).nodes.root.text === text, '移动当前文件后无法继续保存');
  assert.equal(await page.locator('.save-error, .app-error').count(), 0);
};

try {
  await launch();
  assert.equal(await page.evaluate(() => typeof window.inkmap.arrangeLibraryItem), 'function');
  const defaultOrder = [work, reading, alpha, zebra, collision, activeFile];
  await expectOrder(defaultOrder);
  await openFolder(work);
  assert.deepEqual(await childOrder(work), [descendant, insideAlpha, collisionTarget]);
  const originalMaps = await filesystemMaps();

  await dragRow(alpha, work, 'before');
  await expectOrder([alpha, work, reading, zebra, collision, activeFile]);
  await expectSelection(alpha);
  await assertCurrentUnchanged();
  await dragRow(zebra, alpha, 'after');
  const arranged = [alpha, zebra, work, reading, collision, activeFile];
  await expectOrder(arranged);
  await expectSelection(zebra);
  await assertCurrentUnchanged();
  assert.deepEqual(await filesystemMaps(), originalMaps, '手动排序不能改文件名或内容');

  await close();
  await launch();
  await expectOrder(arranged);
  assert.deepEqual(await filesystemMaps(), originalMaps);
  await assertCurrentUnchanged();

  // Invalid folder destinations do not mutate the tree or select/open a second item.
  await openFolder(work);
  const beforeInvalid = await snapshot();
  await dragRow(work, work, 'inside', false);
  await dragRow(work, descendant, 'inside', false);
  assert.deepEqual(await snapshot(), beforeInvalid);
  assert.equal(await exists(descendant), true);
  await expectSelection(work);
  await assertCurrentUnchanged();

  const sourceBytes = await fs.readFile(collision, 'utf8');
  const targetBytes = await fs.readFile(collisionTarget, 'utf8');
  await dragRow(collision, work, 'inside');
  await page.locator('.app-error').waitFor();
  assert.equal(await fs.readFile(collision, 'utf8'), sourceBytes);
  assert.equal(await fs.readFile(collisionTarget, 'utf8'), targetBytes);
  await expectSelection(collision);
  await assertCurrentUnchanged();
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();

  // A current file can move into a folder, keep saving, then return to blank space at the root.
  assert.equal(await row(reading).locator('.library-entry').getAttribute('aria-expanded'), 'false');
  await dragRow(activeFile, reading, 'inside');
  const movedCurrent = path.join(reading, path.basename(activeFile));
  await eventually(async () => (await session()).path === movedCurrent, '跨目录拖动后当前路径未更新');
  await row(movedCurrent).waitFor();
  assert.equal(await row(reading).locator('.library-entry').getAttribute('aria-expanded'), 'true');
  await expectSelection(movedCurrent);
  assert.equal(await exists(activeFile), false);
  await editCurrent('迁移后继续记录');
  await dragRow(movedCurrent, maps, 'inside');
  await eventually(async () => (await session()).path === activeFile, '空白区域未将导图移回顶层');
  await row(activeFile).waitFor();
  await expectSelection(activeFile);
  assert.equal(await exists(movedCurrent), false);
  await editCurrent('移回顶层后继续保存');

  await dragRow(reading, work, 'inside');
  const movedFolder = path.join(work, '阅读');
  await eventually(async () => await exists(movedFolder) && !await exists(reading), '文件夹没有移入目标目录');
  await row(movedFolder).waitFor();
  await expectSelection(movedFolder);
  assert.equal((await session()).path, activeFile);
  const finalOrder = [alpha, zebra, work, collision, activeFile];
  await expectOrder(finalOrder);
  await close();
  await launch();
  await expectOrder(finalOrder);
  assert.equal(await exists(movedFolder), true);
  assert.equal((await session()).doc.nodes.root.text, '移回顶层后继续保存');
  assert.equal(await page.locator('.save-error, .app-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, checks: ['folder-first pinyin title sorting at each level', 'real mouse before/after reorder', 'manual maps before folders', 'source-only selection without opening', 'file names and bytes unchanged', 'order survives restart', 'reject self and descendant drops', 'collision preserves both files', 'current file into folder and continued save', 'blank root drop', 'folder move', 'final restart'] }, null, 2));
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText().catch(() => ''));
    console.error(JSON.stringify(await page.evaluate(() => ({ events: window.__libraryDragEvents, rows: [...document.querySelectorAll('.library-row')].map(row => ({ path: row.getAttribute('data-library-path'), classes: row.className, drop: row.getAttribute('data-drop-position') })) })).catch(() => ({})), null, 2));
  }
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
