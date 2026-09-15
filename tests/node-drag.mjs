import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'node-drag-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '一起移动的想法.mindmap');

// A self-contained geometric PNG fixture, generated without clipboard or external files.
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, checksum]);
};
const imageWidth = 120, imageHeight = 72;
const header = Buffer.alloc(13);
header.writeUInt32BE(imageWidth); header.writeUInt32BE(imageHeight, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc((imageWidth * 4 + 1) * imageHeight);
for (let y = 0; y < imageHeight; y++) for (let x = 0; x < imageWidth; x++) {
  const offset = y * (imageWidth * 4 + 1) + 1 + x * 4;
  const color = x > 14 && x < 52 && y > 13 && y < 59 ? [179, 80, 63] : (x - 86) ** 2 + (y - 36) ** 2 < 22 ** 2 ? [47, 89, 109] : [238, 232, 220];
  pixels.set([...color, 255], offset);
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
const picture = { id: 'picture', dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: imageWidth, height: imageHeight, naturalWidth: imageWidth, naturalHeight: imageHeight };
const original = createDocument('一起移动的想法');
original.nodes = {
  root: { id: 'root', text: '一起移动的想法', children: ['alpha', 'beta', 'gamma'], collapsed: false },
  alpha: { id: 'alpha', text: '阅读中的线索', children: ['detail', 'folded'], collapsed: false, images: [picture] },
  detail: { id: 'detail', text: '具体的观察', children: [], collapsed: false },
  folded: { id: 'folded', text: '收起的补充', children: ['hidden'], collapsed: true },
  hidden: { id: 'hidden', text: '隐藏的细节也一起保留', children: [], collapsed: false },
  beta: { id: 'beta', text: '继续思考', children: ['betaNote'], collapsed: false },
  betaNote: { id: 'betaNote', text: '新的问题', children: [], collapsed: false },
  gamma: { id: 'gamma', text: '另一个方向', children: [], collapsed: false },
};
original.relationships = [
  { id: 'crossBranchLink', sourceId: 'alpha', targetId: 'gamma', text: '', control1: { x: 100, y: -45 }, control2: { x: 100, y: 45 } },
  { id: 'hiddenLink', sourceId: 'hidden', targetId: 'betaNote', text: '隐藏联系' },
];
await fs.mkdir(maps, { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [{ path: file, title: original.title, updatedAt: new Date().toISOString() }] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
const releaseOnly = process.env.INKMAP_TEST_DRAG_RELEASE_ONLY === '1';
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const saved = async predicate => {
  await eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && await predicate(await readDoc()), '节点拖动没有按预期保存');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};
const scale = () => page.locator('.canvas > .world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
const rect = locator => locator.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1.6, `${message}: ${actual} ≠ ${expected}`);
const positions = async ids => Object.fromEntries(await Promise.all(ids.map(async id => [id, await rect(node(id))])));
const edge = id => page.locator(`.connections > path[data-edge-to="${id}"]`).evaluate(element => {
  const matrix = element.getScreenCTM();
  const start = element.getPointAtLength(0).matrixTransform(matrix);
  const end = element.getPointAtLength(element.getTotalLength()).matrixTransform(matrix);
  return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
});
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    return { visible: window.isVisible(), width: window.getContentSize()[0] };
  });
  assert.equal(windowState.visible, false);
  await eventually(async () => Math.abs(await page.evaluate(() => innerWidth) - windowState.width) < 3, '隐藏窗口尺寸未同步');
  await node('root').waitFor();
  await node('alpha').locator('img').evaluate(image => image.decode());
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
const down = async (locator, position) => {
  const box = await rect(locator);
  const start = { x: box.x + (position?.x ?? box.width / 2), y: box.y + (position?.y ?? box.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return start;
};
const moveBy = async (start, dx, dy) => {
  const zoom = await scale();
  await page.mouse.move(start.x + dx * zoom, start.y + dy * zoom, { steps: 12 });
  return { x: dx * zoom, y: dy * zoom };
};
const expectDisplacement = async (before, delta) => {
  for (const [id, initial] of Object.entries(before)) {
    const current = await rect(node(id));
    near(current.x - initial.x, delta.x, `${id}水平方向跟随`);
    near(current.y - initial.y, delta.y, `${id}竖直方向跟随`);
  }
};
const sameDepthAligned = async () => {
  const boxes = await page.locator('.canvas .mind-node').evaluateAll(elements => elements.map(element => ({ depth: element.getAttribute('aria-level'), x: parseFloat(element.style.left), width: parseFloat(element.style.width) })));
  for (const depth of new Set(boxes.map(box => box.depth))) {
    const column = boxes.filter(box => box.depth === depth);
    for (const box of column) { near(box.x, column[0].x, '同列左边缘'); near(box.width, column[0].width, '同列宽度'); }
  }
};
const releaseChecks = async () => {
  const worldTransform = () => page.locator('.canvas > .world').evaluate(element => element.style.transform);
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  near(await scale(), .85);
  stage = 'release keeps camera fixed after gap reorder';
  const beforeGap = await worldTransform();
  const beta = await rect(node('beta'));
  const gamma = await rect(node('gamma'));
  await down(node('alpha'), { x: 20, y: 12 });
  await page.mouse.move(beta.x + beta.width / 2, (beta.y + beta.height + gamma.y) / 2, { steps: 16 });
  await page.locator('.canvas[data-drag-node="alpha"]').waitFor();
  assert.ok(await page.locator('.mind-node.drop-before, .mind-node.drop-after').count() > 0, '空白间隙应显示插入线');
  await page.screenshot({ path: path.join(results, 'node-drag-gap-preview.png'), timeout: 10000 });
  await page.mouse.up();
  await saved(doc => doc.nodes.root.children.join(',') === 'beta,alpha,gamma');
  assert.equal(await worldTransform(), beforeGap, '间隙重排释放后镜头不应跳动');
  await sameDepthAligned();

  stage = 'release keeps camera fixed after reparent';
  const beforeReparent = await worldTransform();
  const beforeImageDrag = await readDoc();
  const target = await rect(node('beta'));
  await node('alpha').locator('.node-image').click();
  assert.equal(await node('alpha').locator('.node-image').evaluate(element => document.activeElement === element), true, '图片应获焦以验证局部键盘处理');
  await down(node('alpha').locator('.node-image'));
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 16 });
  await page.locator('.canvas[data-drag-node="alpha"]').waitFor();
  for (const key of ['Delete', 'Backspace']) {
    await page.keyboard.press(key);
    assert.equal(await node('alpha').locator('.node-image').count(), 1, `拖动时${key}不能删除图片`);
    assert.equal(await page.locator('.canvas').getAttribute('data-drag-node'), 'alpha', `拖动时${key}不能中断拖动`);
    assert.deepEqual(await readDoc(), beforeImageDrag, `拖动时${key}不能修改导图`);
  }
  assert.equal(await page.locator('.connections > path[data-edge-to="alpha"]').getAttribute('data-preview-parent'), 'beta');
  await page.screenshot({ path: path.join(results, 'node-drag-reparent-preview.png'), timeout: 10000 });
  await page.mouse.up();
  await saved(doc => doc.nodes.beta.children.includes('alpha') && doc.nodes.root.children.join(',') === 'beta,gamma');
  assert.equal(await worldTransform(), beforeReparent, '改父释放后镜头不应跳动');
  await sameDepthAligned();
  assert.deepEqual((await readDoc()).nodes.alpha.images, original.nodes.alpha.images);
  stage = 'compact padding contains multiline text, editor and image';
  const checkContentBounds = async () => {
    const overflow = await page.locator('.canvas .mind-node').evaluateAll(nodes => nodes.flatMap(node => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll('.node-text, .node-editor, .node-image')].flatMap(content => {
        const bounds = content.getBoundingClientRect();
        const outside = bounds.left < box.left - 1 || bounds.right > box.right + 1 || bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1;
        const clippedText = content.matches('.node-text, .node-editor') && (content.scrollWidth > content.clientWidth + 1 || content.scrollHeight > content.clientHeight + 1);
        return outside || clippedText ? [{ node: node.getAttribute('data-node-id'), content: content.className, outside, clippedText }] : [];
      });
    }));
    assert.deepEqual(overflow, [], '缩小留白后内容不能溢出或被裁切');
  };
  await fit();
  await node('alpha').dblclick({ position: { x: 20, y: 10 } });
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  const multiline = '阅读中的线索\nNotes and pictures\n记录文字与图像，让不同的想法自然连接，继续发现新的问题。';
  await editor.fill(multiline);
  await checkContentBounds();
  await page.screenshot({ path: path.join(results, 'node-padding-editing.png'), timeout: 10000 });
  await editor.press('Control+Enter');
  await saved(doc => doc.nodes.alpha.text === multiline);
  assert.ok(await node('alpha').locator('.node-text > span').count() >= 3);
  await checkContentBounds();
  await sameDepthAligned();
  await fit();
  await page.screenshot({ path: path.join(results, 'node-padding.png'), timeout: 10000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, releaseOnly: true, home, file, checks: ['gap reorder preserves world transform on release', 'focused image survives Delete and Backspace during active drag', 'reparent still commits after ignored deletion keys', 'reparent preserves world transform on release', 'visible insertion line and new-parent connection preview', 'column alignment and image retained', 'multiline text, editor and image fit compact padding without clipping', 'no clipboard access'] }, null, 2));
};

try {
  await launch();
  if (releaseOnly) {
    await releaseChecks();
  } else {
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  near(await scale(), .85, '拖动测试使用85%缩放');
  assert.equal(await node('hidden').count(), 0);
  const branchIds = ['alpha', 'detail', 'folded'];
  await node('alpha').click({ position: { x: 10, y: 10 } });

  stage = 'branch and connections follow; Escape restores preview';
  const branchBefore = await positions(branchIds);
  const stationaryBefore = await positions(['root', 'beta', 'betaNote', 'gamma']);
  const internalBefore = await edge('detail');
  const incomingBefore = await edge('alpha');
  const relationshipLine = page.locator('.canvas [data-relationship-id="crossBranchLink"] .relationship-line');
  const relationshipBefore = await relationshipLine.getAttribute('d');
  const beforeBytes = await fs.readFile(file, 'utf8');
  let start = await down(node('alpha'), { x: 20, y: 12 });
  const delta = await moveBy(start, 80, -35);
  await eventually(async () => Math.abs((await rect(node('alpha'))).x - branchBefore.alpha.x) > 30, '拖动预览没有移动分支');
  await expectDisplacement(branchBefore, delta);
  await expectDisplacement(stationaryBefore, { x: 0, y: 0 });
  const internalPreview = await edge('detail');
  const incomingPreview = await edge('alpha');
  assert.notEqual(await relationshipLine.getAttribute('d'), relationshipBefore, '虚线联系应随节点拖动预览更新');
  for (const point of ['start', 'end']) {
    near(internalPreview[point].x - internalBefore[point].x, delta.x, '分支内连线横向跟随');
    near(internalPreview[point].y - internalBefore[point].y, delta.y, '分支内连线纵向跟随');
  }
  near(incomingPreview.start.x, incomingBefore.start.x, '入边父节点端不移动');
  near(incomingPreview.start.y, incomingBefore.start.y, '入边父节点端纵向不移动');
  near(incomingPreview.end.x - incomingBefore.end.x, delta.x, '入边分支端跟随');
  near(incomingPreview.end.y - incomingBefore.end.y, delta.y, '入边分支端纵向跟随');
  await page.waitForTimeout(650); // Spans autosave debounce; previews must stay off disk.
  assert.equal(await fs.readFile(file, 'utf8'), beforeBytes);
  await page.screenshot({ path: path.join(results, 'node-drag-preview.png'), timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expectDisplacement(branchBefore, { x: 0, y: 0 });
  assert.equal(await relationshipLine.getAttribute('d'), relationshipBefore, '取消节点拖动应恢复联系形状');
  assert.equal(await fs.readFile(file, 'utf8'), beforeBytes);

  stage = 'blank sibling gap reorder and single-step undo';
  console.log(`Node drag: ${stage}`);
  const beta = await rect(node('beta'));
  const gamma = await rect(node('gamma'));
  const gap = { x: beta.x + beta.width / 2, y: (beta.y + beta.height + gamma.y) / 2 };
  assert.ok(gap.y > beta.y + beta.height && gap.y < gamma.y, '目标必须为兄弟节点之间的空白');
  await down(node('alpha'), { x: 20, y: 12 });
  await page.mouse.move(gap.x, gap.y, { steps: 18 });
  await page.mouse.up();
  await saved(doc => doc.nodes.root.children.join(',') === 'beta,alpha,gamma');
  await sameDepthAligned();
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.root.children.join(',') === 'alpha,beta,gamma');
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => doc.nodes.root.children.join(',') === 'beta,alpha,gamma');

  stage = 'dragging image body reparents complete branch';
  console.log(`Node drag: ${stage}`);
  await fit();
  const target = await rect(node('beta'));
  await down(node('alpha').locator('.node-image'));
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 18 });
  await page.mouse.up();
  await saved(doc => doc.nodes.beta.children.includes('alpha') && doc.nodes.root.children.join(',') === 'beta,gamma');
  const reparented = await readDoc();
  assert.deepEqual(reparented.relationships, original.relationships, '移动节点不改变联系端点或控制点偏移');
  for (const id of ['alpha', 'detail', 'folded', 'hidden']) assert.deepEqual(reparented.nodes[id], original.nodes[id]);
  assert.equal(await node('hidden').count(), 0);
  await sameDepthAligned();
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.root.children.join(',') === 'beta,alpha,gamma' && !doc.nodes.beta.children.includes('alpha'));
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => doc.nodes.beta.children.includes('alpha'));
  assert.deepEqual(await readDoc(), reparented);
  await close();
  await launch();
  assert.deepEqual(await readDoc(), reparented, '重新打开保留拖动结构、隐藏后代和内嵌图片');
  await sameDepthAligned();

  stage = 'blur cancels an active branch drag';
  await fit();
  const cancelBefore = await positions(branchIds);
  start = await down(node('alpha'), { x: 20, y: 12 });
  await moveBy(start, -35, 30);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expectDisplacement(cancelBefore, { x: 0, y: 0 });
  assert.deepEqual(await readDoc(), reparented);

  stage = 'root moves the entire map without changing the document';
  const allIds = await page.locator('.canvas .mind-node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-node-id')));
  const allBefore = await positions(allIds);
  start = await down(node('root'), { x: 20, y: 12 });
  const rootDelta = await moveBy(start, 45, 35);
  await expectDisplacement(allBefore, rootDelta);
  await page.mouse.up();
  assert.deepEqual(await readDoc(), reparented);

  stage = 'text editing and resize handles retain their own actions';
  console.log(`Node drag: ${stage}`);
  await fit();
  await node('alpha').dblclick({ position: { x: 20, y: 12 } });
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  assert.equal(await editor.inputValue(), original.nodes.alpha.text);
  await editor.press('Escape');
  await saved(doc => doc.nodes.alpha.text === original.nodes.alpha.text);
  const widthBefore = await node('alpha').evaluate(element => parseFloat(element.style.width));
  start = await down(node('alpha').getByRole('separator', { name: '调整节点列宽', exact: true }));
  await moveBy(start, 45, 0);
  await page.mouse.up();
  await saved(doc => typeof doc.columnWidths?.['2'] === 'number');
  near(await node('alpha').evaluate(element => parseFloat(element.style.width)), widthBefore + 45, '右边缘仍然调整整列宽度');
  assert.deepEqual((await readDoc()).nodes.beta.children, reparented.nodes.beta.children);
  await sameDepthAligned();
  await node('alpha').locator('.node-image').click();
  start = await down(node('alpha').getByRole('slider', { name: '调整图片尺寸', exact: true }));
  await moveBy(start, 20, 12);
  await page.mouse.up();
  await saved(doc => doc.nodes.alpha.images[0].width > picture.width + 15);
  const final = await readDoc();
  assert.deepEqual(final.relationships, original.relationships, '调整图片和列宽保留全部联系');
  near(final.nodes.alpha.images[0].width / final.nodes.alpha.images[0].height, picture.width / picture.height, '图片角落仍然按比例缩放');
  assert.deepEqual(final.nodes.beta.children, reparented.nodes.beta.children);
  assert.equal(Object.keys(final.nodes).length, Object.keys(original.nodes).length);
  assert.deepEqual(errors, []);
  await fit();
  await page.screenshot({ path: path.join(results, 'node-drag.png'), timeout: 10000 });
  console.log(JSON.stringify({ success: true, home, file, checks: ['actual pointer at non-100% zoom', 'whole visible branch and edges follow', 'preview never writes document', 'blank gap sibling reorder persists', 'image body reparents complete branch with hidden descendants', 'single-step undo/redo', 'restart preserves structure and picture', 'Escape and blur cancellation', 'root drag pans entire graph without document changes', 'double-click text edits', 'node edge and image corner still resize', 'no clipboard access'] }, null, 2));
  }
} catch (error) {
  console.error(`Node drag test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, file }));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
