import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mindmap-library-refresh-'));
const maps = path.join(home, '导图');
const folder = path.join(maps, '分类');
const activeFile = path.join(maps, '活动图.mindmap');
const otherFile = path.join(maps, '其他图.mindmap');
const thirdFile = path.join(maps, '再一张.mindmap');
await fs.mkdir(folder, { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'));
for (const file of [activeFile, otherFile, thirdFile]) {
  const doc = createDocument(path.basename(file, '.mindmap'));
  doc.nodes.root.text = '独立的节点内容';
  await fs.writeFile(file, JSON.stringify(doc));
}
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: activeFile, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page, stage = 'launch';
const errors = [];
const library = () => page.getByRole('complementary', { name: '导图库' });
const row = name => library().locator('.library-row').filter({ has: page.getByRole('button', { name, exact: true }) });
const selection = () => library().locator('.library-row.is-selected').evaluateAll(elements => elements.map(element => element.dataset.libraryPath));
const current = () => page.evaluate(() => window.inkmap.boot());
const eventually = async (check, message) => {
  const deadline = Date.now() + 12000;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
};
const armFailure = () => app.evaluate(() => { globalThis.__failLibraryRefresh = true; globalThis.__libraryRefreshFailed = false; });
const assertCommittedFailure = async () => {
  await page.locator('.app:not(.busy)').waitFor();
  await eventually(async () => /列表未能刷新/.test(await page.locator('.app-error').innerText()), 'Missing completed-operation refresh notice');
  assert.equal(await app.evaluate(() => globalThis.__libraryRefreshFailed), true);
  assert.ok(await library().locator('.library-row').count(), 'The previous library remains visible.');
  return { session: await current() };
};
const dismiss = async () => {
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).count()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
};
const refresh = async (name, expectedPath) => {
  await dismiss();
  await library().getByRole('button', { name: '刷新导图库', exact: true }).click();
  if (name) await row(name).waitFor();
  if (expectedPath) await eventually(async () => await row(name).getAttribute('data-library-path') === expectedPath, 'The refreshed row retained its old path');
};
const action = async (name, command) => {
  await row(name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: command, exact: true }).click();
};
const editRoot = async (text, file) => {
  await dismiss();
  await page.locator('.canvas [data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill(text);
  await page.keyboard.press('Control+Enter');
  await eventually(async () => {
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    return doc.nodes.root.text === text && await page.locator('.app[data-save-state="saved"]').count() === 1;
  }, 'The renderer retained a stale save token');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(async ({ app, BrowserWindow, shell }, home) => {
    const paths = process.getBuiltinModule('path');
    const fs = process.getBuiltinModule('fs').promises;
    const readdir = fs.readdir.bind(fs);
    fs.readdir = async (directory, ...args) => {
      if (globalThis.__failLibraryRefresh && directory === paths.join(home, '导图')) {
        globalThis.__failLibraryRefresh = false;
        globalThis.__libraryRefreshFailed = true;
        throw new Error('Synthetic library refresh failure');
      }
      return readdir(directory, ...args);
    };
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    // Keep the failed response observable until the test explicitly refreshes the list.
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => channel === 'library:changed' ? undefined : send(channel, ...args);
    const bin = paths.join(home, 'test-trash');
    await fs.mkdir(bin);
    let count = 0;
    shell.trashItem = async source => {
      const relative = paths.relative(paths.join(home, '导图'), source);
      if (!relative || paths.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + paths.sep)) throw new Error('Trash target outside isolated fixture.');
      await fs.rename(source, paths.join(bin, String(count++)));
    };
  }, home);
  await row('活动图').waitFor();
  stage = 'rename committed before failed refresh';
  const previousToken = (await current()).token;
  await action('活动图', '重命名');
  await page.getByRole('dialog').getByLabel('文件名', { exact: true }).fill('已改名');
  await armFailure();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  const renamed = await assertCommittedFailure();
  assert.notEqual(renamed.session.token, previousToken);
  const renamedFile = path.join(maps, '已改名.mindmap');
  assert.equal(await page.locator('.document-title').innerText(), '已改名');
  await editRoot('改名后继续输入', renamedFile);
  await refresh('已改名', renamedFile);
  assert.deepEqual(await selection(), [renamedFile]);

  stage = 'move committed before failed refresh';
  await action('已改名', '移动到…');
  await page.getByRole('dialog').getByLabel('文件夹', { exact: true }).selectOption(folder);
  await armFailure();
  await page.getByRole('dialog').getByRole('button', { name: '移动', exact: true }).click();
  const moved = await assertCommittedFailure();
  const movedFile = path.join(folder, '已改名.mindmap');
  assert.equal(moved.session.path, movedFile);
  await editRoot('移动后继续输入', movedFile);
  await refresh('已改名', movedFile);
  assert.deepEqual(await selection(), [movedFile]);

  stage = 'delete another map while folder selected';
  await row('分类').getByRole('button', { name: '分类', exact: true }).click();
  await armFailure();
  await action('其他图', '删除');
  await assertCommittedFailure();
  assert.deepEqual(await selection(), [folder]);
  assert.equal((await current()).path, movedFile);
  await refresh('分类');
  await eventually(async () => await row('其他图').count() === 0, 'Deleted inactive row remained after refresh');

  stage = 'delete another map while active map selected';
  if (await row('已改名').count() === 0) await row('分类').getByRole('button', { name: '分类', exact: true }).click();
  await row('已改名').getByRole('button', { name: '已改名', exact: true }).click();
  await page.locator('.app:not(.busy)').waitFor();
  await armFailure();
  await action('再一张', '删除');
  await assertCommittedFailure();
  assert.deepEqual(await selection(), [movedFile]);
  assert.equal((await current()).path, movedFile);
  await refresh('已改名');

  stage = 'delete active map leaves empty canvas';
  await armFailure();
  await action('已改名', '删除');
  const deleted = await assertCommittedFailure();
  assert.equal(deleted.session.doc, null);
  assert.equal(await page.locator('.canvas .mind-node').count(), 0);
  assert.deepEqual(await selection(), []);
  assert.equal(await page.locator('.document-title').count(), 0);
  await refresh('分类');
  await eventually(async () => await row('已改名').count() === 0, 'Deleted active row remained after refresh');

  stage = 'new folder completes once without a duplicate-creation retry';
  await library().getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('dialog').getByLabel('文件夹名称', { exact: true }).fill('新分类');
  await armFailure();
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await assertCommittedFailure();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.ok((await fs.stat(path.join(maps, '新分类'))).isDirectory());
  await refresh('新分类');
  assert.deepEqual(await selection(), [path.join(maps, '新分类')]);
  assert.equal(await row('新分类').count(), 1);
  assert.equal(await page.locator('.canvas .mind-node').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, home, checks: ['rename and move keep writable session', 'inactive deletion preserves folder or map selection', 'active deletion clears canvas', 'folder creation completes once', 'explicit refresh restores list'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ stage, home, error: error.message }, null, 2));
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
