import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'interaction-boundaries-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '交互边界.mindmap');
const otherFile = path.join(maps, '另一张导图.mindmap');
const workspace = path.join(home, '.mindmap', 'workspace.json');
const original = createDocument('交互边界');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
original.columnWidths = { 1: 152 };
original.nodes.root.text = '边读边记';
original.nodes.root.children = ['target', 'peer'];
original.nodes.target = { id: 'target', text: '粘贴位置', children: [], collapsed: false, images: [{ id: 'picture', dataUrl: png, width: 64, height: 64, naturalWidth: 1, naturalHeight: 1 }] };
original.nodes.peer = { id: 'peer', text: '其他线索', children: [], collapsed: false };
const other = createDocument('另一张导图');
// A copied local file can legitimately retain its document id and title.
other.id = original.id;
other.title = original.title;
other.nodes.root.text = '另一张导图';
await fs.mkdir(maps, { recursive: true });
await fs.mkdir(path.dirname(workspace), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.writeFile(otherFile, JSON.stringify(other, null, 2));
await fs.writeFile(workspace, JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const resizeOnly = process.env.INKMAP_TEST_BOUNDARY_RESIZE_ONLY === '1';
let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const readDoc = async target => JSON.parse(await fs.readFile(target ?? file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  throw new Error(message);
};
const saved = check => eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && check(await readDoc()), '修改未按预期保存');
const mockState = () => app.evaluate(() => ({ ...globalThis.__boundaries, release: undefined, branch: undefined }));
const select = async id => {
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node(id).click({ position: { x: 8, y: 8 } });
  await node(id).focus();
};
const armPaste = async text => {
  const branch = createDocument(text);
  branch.nodes.root.text = text;
  await app.evaluate((_, value) => {
    Object.assign(globalThis.__boundaries, { branch: value, waiting: false, release: null });
  }, branch);
  await select('target');
  await page.keyboard.press('Control+v');
  await eventually(async () => (await mockState()).waiting, '测试粘贴未进入等待状态');
};
const releasePaste = () => app.evaluate(() => globalThis.__boundaries.release?.());

try {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1260, 820); return window.isVisible();
  }), false);
  await node('root').waitFor();
  // Every clipboard IPC is replaced before any shortcut is sent. No system clipboard access.
  await app.evaluate(({ ipcMain, dialog }, target) => {
    globalThis.__boundaries = { branch: null, release: null, waiting: false, copies: [], markdown: [], reads: 0, writes: 0 };
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
    replace('clipboard:paste-branch', async () => {
      const state = globalThis.__boundaries; state.reads++; state.waiting = true;
      await new Promise(resolve => { state.release = resolve; });
      state.waiting = false;
      return state.branch;
    });
    replace('clipboard:paste-image', () => { globalThis.__boundaries.reads++; return null; });
    replace('clipboard:paste-text', () => { globalThis.__boundaries.reads++; return ''; });
    replace('clipboard:copy-branch', () => { globalThis.__boundaries.writes++; });
    replace('clipboard:copy-image', () => { globalThis.__boundaries.writes++; });
    replace('clipboard:copy', (_, text) => { globalThis.__boundaries.copies.push(text); });
    replace('document:export', (_, text, title) => { globalThis.__boundaries.markdown.push({ text, title }); return null; });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, otherFile);

  stage = 'wheel and zoom leave the coordinate frame unchanged during a column resize';
  console.log(`Interaction boundaries: ${stage}`);
  await select('target');
  const resizeBefore = await readDoc();
  const handle = node('target').getByRole('separator', { name: '调整节点列宽', exact: true });
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 45, handleBox.y + handleBox.height / 2, { steps: 6 });
  await page.locator('.node-resize-handle.is-resizing').waitFor();
  const worldTransform = () => page.locator('.canvas > .world').evaluate(element => element.style.transform);
  const resizeTransform = await worldTransform();
  for (const ctrlKey of [false, true]) {
    await page.locator('.canvas').evaluate((element, modifier) => {
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: modifier ? -140 : 80, ctrlKey: modifier, clientX: bounds.left + 100, clientY: bounds.top + 100, bubbles: true, cancelable: true }));
    }, ctrlKey);
    await page.waitForTimeout(60);
    assert.equal(await worldTransform(), resizeTransform, '调列宽时滚轮平移或缩放不得改变坐标基准');
  }
  await page.getByRole('button', { name: '放大', exact: true }).evaluate(element => element.click());
  assert.equal(await worldTransform(), resizeTransform, '调列宽时缩放按钮也应保持坐标基准');
  assert.deepEqual(await readDoc(), resizeBefore, '调整预览不应写盘');
  await page.mouse.up();
  await saved(doc => doc.columnWidths?.['1'] > resizeBefore.columnWidths['1']);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.columnWidths?.['1'] === resizeBefore.columnWidths['1']);
  assert.deepEqual(await readDoc(), resizeBefore, '一次撤销应恢复整次调整');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);

  if (resizeOnly) {
    console.log(JSON.stringify({ success: true, home, checks: ['wheel pan blocked during resize', 'Ctrl+wheel zoom blocked during resize', 'zoom button blocked during resize', 'resize commits and one undo restores original', 'no real clipboard access'] }, null, 2));
  } else {
  stage = 'editor height matches character wrapping and leaves space above images at 85% zoom';
  console.log(`Interaction boundaries: ${stage}`);
  await select('target');
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await node('target').dblclick({ position: { x: 8, y: 8 } });
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  for (const text of ['reading writing thinking learning remembering observing', 'supercalifragilisticexpialidocious 中英文穿插 English words', 'a     b     c     d     e     f     g     h', '第一行\nEnglish words with spaces\n', '']) {
    await editor.fill(text);
    await page.waitForTimeout(80);
    const measured = await editor.evaluate(element => {
      const node = element.closest('.mind-node');
      const image = node.querySelector('.node-image');
      const box = node.getBoundingClientRect(), text = element.getBoundingClientRect(), picture = image.getBoundingClientRect();
      return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, gap: picture.top - text.bottom, bottomGap: box.bottom - picture.bottom, topGap: text.top - box.top, zoom: new DOMMatrix(getComputedStyle(node.closest('.world')).transform).a };
    });
    assert.ok(measured.scrollHeight <= measured.clientHeight + 1, '英文按单词换行不应使编辑框最后一行被截断');
    assert.ok(measured.gap >= 7 * measured.zoom, '空文字及多行文字编辑应留出图片间距');
    assert.ok(measured.topGap > 0 && measured.bottomGap > 0, '文字和图片应留在节点边框内');
  }
  await editor.fill(original.nodes.target.text);
  await page.keyboard.press('Control+Enter');
  await saved(doc => doc.nodes.target.text === original.nodes.target.text);

  stage = 'active node drag blocks clipboard shortcuts and native image paste';
  console.log(`Interaction boundaries: ${stage}`);
  await select('target');
  const beforeDrag = await fs.readFile(file, 'utf8');
  const beforeClipboard = await mockState();
  const rect = await node('target').boundingBox();
  await page.mouse.move(rect.x + 8, rect.y + 8);
  await page.mouse.down();
  await page.mouse.move(rect.x + 38, rect.y + 25, { steps: 4 });
  await page.locator('.canvas[data-drag-node="target"]').waitFor();
  const blocked = await page.locator('.canvas').evaluate((element, imageData) => {
    const shortcuts = ['c', 'x', 'v'].map(key => {
      const event = new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    });
    const bytes = Uint8Array.from(atob(imageData.split(',')[1]), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'fixture.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { shortcuts, paste: event.defaultPrevented };
  }, png);
  await page.waitForTimeout(100);
  assert.deepEqual(blocked, { shortcuts: [true, true, true], paste: true });
  const afterClipboard = await mockState();
  assert.equal(afterClipboard.reads, beforeClipboard.reads);
  assert.equal(afterClipboard.writes, beforeClipboard.writes);
  assert.equal(await fs.readFile(file, 'utf8'), beforeDrag);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.locator('.canvas[data-drag-node]').count(), 0);

  for (const kind of ['Obsidian', 'Markdown']) {
    stage = `pending paste is included in ${kind} export`;
    console.log(`Interaction boundaries: ${stage}`);
    const text = `${kind} 导出应包含刚粘贴的内容`;
    const before = await mockState();
    await armPaste(text);
    if (kind === 'Obsidian') await page.getByRole('button', { name: '复制到 Obsidian', exact: true }).click();
    else {
      await page.getByRole('button', { name: '文件菜单', exact: true }).click();
      await page.getByRole('button', { name: '导出为 Markdown', exact: true }).click();
    }
    await page.waitForTimeout(150);
    const pending = await mockState();
    assert.equal(kind === 'Obsidian' ? pending.copies.length : pending.markdown.length, kind === 'Obsidian' ? before.copies.length : before.markdown.length, '导出应等待已发起的粘贴完成');
    await releasePaste();
    await eventually(async () => {
      const state = await mockState();
      return kind === 'Obsidian' ? state.copies.at(-1)?.includes(text) : state.markdown.at(-1)?.text.includes(text);
    }, '导出遗漏刚完成的粘贴内容');
    await saved(doc => Object.values(doc.nodes).some(node => node.text === text));
  }

  stage = 'pending paste is saved to the originating document before switching files';
  console.log(`Interaction boundaries: ${stage}`);
  const otherBefore = await fs.readFile(otherFile, 'utf8');
  const text = '切换导图前完成的粘贴';
  await armPaste(text);
  await page.keyboard.press('Control+o');
  await page.waitForTimeout(150);
  assert.equal(JSON.parse(await fs.readFile(workspace, 'utf8')).current, file);
  await releasePaste();
  await eventually(async () => JSON.parse(await fs.readFile(workspace, 'utf8')).current === otherFile, '粘贴后未完成文件切换');
  assert.ok(Object.values((await readDoc()).nodes).some(node => node.text === text));
  assert.equal(await fs.readFile(otherFile, 'utf8'), otherBefore, '粘贴不应串入另一张导图');

  stage = 'explicit reopen refreshes contents even when document id and title match';
  console.log(`Interaction boundaries: ${stage}`);
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
  await page.keyboard.press('Control+o');
  await eventually(async () => JSON.parse(await fs.readFile(workspace, 'utf8')).current === file, '显式重新打开未完成');
  await eventually(async () => await node('root').locator('.node-text').innerText() === original.nodes.root.text, '同id同标题的文件必须刷新画布');
  await select('peer');
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill('替代导图中继续编辑');
  await page.keyboard.press('Control+Enter');
  await saved(doc => doc.nodes.peer?.text === '替代导图中继续编辑');
  assert.equal((await readDoc()).nodes.root.text, original.nodes.root.text);
  assert.equal(await fs.readFile(otherFile, 'utf8'), otherBefore, '重新打开其他文件不应覆盖之前的导图');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);

  console.log(JSON.stringify({ success: true, home, checks: ['English/mixed/empty editor height at 85% zoom', 'image spacing while editing', 'clipboard blocked during active drag', 'pending paste before Obsidian copy', 'pending paste before Markdown export', 'pending paste before document switch', 'same-id same-title explicit reopen', 'no real clipboard access or actual deletion'] }, null, 2));
  }
} catch (error) {
  console.error(`Interaction boundaries test failed at: ${stage}`);
  throw error;
} finally {
  if (app) await releasePaste().catch(() => {});
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
