import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'node-cut-race-'));
const file = path.join(home, '导图', '异步剪切保护.mindmap');
const doc = createDocument('异步剪切保护');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
doc.nodes = {
  root: { id: 'root', text: '检查剪切期间的编辑', children: ['source', 'peer'], collapsed: false },
  source: { id: 'source', text: '来源', children: ['inner'], collapsed: false, images: [{ id: 'picture', dataUrl: png, width: 60, height: 60, naturalWidth: 1, naturalHeight: 1 }] },
  inner: { id: 'inner', text: '子节点', children: [], collapsed: false },
  peer: { id: 'peer', text: '其他节点', children: [], collapsed: false },
};
doc.relationships = [
  { id: 'inside', sourceId: 'source', targetId: 'inner', text: '内部联系', control1: { x: 80, y: -110 }, control2: { x: -80, y: -110 } },
  { id: 'outside', sourceId: 'inner', targetId: 'peer', text: '外部联系', control1: { x: 0, y: 110 }, control2: { x: 100, y: 0 } },
  { id: 'unrelated', sourceId: 'root', targetId: 'peer', text: '其他联系', control1: { x: 0, y: -70 }, control2: { x: -40, y: -70 } },
];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(file, JSON.stringify(doc));
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page, stage = 'launch';
const errors = [];
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const node = id => page.locator(`.canvas [data-node-id="${id}"]`);
const eventually = async (check, message) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const finishCopy = () => app.evaluate(() => { globalThis.__cutRace.release?.(); globalThis.__cutRace.release = null; });
const waitCopy = () => eventually(() => app.evaluate(() => !!globalThis.__cutRace.release), '剪切没有等待复制');
const clearError = async () => {
  const close = page.locator('.app-error').getByRole('button', { name: '关闭提示', exact: true });
  if (await close.count()) await close.click();
};
const editLink = async (id, text) => {
  await page.locator(`.canvas .relationship-label[data-relationship-id="${id}"]`).dblclick();
  const editor = page.getByRole('textbox', { name: '编辑联系文字', exact: true });
  await editor.fill(text); await editor.press('Enter');
  await eventually(async () => (await readDoc()).relationships.find(link => link.id === id)?.text === text, '联系文字未保存');
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1260, 860);
    globalThis.__cutRace = { release: null };
    // Mock only clipboard IPC: no reading or modifying the system clipboard.
    for (const operation of ['clipboard:copy-branch', 'clipboard:copy-image']) {
      ipcMain.removeHandler(operation);
      ipcMain.handle(operation, async () => { await new Promise(resolve => { globalThis.__cutRace.release = resolve; }); });
    }
    return window.isVisible();
  }), false);
  await node('source').waitFor();
  for (const id of ['inside', 'outside']) {
    stage = `preserve ${id} relationship edits while cut waits`;
    await fit(); await node('source').click({ position: { x: 8, y: 8 } });
    await node('source').focus(); await page.keyboard.press('Control+x'); await waitCopy();
    const text = `${id} 剪切期间新增的文字`;
    await editLink(id, text); await finishCopy();
    await eventually(async () => await page.locator('.app-error').count() > 0 || !(await readDoc()).nodes.source, '剪切未完成');
    const after = await readDoc();
    assert.ok(after.nodes.source, `${id}: 剪切期间修改联系后必须保留来源节点`);
    assert.equal(after.relationships.find(link => link.id === id)?.text, text);
    await clearError();
  }

  stage = 'active image resize preview cancels pending cut';
  await fit(); await node('source').locator('.node-image').click();
  await page.keyboard.press('Control+x'); await waitCopy();
  const previewHandle = await node('source').getByRole('slider', { name: '调整图片尺寸', exact: true }).boundingBox();
  assert.ok(previewHandle);
  await page.mouse.move(previewHandle.x + previewHandle.width / 2, previewHandle.y + previewHandle.height / 2);
  await page.mouse.down(); await page.mouse.move(previewHandle.x + previewHandle.width / 2 + 20, previewHandle.y + previewHandle.height / 2 + 20, { steps: 10 });
  await finishCopy();
  await eventually(async () => await page.locator('.app-error').count() > 0 || !(await readDoc()).nodes.source.images?.length, '预览期间剪切未完成');
  assert.equal((await readDoc()).nodes.source.images?.[0].width, 60, '拖动预览期间不得剪掉图片或提前保存预览');
  await page.keyboard.press('Escape'); await page.mouse.up(); await clearError();

  stage = 'preserve image size edited while cut waits';
  await fit(); await node('source').locator('.node-image').click();
  await page.keyboard.press('Control+x'); await waitCopy();
  const handle = node('source').getByRole('slider', { name: '调整图片尺寸', exact: true });
  const box = await handle.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 12 }); await page.mouse.up();
  await eventually(async () => (await readDoc()).nodes.source.images[0].width > 60, '剪切等待期间的图片调整未保存');
  const resized = (await readDoc()).nodes.source.images[0];
  await finishCopy();
  await eventually(async () => await page.locator('.app-error').count() > 0 || !(await readDoc()).nodes.source.images?.length, '图片剪切未完成');
  assert.deepEqual((await readDoc()).nodes.source.images, [resized], '剪切期间修改图片后必须保留新尺寸');
  await clearError();

  stage = 'unrelated relationship edits do not block cutting source';
  await fit(); await node('source').click({ position: { x: 8, y: 8 } });
  await node('source').focus(); await page.keyboard.press('Control+x'); await waitCopy();
  await editLink('unrelated', '另一条联系的独立编辑'); await finishCopy();
  await eventually(async () => !(await readDoc()).nodes.source, '无关联系编辑不应阻止正常剪切');
  assert.equal((await readDoc()).relationships.find(link => link.id === 'unrelated')?.text, '另一条联系的独立编辑');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, checks: ['internal and external link edits cancel stale cut', 'active image resize preview cancels cut', 'same-image resize cancels stale cut', 'unrelated link edits permit cut', 'no system clipboard access'] }, null, 2));
} catch (error) {
  console.error(`Cut race test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home }));
  throw error;
} finally {
  if (app) await finishCopy().catch(() => {});
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
