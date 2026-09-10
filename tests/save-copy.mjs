import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'save-copy-'));
const maps = path.join(home, '导图');
const originalFile = path.join(maps, '工作文件.mindmap');
const otherFile = path.join(maps, '另一张导图.mindmap');
const conflictFile = path.join(maps, '独立导图标题.mindmap');
const copyFile = path.join(home, '外部文件', '导出副本.mindmap');
const importedFile = path.join(home, '外部文件', '导入来源.mindmap');
const workspace = path.join(home, '.mindmap', 'workspace.json');
const original = createDocument('独立导图标题');
original.columnWidths = { 1: 240 };
original.nodes.root.text = '工作中的导图';
original.nodes.root.children = ['note'];
original.nodes.note = { id: 'note', text: '最初的文字', children: [], collapsed: false };
const other = createDocument('另一张导图');
other.nodes.root.text = '另一张导图';
const conflict = createDocument('已有文件不能覆盖');
conflict.nodes.root.text = '这是保留的其他导图';
const incoming = createDocument('外部导入');
incoming.nodes.root.text = '外部导入';
incoming.nodes.root.children = ['note'];
incoming.nodes.note = { id: 'note', text: '外部原始文字', children: [], collapsed: false };
await fs.mkdir(maps, { recursive: true });
await fs.mkdir(path.dirname(copyFile), { recursive: true });
await fs.mkdir(path.dirname(workspace), { recursive: true });
await fs.writeFile(originalFile, JSON.stringify(original, null, 2));
await fs.writeFile(otherFile, JSON.stringify(other, null, 2));
await fs.writeFile(conflictFile, JSON.stringify(conflict, null, 2));
await fs.writeFile(importedFile, JSON.stringify(incoming, null, 2));
await fs.writeFile(workspace, JSON.stringify({ current: originalFile, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const cancelOnly = process.env.INKMAP_TEST_SAVE_COPY_CANCEL_ONLY === '1';
let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const session = () => page.evaluate(() => window.inkmap.boot());
const readDoc = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.stat(file).then(() => true, () => false);
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
const noErrors = async () => assert.equal(await page.locator('.app-error, .save-error').count(), 0, '成功保存后不应残留错误提示');
const saved = async check => {
  const active = await eventually(async () => {
    if (await page.locator('.app[data-save-state="saved"]').count() !== 1) return false;
    const current = await session();
    return check(current, await readDoc(current.path)) ? current : false;
  }, '工作导图未按预期保存');
  await noErrors();
  return active;
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1260, 820); return window.isVisible();
  }), false);
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
const selectNote = async () => {
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node('note').click({ position: { x: 8, y: 8 } });
  await node('note').focus();
};
const editNote = async text => {
  await selectNote();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  await page.keyboard.press('Control+Enter');
  return saved((_, doc) => doc.nodes.note?.text === text);
};
const open = async file => {
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
  await page.keyboard.press('Control+o');
};
const removeFixture = async file => {
  const relative = path.relative(home, path.resolve(file));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '只能删除本次测试自己生成的文件');
  await fs.unlink(file);
};
const checkCanceledSaveAs = async () => {
  stage = 'cancelled Save As still saves pending editor text and preserves source undo';
  console.log(`Save copy: ${stage}`);
  const before = await session();
  const text = '取消副本后仍保存的文字';
  await app.evaluate(({ dialog }) => {
    globalThis.__cancelSaveAsCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.__cancelSaveAsCalls++; return { canceled: true }; };
  });
  await selectNote();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  // Deliberately invoke while text is dirty and the editor is still open.
  await page.keyboard.press('Control+Shift+s');
  const after = await saved((active, doc) => active.path === before.path && doc.nodes.note.text === text);
  await page.locator('.app:not(.busy)').waitFor();
  assert.equal(await app.evaluate(() => globalThis.__cancelSaveAsCalls), 1);
  assert.equal(after.token, before.token);
  assert.equal(after.path, before.path);
  await page.keyboard.press('Control+z');
  await saved((active, doc) => active.path === before.path && doc.nodes.note.text === before.doc.nodes.note.text);
  await page.keyboard.press('Control+Shift+z');
  await saved((active, doc) => active.path === before.path && doc.nodes.note.text === text);
};

try {
  await launch();
  if (cancelOnly) {
    await checkCanceledSaveAs();
    assert.deepEqual(errors, []);
    await close();
    console.log(JSON.stringify({ success: true, home, checks: ['cancelled Save As saves pending editor text', 'source token/path preserved', 'undo and redo preserve the cancelled copy edit', 'no clipboard access'] }, null, 2));
  } else {
  stage = 'save an external copy without changing the source, token, view, or undo history';
  console.log(`Save copy: ${stage}`);
  await editNote('第一笔记录');
  await selectNote();
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  const source = await session();
  const beforeCopy = await readDoc(originalFile);
  const view = await page.locator('.canvas > .world').evaluate(element => element.style.transform);
  const selected = await page.locator('.canvas .mind-node.selected').getAttribute('data-node-id');
  assert.equal(await page.getByRole('button', { name: '撤销 (Ctrl + Z)', exact: true }).isEnabled(), true);
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, copyFile);
  await page.keyboard.press('Control+Shift+s');
  await eventually(async () => await exists(copyFile) && await page.locator('.app.busy').count() === 0, '没有完成另存副本');
  const exportedCopy = await readDoc(copyFile);
  assert.notEqual(exportedCopy.id, beforeCopy.id, '独立副本应有自己的文档身份');
  assert.deepEqual({ ...exportedCopy, id: beforeCopy.id }, beforeCopy);
  const afterCopy = await session();
  assert.equal(afterCopy.path, originalFile);
  assert.equal(afterCopy.token, source.token);
  assert.equal(JSON.parse(await fs.readFile(workspace, 'utf8')).current, originalFile);
  assert.equal(await page.locator('.canvas .mind-node.selected').getAttribute('data-node-id'), selected);
  assert.equal(await page.locator('.canvas > .world').evaluate(element => element.style.transform), view);
  await noErrors();

  stage = 'delete the exported copy, undo an earlier edit, and keep editing the source';
  console.log(`Save copy: ${stage}`);
  await removeFixture(copyFile);
  await page.keyboard.press('Control+z');
  await saved((active, doc) => active.path === originalFile && doc.nodes.note.text === original.nodes.note.text);
  await page.keyboard.press('Control+Shift+z');
  await saved((active, doc) => active.path === originalFile && doc.nodes.note.text === '第一笔记录');
  await editNote('副本删除后继续记录');
  assert.equal((await session()).token, source.token);
  assert.equal(await exists(copyFile), false, '继续编辑不能重新建立已删除的外部副本');

  stage = 'switch away and restart with the original library file';
  console.log(`Save copy: ${stage}`);
  await open(otherFile);
  await saved(active => active.path === otherFile);
  await open(originalFile);
  await saved((active, doc) => active.path === originalFile && doc.nodes.note.text === '副本删除后继续记录');
  await close(); await launch();
  assert.equal((await session()).path, originalFile);
  assert.equal((await readDoc(originalFile)).nodes.note.text, '副本删除后继续记录');

  await checkCanceledSaveAs();

  stage = 'missing working file is recreated at a unique library path without overwriting a conflict';
  console.log(`Save copy: ${stage}`);
  const conflictBytes = await fs.readFile(conflictFile, 'utf8');
  const beforeMissing = await session();
  await fs.rename(originalFile, path.join(home, '.mindmap', 'missing-source-fixture.mindmap'));
  const recovered = await editNote('工作文件丢失后继续记录');
  assert.equal(path.dirname(recovered.path), maps);
  assert.notEqual(recovered.path, conflictFile);
  assert.equal(recovered.token, beforeMissing.token, '自动恢复工作路径不应切换会话');
  assert.equal(await fs.readFile(conflictFile, 'utf8'), conflictBytes);
  assert.equal(JSON.parse(await fs.readFile(workspace, 'utf8')).current, recovered.path);
  await editNote('恢复后第二次记录');
  await close(); await launch();
  assert.equal((await session()).path, recovered.path);
  assert.equal((await readDoc(recovered.path)).nodes.note.text, '恢复后第二次记录');
  await noErrors();

  stage = 'opening an external file imports it so deleting the source cannot break editing';
  console.log(`Save copy: ${stage}`);
  const incomingBytes = await fs.readFile(importedFile, 'utf8');
  await open(importedFile);
  const imported = await saved((active, doc) => doc.title === incoming.title && active.path !== recovered.path);
  assert.equal(path.dirname(imported.path), maps);
  assert.notEqual(imported.path, importedFile);
  assert.equal(await fs.readFile(importedFile, 'utf8'), incomingBytes);
  await removeFixture(importedFile);
  await editNote('导入后继续记录');
  assert.equal((await session()).path, imported.path);
  assert.equal(await exists(importedFile), false);

  stage = 'save conflict preserves new recovery edits without repeating dismissed errors';
  console.log(`Save copy: ${stage}`);
  const beforeConflict = await fs.readFile(imported.path, 'utf8');
  const externallyChanged = JSON.parse(beforeConflict);
  externallyChanged.nodes.note.text = '外部程序修改的内容';
  const externalBytes = JSON.stringify(externallyChanged, null, 2);
  await fs.writeFile(imported.path, externalBytes);
  await selectNote();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill('触发保存冲突');
  await page.keyboard.press('Control+Enter');
  await page.locator('.app[data-save-state="error"]').waitFor();
  assert.equal(await page.locator('.save-error').count(), 1);
  assert.equal(await fs.readFile(imported.path, 'utf8'), externalBytes, '冲突时不能覆盖磁盘内容');
  await page.locator('.app-error').getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.evaluate(() => {
    window.__saveCopyStates = [];
    const app = document.querySelector('.app');
    window.__saveCopyObserver = new MutationObserver(() => window.__saveCopyStates.push(app.dataset.saveState));
    window.__saveCopyObserver.observe(app, { attributes: true, attributeFilter: ['data-save-state'] });
  });
  await selectNote();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill('冲突后继续在内存记录');
  await page.keyboard.press('Control+Enter');
  await eventually(async () => {
    const recovery = JSON.parse(await fs.readFile(path.join(home, '.mindmap', 'recovery.json'), 'utf8'));
    return recovery.doc.nodes.note.text === '冲突后继续在内存记录';
  }, '首次保存失败后的新输入也必须更新恢复文件');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.app').getAttribute('data-save-state'), 'error');
  const retryStates = await page.evaluate(() => { window.__saveCopyObserver.disconnect(); return window.__saveCopyStates; });
  assert.equal(retryStates.includes('saving'), false, '冲突尚未解决时不应反复闪烁保存状态');
  assert.equal(await fs.readFile(imported.path, 'utf8'), externalBytes);
  assert.equal(await page.locator('.app-error').count(), 0, '同一自动保存错误在关闭提示后不应再次打扰');
  await fs.writeFile(imported.path, beforeConflict);
  await page.keyboard.press('Control+s');
  await saved((active, doc) => active.path === imported.path && doc.nodes.note.text === '冲突后继续在内存记录');
  assert.deepEqual(errors, []);
  await close();
  console.log(JSON.stringify({ success: true, home, checks: ['Save As makes a copy only', 'source token/selection/view/undo preserved', 'exported copy deletion cannot break editing', 'source survives switching and restart', 'cancelled Save As saves pending text and preserves undo', 'missing working file recovers without overwriting same-name map', 'recovered path saves again and reopens', 'external files import into the library', 'real save conflict preserves external changes', 'new edits after failure keep updating recovery', 'dismissed automatic save errors stay quiet', 'successful retry clears stale save errors', 'no clipboard access'] }, null, 2));
  }
} catch (error) {
  console.error(`Save copy test failed at: ${stage}`);
  throw error;
} finally {
  if (app) {
    // A deliberately unresolved save conflict must not keep this isolated test window open.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await app.close().catch(() => {});
  }
}
