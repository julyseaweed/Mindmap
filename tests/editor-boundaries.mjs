import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.INKMAP_TEST_RESULTS || path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'editor-boundaries-'));
const file = path.join(home, '导图', 'fixture.mindmap');
const fixture = createDocument('初始标题');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
fixture.nodes.root.text = '上面的文字\n下面的文字';
fixture.nodes.root.images = [{ id: 'picture', dataUrl: png, width: 64, height: 64, naturalWidth: 1, naturalHeight: 1 }];
fixture.nodes.root.textSegments = ['上面的文字', '下面的文字'];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(file, JSON.stringify(fixture));
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page, stage = 'launch';
const errors = [];
const eventually = async (check, message) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const state = () => app.evaluate(() => globalThis.__editorBoundaries);
const savedTitle = title => eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && (await readDoc()).title === title, '标题没有保存');
const rename = async title => {
  await page.locator('.document-title').click();
  await page.getByRole('textbox', { name: '导图名称', exact: true }).fill(title);
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.node-image').waitFor();
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1200, 820);
    globalThis.__editorBoundaries = { clipboard: 0, opens: 0, newDocuments: 0, copies: [] };
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
    for (const channel of ['clipboard:copy', 'clipboard:copy-branch', 'clipboard:copy-image', 'clipboard:paste-branch', 'clipboard:paste-image', 'clipboard:paste-text']) {
      replace(channel, () => { globalThis.__editorBoundaries.clipboard++; return null; });
    }
    replace('document:open', () => { globalThis.__editorBoundaries.opens++; return null; });
    replace('document:new', () => { globalThis.__editorBoundaries.newDocuments++; return null; });
    replace('document:save-as', (_, doc) => { globalThis.__editorBoundaries.copies.push(doc); return null; });
  });

  stage = 'help dialog isolates background image shortcuts';
  await page.locator('.node-image').click();
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '快捷键', exact: true });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.help-modal')), true);
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent);
  assert.equal(await focusedLabel(), '开始记录');
  await page.keyboard.press('Tab'); assert.equal(await focusedLabel(), '关闭快捷键');
  await page.keyboard.press('Tab'); assert.equal(await focusedLabel(), '开始记录');
  await page.keyboard.press('Shift+Tab'); assert.equal(await focusedLabel(), '关闭快捷键');
  await page.keyboard.press('Shift+Tab'); assert.equal(await focusedLabel(), '开始记录');
  for (const key of ['Delete', 'Backspace', 'Control+x', 'Control+v', 'Control+n', 'Control+o']) {
    await page.keyboard.press(key);
    assert.equal(await dialog.count(), 1, `${key} 不应改变快捷键弹窗`);
    assert.equal(await page.locator('.node-image').count(), 1, `${key} 不应删除弹窗后面的图片`);
  }
  await page.waitForTimeout(450);
  assert.deepEqual(await readDoc(), fixture);
  assert.deepEqual(await state(), { clipboard: 0, opens: 0, newDocuments: 0, copies: [] });
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape 应关闭弹窗');
  assert.equal(await page.locator('.node-image.is-selected').count(), 1, '关闭弹窗应保留原图片选择');

  stage = 'normal image deletion and undo still work after help';
  await page.locator('.node-image').focus();
  await page.keyboard.press('Delete');
  await eventually(async () => !(await readDoc()).nodes.root.images?.length, '正常删除图片没有生效');
  assert.equal((await readDoc()).nodes.root.text, fixture.nodes.root.text);
  await page.keyboard.press('Control+z');
  await eventually(async () => (await readDoc()).nodes.root.images?.length === 1, '撤销未恢复图片');
  assert.deepEqual((await readDoc()).nodes.root, fixture.nodes.root);

  stage = 'Ctrl+S commits the title being edited';
  await rename('直接保存的新标题');
  await page.keyboard.press('Control+s');
  await savedTitle('直接保存的新标题');
  assert.equal(await page.locator('.title-input').count(), 0);
  assert.equal(await page.locator('.document-title').textContent(), '直接保存的新标题');

  stage = 'save-as receives the title being edited and saves the source';
  await rename('另存为时的新标题');
  await page.keyboard.press('Control+Shift+s');
  await eventually(async () => (await state()).copies.length === 1, '另存为未收到文档');
  assert.equal((await state()).copies[0].title, '另存为时的新标题');
  await savedTitle('另存为时的新标题');

  stage = 'cancelled open still commits and saves the edited title';
  await rename('打开前的新标题');
  await page.keyboard.press('Control+o');
  await eventually(async () => (await state()).opens === 1, '打开操作未执行');
  await savedTitle('打开前的新标题');
  assert.deepEqual((await readDoc()).nodes, fixture.nodes);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, checks: ['help protects selected images and closes with Escape', 'image delete and undo still work outside help', 'Ctrl+S commits edited title', 'save-as receives new title', 'open saves edited title before picker', 'no system clipboard access'] }, null, 2));
} catch (error) {
  console.error(`Editor boundaries failed at: ${stage}`);
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
