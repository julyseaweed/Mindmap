import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'sidebar-resize-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '调整宽度.mindmap');
const original = createDocument('调整宽度');
original.nodes.root.text = '保持内容';
original.nodes.root.children = ['first', 'second'];
original.nodes.first = { id: 'first', text: '第一条', children: [], collapsed: false };
original.nodes.second = { id: 'second', text: '第二条', children: [], collapsed: false };
await fs.mkdir(maps, { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [{ path: file, title: original.title, updatedAt: new Date().toISOString() }] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
const errors = [];
const separator = name => page.getByRole('separator', { name: `调整${name}宽度`, exact: true });
const panel = name => page.locator(name === '导图库' ? '.library-panel' : '.outline-panel');
const width = async name => (await panel(name).boundingBox()).width;
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1.5, `${message}: ${actual} ≠ ${expected}`);
const eventually = async (check, message, timeout = 10000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const expectWidth = async (name, expected) => {
  await separator(name).waitFor();
  await eventually(async () => Math.abs(await width(name) - expected) < 1.5, `${name}宽度未变为${expected}`);
  near(Number(await separator(name).getAttribute('aria-valuenow')), expected, '分隔条数值');
};
const assertDocument = async () => {
  assert.equal(await page.locator('.mind-node').count(), 3);
  assert.equal(await page.locator('.mind-node.selected').getAttribute('data-node-id'), 'root');
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), '保持内容');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
  assert.deepEqual(await fs.readdir(maps), ['调整宽度.mindmap']);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  await separator('导图库').waitFor();
};
const close = async () => {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成。')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
};
const show = async name => {
  await page.getByRole('button', { name: name === '导图库' ? '导图库' : '显示大纲', exact: true }).click();
  await separator(name).waitFor();
  assert.equal(await page.locator('.sidebar-resizer').count(), 1);
};
const beginDrag = async (name, delta) => {
  const handle = separator(name);
  await handle.evaluate(element => element.addEventListener('pointerdown', event => { window.__resizePointerId = event.pointerId; }, { once: true }));
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height * .55;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 12 });
  return { x, y, handle };
};
const drag = async (name, delta) => {
  const beforeWidth = await width(name);
  const beforeCanvas = (await page.locator('.canvas').boundingBox()).width;
  await beginDrag(name, delta);
  await page.mouse.up();
  await expectWidth(name, beforeWidth + delta);
  const afterCanvas = (await page.locator('.canvas').boundingBox()).width;
  near(beforeCanvas - afterCanvas, delta, '侧栏与画布应同步变化');
  await assertDocument();
};
const setWindow = async value => {
  const contentWidth = await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(size, 820);
    return window.getContentSize()[0];
  }, value);
  await eventually(async () => Math.abs(await page.evaluate(() => window.innerWidth) - contentWidth) < 3, '窗口内容尺寸未更新');
};

try {
  await launch();
  await expectWidth('导图库', 248);
  await setWindow(800);
  await expectWidth('导图库', 248);
  await setWindow(1260);
  await expectWidth('导图库', 248);

  await drag('导图库', 140);
  await drag('导图库', -40);
  await separator('导图库').focus();
  await page.keyboard.press('ArrowRight');
  await expectWidth('导图库', 358);
  await assertDocument();
  const libraryWidth = await width('导图库');

  await show('大纲');
  await expectWidth('大纲', 248);
  await drag('大纲', 150);
  await drag('大纲', -30);
  const outlineWidth = await width('大纲');
  near(outlineWidth, 368);
  await show('导图库');
  await expectWidth('导图库', libraryWidth);
  await assertDocument();

  // Escape cancels a captured gesture at the upper bound and stops subsequent movement.
  const styles = await page.evaluate(() => ({ cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect }));
  const upper = await beginDrag('导图库', 850);
  await expectWidth('导图库', 600);
  await page.keyboard.press('Escape');
  await expectWidth('导图库', libraryWidth);
  await page.mouse.move(upper.x + 70, upper.y + 2);
  await page.mouse.up();
  await expectWidth('导图库', libraryWidth);
  assert.deepEqual(await page.evaluate(() => ({ cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect })), styles);

  // A pointer cancellation also restores the original width and releases the gesture.
  const lower = await beginDrag('导图库', -300);
  await expectWidth('导图库', 200);
  const pointerId = await page.evaluate(() => window.__resizePointerId);
  await lower.handle.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true });
  await expectWidth('导图库', libraryWidth);
  await page.mouse.move(lower.x + 50, lower.y + 2);
  await page.mouse.up();
  await expectWidth('导图库', libraryWidth);
  await assertDocument();

  // A narrow window clamps both panels without replacing either in-window preference.
  await setWindow(660);
  const maximum = Math.max(200, Math.min(600, (await page.locator('.workspace').boundingBox()).width - 320));
  await expectWidth('导图库', Math.min(libraryWidth, maximum));
  await show('大纲');
  await expectWidth('大纲', Math.min(outlineWidth, maximum));
  await setWindow(1260);
  await expectWidth('大纲', outlineWidth);
  await show('导图库');
  await expectWidth('导图库', libraryWidth);
  await assertDocument();
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await page.screenshot({ path: path.join(results, 'sidebar-resize.png'), timeout: 10000 });
  await close();

  // Widths last only for this window; a new launch starts both at the same compact default.
  await launch();
  await expectWidth('导图库', 248);
  await show('大纲');
  await expectWidth('大纲', 248);
  await assertDocument();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, sessionWidths: { library: libraryWidth, outline: outlineWidth }, restartWidth: 248, checks: ['same compact defaults', 'real pointer resize left/right', 'canvas grows and shrinks', 'keyboard separator isolated from nodes', 'independent widths while switching', 'upper and lower bounds', 'Escape cleanup', 'pointercancel cleanup', 'narrow window clamps temporarily', 'new launch resets widths', 'document and selection unchanged'] }, null, 2));
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
