import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, validateDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'empty-node-delete-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '空文字删除测试.mindmap');
const workspace = path.join(home, '.mindmap', 'workspace.json');
const original = createDocument('空文字删除测试');
original.nodes = {
  root: { id: 'root', text: '保留根节点', children: ['branch', 'sibling'], collapsed: false },
  branch: { id: 'branch', text: '清空文字后再删除', children: ['child'], collapsed: false },
  child: { id: 'child', text: '子节点也随方框删除', children: ['leaf'], collapsed: true },
  leaf: { id: 'leaf', text: '折叠后代', children: [], collapsed: false },
  sibling: { id: 'sibling', text: '保持不变', children: [], collapsed: false },
};
original.relationships = [
  { id: 'branchLink', sourceId: 'branch', targetId: 'sibling', text: '' },
  { id: 'hiddenChildLink', sourceId: 'child', targetId: 'leaf', text: '保留到分支删除' },
  { id: 'retainedLink', sourceId: 'root', targetId: 'sibling', text: '' },
];
await fs.mkdir(maps, { recursive: true });
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
const editor = () => page.getByRole('textbox', { name: '编辑节点', exact: true });
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
  }, '测试修改未完成保存');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  return doc;
};
const edit = async id => {
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node(id).dblclick({ position: { x: 10, y: 10 } });
  await editor().waitFor();
  assert.equal(await editor().evaluate(element => element === document.activeElement), true);
};
const assertBlankBranch = async () => {
  assert.equal(await editor().inputValue(), '');
  assert.equal(await node('branch').count(), 1);
  const doc = await saved(current => current.nodes.branch?.text === '');
  const expected = structuredClone(original);
  expected.nodes.branch.text = '';
  assert.deepEqual(doc, expected, '清空文字应保留方框、全部后代及兄弟');
  return doc;
};
const deleteAndUndo = async key => {
  stage = `${key}: clear text, delete subtree, and undo both steps`;
  console.log(`Empty node delete: ${stage}`);
  await edit('branch');
  await page.keyboard.press('Control+a');
  await page.keyboard.press(key);
  const blank = await assertBlankBranch();
  await page.keyboard.press(key);
  const removed = await saved(doc => !doc.nodes.branch && !doc.nodes.child && !doc.nodes.leaf);
  assert.deepEqual(removed.nodes.root.children, ['sibling']);
  assert.deepEqual(removed.nodes.sibling, original.nodes.sibling);
  assert.equal(Object.keys(removed.nodes).length, 2);
  assert.deepEqual(removed.relationships, [original.relationships[2]], '空框删除同步移除相关联系并保留其他联系');
  assert.equal(await editor().count(), 0);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => doc.nodes.branch?.text === ''), blank, '第一次撤销应恢复空框及子树');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => doc.nodes.branch?.text === original.nodes.branch.text), original, '第二次撤销应恢复原文字');
};

try {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    return window.isVisible();
  }), false, '测试窗口应隐藏并使用隔离目录');
  await node('root').waitFor({ timeout: 15000 });
  await saved(() => true);

  await deleteAndUndo('Delete');
  await deleteAndUndo('Backspace');

  stage = 'held Backspace must stop at an empty editor';
  console.log(`Empty node delete: ${stage}`);
  await edit('branch');
  await page.keyboard.press('Control+a');
  await page.keyboard.down('Backspace');
  try {
    await page.keyboard.down('Backspace');
    await page.keyboard.down('Backspace');
    await assertBlankBranch();
  } finally { await page.keyboard.up('Backspace'); }

  stage = 'repeat, composition, keyCode 229, and modifiers preserve the empty node';
  console.log(`Empty node delete: ${stage}`);
  for (const key of ['Delete', 'Backspace']) {
    for (const guard of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      await editor().dispatchEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...guard });
      await assertBlankBranch();
    }
  }
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => doc.nodes.branch?.text === original.nodes.branch.text), original);

  stage = 'an empty root remains after Delete and Backspace';
  console.log(`Empty node delete: ${stage}`);
  await edit('root');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  assert.equal(await editor().inputValue(), '');
  const emptyRoot = await saved(doc => doc.nodes.root.text === '');
  for (const key of ['Delete', 'Backspace']) {
    await page.keyboard.press(key);
    assert.equal(await editor().inputValue(), '');
    assert.equal(await node('root').count(), 1);
    assert.deepEqual(await readDoc(), emptyRoot, '根节点及其子树应保留');
  }
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await saved(doc => doc.nodes.root.text === original.nodes.root.text), original);
  assert.deepEqual(errors, []);

  stage = 'close isolated app';
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
  console.log(JSON.stringify({ success: true, home, checks: ['Delete clears then removes subtree', 'Backspace clears then removes subtree', 'two-step undo restores blank box then text', 'held key does not cross empty text', 'repeat and IME guards', 'Ctrl/Alt/Meta guards', 'empty root preserved'] }, null, 2));
} catch (error) {
  console.error(`Empty node delete test failed at: ${stage}`);
  throw error;
} finally {
  if (page && !page.isClosed()) await page.keyboard.up('Backspace').catch(() => {});
  if (app) await app.close().catch(() => {});
}
