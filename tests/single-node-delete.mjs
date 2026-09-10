import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, validateDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'single-node-delete-'));
const file = path.join(home, '导图', '只删除当前节点.mindmap');
const workspace = path.join(home, '.mindmap', 'workspace.json');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
const picture = id => ({ id, dataUrl: png, width: 48, height: 48, naturalWidth: 1, naturalHeight: 1 });
const original = createDocument('只删除当前节点');
original.columnWidths = { 1: 164, 2: 140 };
original.nodes = {
  root: { id: 'root', text: '保留思路中的后续内容', children: ['before', 'expanded', 'middle', 'folded', 'after'], collapsed: false },
  before: { id: 'before', text: '前面的节点', children: [], collapsed: false },
  expanded: { id: 'expanded', text: '删除这个展开的父节点', children: ['alpha', 'beta'], collapsed: false, images: [picture('expandedPicture')] },
  alpha: { id: 'alpha', text: '第一个子节点', children: [], collapsed: false, images: [picture('alphaPicture')] },
  beta: { id: 'beta', text: '第二个子节点保持折叠', children: ['betaHidden'], collapsed: true },
  betaHidden: { id: 'betaHidden', text: '折叠后代与图片都保留', children: [], collapsed: false, images: [picture('betaPicture')] },
  middle: { id: 'middle', text: '旧 Delete 保持整树删除', children: ['middleChild'], collapsed: false },
  middleChild: { id: 'middleChild', text: '一起删除的后代', children: [], collapsed: false },
  folded: { id: 'folded', text: '删除这个折叠的父节点', children: ['foldedA', 'foldedB'], collapsed: true, images: [picture('foldedPicture')] },
  foldedA: { id: 'foldedA', text: '隐藏的第一个子节点', children: ['deep'], collapsed: true },
  foldedB: { id: 'foldedB', text: '隐藏的第二个子节点', children: [], collapsed: false, images: [picture('foldedBPicture')] },
  deep: { id: 'deep', text: '更深层图片保留', children: [], collapsed: false, images: [picture('deepPicture')] },
  after: { id: 'after', text: '后面的节点', children: [], collapsed: false },
};
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.dirname(workspace), { recursive: true });
await fs.writeFile(file, JSON.stringify(validateDocument(original), null, 2));
await fs.writeFile(workspace, JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;

let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
};
const saved = async check => {
  const doc = await eventually(async () => {
    if (await page.locator('.app[data-save-state="saved"]').count() !== 1) return false;
    const current = await readDoc();
    return check(current) ? current : false;
  }, '节点删除未按预期保存');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  return doc;
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1260, 820); return window.isVisible();
  }), false, '测试窗口必须隐藏并使用隔离目录');
  await node('root').waitFor({ timeout: 15000 });
  await saved(() => true);
};
const close = async () => {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {}); app = null; page = null;
};
const select = async id => {
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node(id).click({ position: { x: 7, y: 7 } });
  await node(id).focus();
};
const menu = async id => {
  await select(id);
  await node(id).click({ button: 'right', position: { x: 7, y: 7 } });
  const popup = page.locator('.context-menu');
  await popup.waitFor();
  return popup;
};
const onlyRemoved = (before, after, removedId, rootOrder) => {
  const expected = structuredClone(before);
  delete expected.nodes[removedId];
  expected.nodes.root.children = rootOrder;
  assert.deepEqual(after, expected, '只删除该节点；子节点、图片、隐藏后代及其他内容均应原样保留');
};
const undoRedo = async (before, after, id) => {
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => !!doc.nodes[id]), before, '一次撤销应完整恢复父节点和原层级');
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await saved(doc => !doc.nodes[id]), after, '一次重做应再次只删除该节点');
};

try {
  await launch();
  stage = 'root disables both node deletion commands';
  console.log(`Single node delete: ${stage}`);
  let popup = await menu('root');
  assert.equal(await popup.getByRole('button', { name: /^删除单个节点/ }).isDisabled(), true);
  assert.equal(await popup.getByRole('button', { name: /^删除节点及分支/ }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await select('root');
  await page.keyboard.press('Delete');
  assert.deepEqual(await readDoc(), original);

  stage = 'delete expanded node and promote children at the original sibling position';
  console.log(`Single node delete: ${stage}`);
  popup = await menu('expanded');
  assert.equal(await popup.getByRole('button', { name: /^删除单个节点/ }).isDisabled(), false);
  assert.equal(await popup.getByRole('button', { name: /^删除节点及分支/ }).isDisabled(), false);
  await page.screenshot({ path: path.join(results, 'single-node-delete-menu.png'), timeout: 10000 });
  await popup.getByRole('button', { name: /^删除单个节点/ }).click();
  let after = await saved(doc => !doc.nodes.expanded);
  onlyRemoved(original, after, 'expanded', ['before', 'alpha', 'beta', 'middle', 'folded', 'after']);
  assert.equal(await node('alpha').getAttribute('aria-level'), '2');
  assert.equal(await node('beta').getAttribute('aria-level'), '2');
  assert.equal(await node('alpha').locator('[data-image-id="alphaPicture"]').count(), 1);
  assert.equal(await node('betaHidden').count(), 0, '子节点自己的折叠状态应保留');
  assert.equal(await page.locator('[data-image-id="expandedPicture"]').count(), 0);
  await undoRedo(original, after, 'expanded');

  stage = 'delete collapsed node while retaining hidden descendants and their order';
  console.log(`Single node delete: ${stage}`);
  const beforeFolded = after;
  assert.equal(await node('foldedA').count(), 0);
  assert.equal(await node('foldedB').count(), 0);
  popup = await menu('folded');
  await popup.getByRole('button', { name: /^删除单个节点/ }).click();
  after = await saved(doc => !doc.nodes.folded);
  onlyRemoved(beforeFolded, after, 'folded', ['before', 'alpha', 'beta', 'middle', 'foldedA', 'foldedB', 'after']);
  assert.equal(await node('foldedA').count(), 1);
  assert.equal(await node('foldedB').locator('[data-image-id="foldedBPicture"]').count(), 1);
  assert.equal(await node('deep').count(), 0, '更深后代保持折叠且仍存在于文档');
  await undoRedo(beforeFolded, after, 'folded');

  stage = 'promoted hierarchy, pictures, and collapse states survive restart';
  console.log(`Single node delete: ${stage}`);
  const persisted = after;
  await close();
  await launch();
  assert.deepEqual(await readDoc(), persisted);
  assert.equal(await node('foldedB').locator('[data-image-id="foldedBPicture"]').count(), 1);
  assert.equal(await node('deep').count(), 0);
  assert.equal(await node('expanded').count(), 0);
  assert.equal(await node('folded').count(), 0);

  stage = 'legacy Delete key still deletes the entire branch';
  console.log(`Single node delete: ${stage}`);
  await select('middle');
  await page.keyboard.press('Delete');
  let removed = await saved(doc => !doc.nodes.middle && !doc.nodes.middleChild);
  const expected = structuredClone(persisted);
  expected.nodes.root.children = ['before', 'alpha', 'beta', 'foldedA', 'foldedB', 'after'];
  delete expected.nodes.middle; delete expected.nodes.middleChild;
  assert.deepEqual(removed, expected);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => !!doc.nodes.middle), persisted);

  stage = 'legacy menu deletion still removes collapsed descendants';
  console.log(`Single node delete: ${stage}`);
  popup = await menu('beta');
  await popup.getByRole('button', { name: /^删除节点及分支/ }).click();
  removed = await saved(doc => !doc.nodes.beta && !doc.nodes.betaHidden);
  assert.equal(Object.keys(removed.nodes).length, Object.keys(persisted.nodes).length - 2);
  assert.ok(removed.nodes.alpha.images.length && removed.nodes.deep.images.length);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => !!doc.nodes.beta), persisted);
  assert.deepEqual(errors, []);
  await close();
  console.log(JSON.stringify({ success: true, home, checks: ['two menu commands and root protection', 'expanded node removal', 'collapsed node removal', 'children replace original sibling slot in order', 'descendant ids, images, and collapse states preserved', 'single-step undo and redo', 'saved structure survives full restart', 'legacy Delete and branch menu keep subtree semantics', 'no clipboard or filesystem deletion'] }, null, 2));
} catch (error) {
  console.error(`Single node delete test failed at: ${stage}`);
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
