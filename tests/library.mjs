import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'library-'));
const maps = path.join(home, '导图');
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const errors = [];
let app;
let page;

const eventually = async (check, message, timeout = 12000) => {
  const until = Date.now() + timeout;
  let lastError;
  do {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
};
const state = async () => JSON.parse(await fs.readFile(path.join(home, '.mindmap', 'workspace.json'), 'utf8'));
const current = async () => { const workspace = await state(); return { path: workspace.current, doc: JSON.parse(await fs.readFile(workspace.current, 'utf8')) }; };
const exists = async file => fs.stat(file).then(() => true, () => false);
const library = () => page.getByRole('complementary', { name: '导图库' });
const entry = name => library().getByRole('button', { name, exact: true });
const assertSelection = async target => {
  const selected = library().locator('.library-row.is-selected');
  assert.equal(await selected.count(), target ? 1 : 0, '导图库只能高亮一个选中项');
  if (target) assert.equal(await selected.getAttribute('data-library-path'), target);
};
const clearSelection = async () => {
  const scroll = library().locator('.library-scroll');
  const box = await scroll.boundingBox();
  await scroll.click({ position: { x: box.width / 2, y: box.height - 10 } });
  await assertSelection(null);
};
const waitSaved = async () => {
  await page.locator('.app[data-save-state="saved"]').waitFor();
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  app.process().on('exit', (code, signal) => console.log(JSON.stringify({ electronExit: code, signal })));
  page = await app.firstWindow();
  page.on('crash', () => errors.push('renderer crashed'));
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  await library().waitFor();
  await library().locator('.library-scroll').waitFor();
  assert.equal(await library().locator('.library-root').count(), 0);
};
const close = async () => {
  if (!app) return;
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timeout;
  try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('应用没有完成保存并关闭。')), 12000); })]); }
  finally { clearTimeout(timeout); }
  await app.close().catch(() => {});
  app = null;
};
const createFolder = async name => {
  await library().getByRole('button', { name: '新建文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建文件夹', exact: true });
  await dialog.getByLabel('文件夹名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await entry(name).waitFor();
};
const openAction = async (name, action) => {
  await library().getByRole('button', { name: `更多操作：${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
};
const move = async (name, destination, excluded = []) => {
  await openAction(name, '移动到…');
  const dialog = page.getByRole('dialog', { name: '移动到', exact: true });
  const choices = dialog.getByLabel('文件夹', { exact: true });
  await choices.waitFor();
  const values = await choices.locator('option').evaluateAll(options => options.map(option => option.value));
  assert.ok(values.includes(destination), '移动目标必须存在于文件夹列表中');
  for (const folder of excluded) assert.ok(!values.includes(folder), `移动目的地不能包含${folder}`);
  await choices.selectOption(destination);
  await dialog.getByRole('button', { name: '移动', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
};
const rename = async (oldName, newName, folder = false) => {
  await openAction(oldName, '重命名');
  const dialog = page.getByRole('dialog', { name: '重命名', exact: true });
  await dialog.getByLabel(folder ? '文件夹名称' : '文件名', { exact: true }).fill(newName);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await entry(newName).waitFor();
};
const editRoot = async text => {
  await page.locator('[data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  await page.keyboard.press('Control+Enter');
  await waitSaved();
  await eventually(async () => (await current()).doc.nodes.root.text === text, '节点编辑没有保存');
};
const newMap = async (method, text, expectedFolder = maps) => {
  const previous = await current();
  if (method === 'menu') {
    await page.getByRole('button', { name: '文件菜单', exact: true }).click();
    await page.locator('.file-menu').getByRole('button', { name: /^新建导图/ }).click();
  } else if (method === 'shortcut') {
    // The shortcut also works with keyboard focus still in the selected library folder.
    await page.keyboard.press('Control+n');
  } else await library().getByRole('button', { name: '新建导图', exact: true }).click();
  const next = await eventually(async () => {
    const active = await current();
    return active.path !== previous.path && active;
  }, `${method}没有新建导图`);
  assert.equal(path.dirname(next.path), expectedFolder, `${method}新建导图必须写入对应目录`);
  await page.locator('.app:not(.busy)').waitFor();
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await editor.waitFor();
  assert.equal(await editor.inputValue(), '', `${method}新建导图的中心节点必须为空`);
  await eventually(async () => editor.evaluate(element => element === document.activeElement), `${method}新建导图必须自动聚焦中心节点`);
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Enter');
  await waitSaved();
  await entry(text).waitFor();
  await assertSelection(next.path);
  return next;
};

try {
  await launch();
  assert.equal(await page.getByText('最近打开', { exact: true }).count(), 0);
  assert.equal(await page.locator('.mind-node').count(), 1);

  await createFolder('阅读');
  const reading = path.join(maps, '阅读');
  assert.equal((await fs.stat(reading)).isDirectory(), true);
  await assertSelection(reading);
  const readingMap = await newMap('sidebar', '阅读笔记', reading);
  assert.equal((await current()).doc.nodes.root.text, '阅读笔记');
  const readingMapPath = readingMap.path;
  await assertSelection(readingMapPath);
  // With a map selected, the sidebar action creates its sibling in the same directory.
  await newMap('sidebar', '同目录记录', reading);
  await entry('阅读笔记').click();
  await eventually(async () => (await current()).path === readingMapPath, '未重新打开阅读笔记');

  await clearSelection();
  assert.equal((await current()).path, readingMapPath);
  // Clearing the selection sends the sidebar action back to the library root.
  await newMap('sidebar', '顶层记录');
  await clearSelection();
  await createFolder('工作');
  const work = path.join(maps, '工作');
  assert.equal((await fs.stat(work)).isDirectory(), true);
  await assertSelection(work);
  assert.equal(await library().locator('.library-row.is-current').evaluate(element => getComputedStyle(element).boxShadow), 'none');

  // File-menu and keyboard actions always use the top level, even with a folder selected.
  const menuMap = await newMap('menu', '菜单记录');
  await entry('工作').click();
  await assertSelection(work);
  const shortcutMap = await newMap('shortcut', '快捷键记录');
  await entry('阅读笔记').click();
  await eventually(async () => (await current()).path === readingMapPath, '未重新打开阅读笔记');
  await assertSelection(readingMapPath);

  // Context-menu targets do not replace the existing selection or open another map.
  const menuRow = library().locator('.library-row').filter({ has: page.getByRole('button', { name: '菜单记录', exact: true }) });
  await menuRow.click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  await assertSelection(readingMapPath);
  assert.equal((await current()).path, readingMapPath);
  await page.keyboard.press('Escape');
  await library().getByRole('button', { name: '更多操作：快捷键记录', exact: true }).click();
  await page.getByRole('menu').waitFor();
  await assertSelection(readingMapPath);
  assert.equal((await current()).path, readingMapPath);
  await page.keyboard.press('Escape');
  await entry('阅读笔记').click();
  await move('阅读笔记', work);
  const movedPath = path.join(work, path.basename(readingMap.path));
  await eventually(async () => (await current()).path === movedPath, '移动当前导图后路径未更新');
  await assertSelection(movedPath);
  assert.equal(await exists(readingMapPath), false);
  const savedText = '阅读笔记\n继续记录';
  await editRoot(savedText);
  await entry('阅读笔记 继续记录').waitFor();
  await rename('阅读笔记 继续记录', '研究笔记');
  const renamedPath = path.join(work, '研究笔记.mindmap');
  await eventually(async () => (await current()).path === renamedPath, '重命名后当前路径未更新');
  await assertSelection(renamedPath);
  assert.equal(await exists(movedPath), false);
  assert.equal((await current()).doc.title, '研究笔记');
  assert.equal((await current()).doc.nodes.root.text, savedText);
  assert.equal(await page.locator('.document-title').innerText(), '研究笔记');

  // Saving must not reopen a branch that the user deliberately collapsed.
  if (await entry('工作').getAttribute('aria-expanded') === 'true') await entry('工作').click();
  await assertSelection(work);
  assert.equal(await entry('工作').getAttribute('aria-expanded'), 'false');
  await editRoot(savedText + '\n保存后保持折叠');
  await library().getByRole('button', { name: '刷新导图库', exact: true }).click();
  await eventually(async () => (await current()).doc.nodes.root.text.endsWith('保存后保持折叠'), '折叠时保存失败');
  // Give the debounced file watcher and the explicit refresh time to deliver their snapshots.
  await page.waitForTimeout(500);
  assert.equal(await entry('工作').getAttribute('aria-expanded'), 'false');
  await entry('工作').click();
  await entry('研究笔记').waitFor();
  await assertSelection(work);
  await page.locator('[data-node-id="root"]').click();
  await page.keyboard.press('Control+0');
  await page.screenshot({ path: path.join(results, '07-library.png') });

  // A nested folder move excludes itself from the picker; renaming its parent also updates the active map.
  await move('阅读', work, [reading]);
  await assertSelection(work);
  assert.equal(await exists(reading), false);
  assert.equal((await fs.stat(path.join(work, '阅读'))).isDirectory(), true);
  await rename('工作', '工作资料', true);
  const renamedWork = path.join(maps, '工作资料');
  const finalPath = path.join(renamedWork, '研究笔记.mindmap');
  await eventually(async () => (await current()).path === finalPath, '父文件夹改名后未更新当前导图路径');
  await assertSelection(renamedWork);
  assert.equal(await entry('工作资料').getAttribute('aria-expanded'), 'true');
  assert.equal(await entry('研究笔记').isVisible(), true);
  assert.equal((await fs.stat(path.join(renamedWork, '阅读'))).isDirectory(), true);
  await editRoot(savedText);
  await close();
  await launch();
  assert.equal((await current()).path, finalPath);
  assert.equal((await current()).doc.nodes.root.text, savedText);
  assert.equal(await page.locator('.document-title').innerText(), '研究笔记');
  await entry('研究笔记').waitFor();

  // Files created outside the app appear through the watcher, without a manual refresh or picker.
  const externalFolder = path.join(maps, '外部资料');
  const externalPath = path.join(externalFolder, '外部记录.mindmap');
  const external = createDocument('外部记录');
  external.nodes.root.text = '来自本地文件夹';
  await fs.mkdir(externalFolder);
  await fs.writeFile(externalPath, JSON.stringify(external, null, 2), 'utf8');
  await entry('外部资料').waitFor({ timeout: 15000 });
  await entry('外部资料').click();
  await entry('外部记录').waitFor({ timeout: 15000 });
  await entry('外部记录').click();
  await eventually(async () => (await current()).path === externalPath, '导图库未直接打开外部文件');
  await page.waitForFunction(text => document.querySelector('[data-node-id="root"] .node-text')?.textContent === text, external.nodes.root.text);
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), external.nodes.root.text);
  const canvasBefore = await page.locator('.canvas').boundingBox();
  await library().getByRole('button', { name: '关闭导图库', exact: true }).click();
  await library().waitFor({ state: 'hidden' });
  const canvasAfter = await page.locator('.canvas').boundingBox();
  assert.ok(canvasAfter.width > canvasBefore.width + 200);
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  assert.equal(await page.getByText('最近打开', { exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, currentFile: externalPath, checks: ['flat library root', 'folder creation', 'sidebar new follows selected folder or map parent', 'sidebar new at root after clearing selection', 'top-level new via menu/CtrlN', 'single selection', 'blank clears selection', 'context target differs from current map', 'live title', 'move keeps selection', 'rename keeps selection', 'continue saving', 'preserve collapsed branches', 'nested folder move', 'parent rename', 'restart', 'external file watcher', 'direct open', 'hide sidebar', 'no recent files section'] }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(results, 'library-failure.png') }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
