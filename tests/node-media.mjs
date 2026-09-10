import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const clipboardFixture = process.env.INKMAP_TEST_MEDIA_FIXTURE;
const clipboardOnly = !!clipboardFixture;
const home = await fs.mkdtemp(path.join(results, 'node-media-'));
const maps = path.join(home, '导图');
let file = path.join(maps, '图文笔记.mindmap');
const workspaceFile = path.join(home, '.mindmap', 'workspace.json');
const original = createDocument('图文笔记');
original.nodes = {
  root: { id: 'root', text: '图文笔记\nIdeas in pictures', children: ['reading', 'thinking'], collapsed: false },
  reading: { id: 'reading', text: '阅读', children: ['a'], collapsed: false },
  thinking: { id: 'thinking', text: '思考', children: ['b'], collapsed: false },
  a: { id: 'a', text: '在阅读中记录文字与图像，让不同的线索逐渐连接起来。每次重新整理时，都可以发现新的问题与可能的方向。', children: [], collapsed: false },
  b: { id: 'b', text: '另一条思路\nA different perspective', children: [], collapsed: false },
};
await fs.mkdir(maps, { recursive: true });
let startingDocument = original;
if (clipboardFixture) {
  const source = await fs.realpath(clipboardFixture);
  const isolatedResults = (await fs.realpath(results)).toLowerCase() + path.sep;
  assert.ok(source.toLowerCase().startsWith(isolatedResults), '复用的媒体fixture必须位于test-results内');
  startingDocument = JSON.parse(await fs.readFile(source, 'utf8'));
  assert.equal(startingDocument.nodes.a.images.length, 1);
  assert.equal(startingDocument.nodes.b.images.length, 1);
}
await fs.writeFile(file, JSON.stringify(startingDocument, null, 2));
await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
const writeWorkspace = () => fs.writeFile(workspaceFile, JSON.stringify({ current: file, recent: [{ path: file, title: original.title, updatedAt: new Date().toISOString() }] }));
await writeWorkspace();
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const image = id => node(id).locator('.node-image').first();
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const saved = async check => {
  await eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && await check(await readDoc()), '图文修改未保存');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};
const restoreClipboard = async () => {
  if (!app) return;
  await app.evaluate(async ({ clipboard }) => {
    globalThis.__releasePendingMediaPaste?.();
    delete globalThis.__releasePendingMediaPaste;
    const previous = globalThis.__mediaOriginalClipboard;
    if (!previous) return;
    if (previous.length) await clipboard.write(previous);
    else clipboard.clear();
    delete globalThis.__mediaOriginalClipboard;
  });
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const windowState = await app.evaluate(async ({ BrowserWindow, clipboard, ClipboardItem, nativeImage }) => {
    // Keep these private in the main process, never in test output or files.
    const previous = await clipboard.read();
    globalThis.__mediaOriginalClipboard = await Promise.all(previous.map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    // Reject external changes instead of ever importing a user's unrelated clipboard into a fixture.
    const read = clipboard.read.bind(clipboard);
    const write = clipboard.write.bind(clipboard);
    const writeText = clipboard.writeText.bind(clipboard);
    const hashPng = async blob => {
      const normalized = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).toPNG({ scaleFactor: 1 });
      return process.getBuiltinModule('crypto').createHash('sha256').update(normalized).digest('hex');
    };
    const signature = async items => {
      const image = items.find(item => item.types.includes('image/png'));
      if (image) return 'png:' + await hashPng(await image.getType('image/png'));
      const text = items.find(item => item.types.includes('text/plain'));
      return text ? 'text:' + (await (await text.getType('text/plain')).text()).replace(/\r\n/g, '\n') : null;
    };
    let expected = null;
    clipboard.write = async items => { await write(items); expected = await signature(items); };
    clipboard.writeText = async text => { await writeText(text); expected = 'text:' + text.replace(/\r\n/g, '\n'); };
    clipboard.read = async () => {
      const items = await read();
      if (expected !== null && await signature(items) !== expected) throw new Error('TEST_CLIPBOARD_CHANGED_EXTERNALLY');
      return items;
    };
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    return { visible: window.isVisible(), width: window.getContentSize()[0] };
  });
  assert.equal(windowState.visible, false);
  await eventually(async () => Math.abs(await page.evaluate(() => innerWidth) - windowState.width) < 3, '窗口尺寸未同步');
  await node('root').waitFor();
};
const close = async () => {
  await restoreClipboard();
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成。')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
};
const logicalBox = locator => locator.evaluate(element => ({ width: parseFloat(element.style.width), height: parseFloat(element.style.height), x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
const scale = () => page.locator('.canvas > .world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1.6, `${message}: ${actual} ≠ ${expected}`);
const sameColumn = async () => {
  const a = await logicalBox(node('a'));
  const b = await logicalBox(node('b'));
  near(a.width, b.width, '不同父节点的同列宽度');
  near(a.x, b.x, '同列左右边缘对齐');
  assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y, '同列节点不应重叠');
};
const selectNode = async id => { await node(id).click({ position: { x: 10, y: 10 } }); };
const beginDrag = async (handle, dx, dy = 0) => {
  const currentScale = await scale();
  const box = await handle.boundingBox();
  assert.ok(box, '拖动手柄必须可见');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * currentScale, y + dy * currentScale, { steps: 12 });
};
const columnHandle = () => node('a').getByRole('separator', { name: '调整节点列宽', exact: true });
const imageSize = () => image('a').locator('img').evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
const resizeImage = async delta => {
  await image('a').click();
  const size = await imageSize();
  const ratio = size.width / size.height;
  await beginDrag(image('a').getByRole('slider', { name: '调整图片尺寸', exact: true }), delta, delta / ratio);
};
const writePicture = async () => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 120;
    const context = canvas.getContext('2d');
    context.fillStyle = '#eee9df'; context.fillRect(0, 0, 240, 120);
    context.fillStyle = '#bd5b49'; context.fillRect(20, 20, 80, 80);
    context.fillStyle = '#315e72'; context.beginPath(); context.arc(166, 60, 38, 0, Math.PI * 2); context.fill();
    context.strokeStyle = '#ffffff'; context.lineWidth = 3; context.beginPath(); context.moveTo(80, 60); context.lineTo(166, 60); context.stroke();
    return canvas.toDataURL('image/png');
  });
  await app.evaluate(async ({ clipboard, ClipboardItem }, dataUrl) => {
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, dataUrl);
};
const clipboardText = text => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
const expectNativePng = () => eventually(() => app.evaluate(({ clipboard }) => clipboard.has('image/png')), '图片没有写入原生PNG剪贴板');
const equivalentImage = async (actual, expected) => {
  near(actual.width, expected.width, '复制粘贴保留显示宽度');
  near(actual.height, expected.height, '复制粘贴保留显示高度');
  assert.equal(actual.naturalWidth, expected.naturalWidth);
  assert.equal(actual.naturalHeight, expected.naturalHeight);
  const pixels = await page.evaluate(async sources => Promise.all(sources.map(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [[5, 5], [40, 40], [165, 40], [120, 60]].flatMap(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
  })), [actual.dataUrl, expected.dataUrl]);
  assert.deepEqual(pixels[0], pixels[1], '复制粘贴保留原始图像像素');
};
const imageMenu = async id => {
  await image(id).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '图片操作', exact: true });
  await menu.waitFor();
  return menu;
};

try {
  await launch();
  if (!clipboardOnly) {
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  near(await scale(), .85, '非100%缩放');
  await selectNode('a');
  const initial = await logicalBox(node('a'));
  const initialLines = await node('a').locator('.node-text > span').count();
  const diskBefore = await fs.readFile(file, 'utf8');

  stage = 'column preview, commit and undo';
  await beginDrag(columnHandle(), 90);
  await eventually(async () => (await logicalBox(node('a'))).width > initial.width + 80, '列宽拖动未实时预览');
  await sameColumn();
  // This deliberately spans the 300ms autosave delay: previews must not reach disk.
  await page.waitForTimeout(650);
  assert.equal(await fs.readFile(file, 'utf8'), diskBefore, '拖动未释放时不应写盘');
  await page.mouse.up();
  await saved(doc => typeof doc.columnWidths?.['2'] === 'number');
  const wide = await logicalBox(node('a'));
  near(wide.width, initial.width + 90, 'pointer距离需按zoom换算');
  assert.ok(await node('a').locator('.node-text > span').count() < initialLines, '扩大列宽后文字应重新换行');
  await page.keyboard.press('Control+z');
  await saved(doc => !doc.columnWidths?.['2']);
  near((await logicalBox(node('a'))).width, initial.width, '一次撤销恢复整次列宽拖动');
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => typeof doc.columnWidths?.['2'] === 'number');
  near((await logicalBox(node('a'))).width, wide.width);
  const widthDoc = await readDoc();
  await beginDrag(columnHandle(), -60);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  near((await logicalBox(node('a'))).width, wide.width, 'Escape取消列宽拖动');
  assert.deepEqual(await readDoc(), widthDoc);

  stage = 'native bitmap paste and image undo';
  console.log(`Media: ${stage}`);
  await selectNode('a');
  await writePicture();
  await page.keyboard.press('Control+v');
  await image('a').waitFor();
  await saved(doc => doc.nodes.a.images?.length === 1);
  const pasted = (await readDoc()).nodes.a.images[0];
  assert.equal((await readDoc()).nodes.a.text, original.nodes.a.text);
  assert.match(pasted.dataUrl, /^data:image\/(png|jpeg|webp);base64,/);
  near(pasted.naturalWidth / pasted.naturalHeight, 2, '原始图片比例');
  await page.keyboard.press('Control+z');
  await saved(doc => !doc.nodes.a.images?.length);
  assert.equal(await node('a').locator('.node-image').count(), 0);
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => doc.nodes.a.images?.length === 1);

  stage = 'proportional image resize and column expansion';
  const initialImage = (await readDoc()).nodes.a.images[0];
  await resizeImage(-initialImage.width / 2);
  await page.mouse.up();
  await saved(doc => doc.nodes.a.images[0].width < initialImage.width * .7);
  const small = (await readDoc()).nodes.a.images[0];
  near(small.width / small.height, 2, '缩小保持图片比例');
  near((await logicalBox(node('a'))).width, wide.width, '缩小图片保留手动列宽');
  const smallDoc = await readDoc();
  await resizeImage(wide.width + 60 - small.width);
  await eventually(async () => (await logicalBox(node('a'))).width > wide.width + 50, '大图片应撑开整列');
  await sameColumn();
  assert.deepEqual(await readDoc(), smallDoc, '图片resize预览不写盘');
  await page.mouse.up();
  await saved(doc => doc.nodes.a.images[0].width > wide.width + 50);
  const largeDoc = await readDoc();
  const large = largeDoc.nodes.a.images[0];
  near(large.width / large.height, 2, '放大保持图片比例');
  await sameColumn();
  assert.ok((await logicalBox(node('a'))).height > wide.height, '图片应增加节点高度');
  await page.keyboard.press('Control+z');
  await saved(doc => Math.abs(doc.nodes.a.images[0].width - small.width) < 1.6);
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => Math.abs(doc.nodes.a.images[0].width - large.width) < 1.6);
  await resizeImage(-80);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await readDoc(), largeDoc, '取消图片尺寸修改应恢复');
  const canceledSize = await imageSize();
  near(canceledSize.width / await scale(), large.width, '取消后屏幕图片恢复原尺寸');

  stage = 'image-only deletion and paste while editing';
  await image('a').click({ button: 'right' });
  await page.getByRole('menu', { name: '图片操作', exact: true }).getByRole('menuitem', { name: '删除图片', exact: true }).click();
  await saved(doc => !doc.nodes.a.images?.length);
  assert.equal(await page.locator('.canvas .mind-node').count(), 5);
  assert.equal((await readDoc()).nodes.a.text, original.nodes.a.text);
  await selectNode('a');
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.a.images?.length === 1);
  await node('b').dblclick({ position: { x: 10, y: 10 } });
  await writePicture();
  await page.keyboard.press('Control+v');
  await image('b').waitFor();
  if (await page.getByRole('textbox', { name: '编辑节点', exact: true }).count()) await page.keyboard.press('Control+Enter');
  await saved(doc => doc.nodes.b.images?.length === 1);
  assert.equal((await readDoc()).nodes.b.text, original.nodes.b.text, '编辑框中粘贴图片保留原文本');
  await image('b').click();
  await page.keyboard.press('Delete');
  await saved(doc => !doc.nodes.b.images?.length);
  assert.equal(await page.locator('.canvas .mind-node').count(), 5);
  await selectNode('b');
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.b.images?.length === 1);
  }

  stage = 'editor text copy and cut remain native';
  console.log(`Media: ${stage}`);
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node('b').dblclick({ position: { x: 10, y: 10 } });
  const textEditor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await textEditor.evaluate(element => element.setSelectionRange(0, 3));
  await textEditor.press('Control+c');
  await eventually(async () => await app.evaluate(({ clipboard }) => clipboard.readText()) === original.nodes.b.text.slice(0, 3), '编辑框应复制选中文字');
  await textEditor.press('Control+x');
  assert.equal(await textEditor.inputValue(), original.nodes.b.text.slice(3));
  assert.ok(await app.evaluate(({ clipboard }) => clipboard.readText()) === original.nodes.b.text.slice(0, 3), '剪切后应保留选中的测试文字');
  await textEditor.press('Escape');
  await saved(doc => doc.nodes.b.text === original.nodes.b.text && doc.nodes.b.images?.length === 1);

  stage = 'image copy and paste across nodes';
  console.log(`Media: ${stage}`);
  const copySource = (await readDoc()).nodes.a.images[0];
  await clipboardText('media-test: no image');
  await image('a').click();
  await page.keyboard.press('Control+c');
  await expectNativePng();
  await selectNode('b');
  await page.keyboard.press('Control+v');
  await saved(doc => doc.nodes.b.images?.length === 2);
  await equivalentImage((await readDoc()).nodes.b.images[1], copySource);
  assert.equal((await readDoc()).nodes.b.text, original.nodes.b.text);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.b.images?.length === 1);

  stage = 'immediate undo waits for asynchronous image paste';
  const beforePendingPaste = await readDoc();
  await app.evaluate(({ clipboard }) => {
    const read = clipboard.read.bind(clipboard);
    globalThis.__mediaPasteWaiting = false;
    clipboard.read = async () => {
      clipboard.read = read;
      globalThis.__mediaPasteWaiting = true;
      await new Promise(resolve => { globalThis.__releasePendingMediaPaste = resolve; });
      return read();
    };
  });
  await selectNode('b');
  await page.keyboard.press('Control+v');
  await eventually(() => app.evaluate(() => globalThis.__mediaPasteWaiting), '延迟图片读取未进入');
  await page.keyboard.press('Control+z');
  await app.evaluate(() => { globalThis.__releasePendingMediaPaste(); delete globalThis.__releasePendingMediaPaste; });
  // Give the released paste, queued undo and autosave a complete debounce window.
  await page.waitForTimeout(650);
  await saved(doc => doc.nodes.b.images?.length === 1);
  assert.deepEqual(await readDoc(), beforePendingPaste, '立刻撤销后不应留下稍后才插入的图片');
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => doc.nodes.b.images?.length === 2);
  await equivalentImage((await readDoc()).nodes.b.images[1], copySource);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.b.images?.length === 1);

  stage = 'image cut keeps text and can be undone';
  await clipboardText('media-test: no image');
  await image('a').click();
  await page.keyboard.press('Control+x');
  await saved(doc => !doc.nodes.a.images?.length);
  await expectNativePng();
  assert.equal((await readDoc()).nodes.a.text, original.nodes.a.text);
  assert.equal(await page.locator('.canvas .mind-node').count(), 5);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.a.images?.length === 1);
  await equivalentImage((await readDoc()).nodes.a.images[0], copySource);

  stage = 'image paste across documents preserves dimensions';
  console.log(`Media: ${stage}`);
  const sourceFile = file;
  await page.keyboard.press('Control+n');
  await eventually(async () => JSON.parse(await fs.readFile(workspaceFile, 'utf8')).current !== sourceFile, '新导图没有建立');
  file = JSON.parse(await fs.readFile(workspaceFile, 'utf8')).current;
  const freshEditor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await freshEditor.fill('摘录');
  await freshEditor.press('Control+Enter');
  await page.keyboard.press('Control+v');
  await saved(doc => doc.nodes.root.images?.length === 1);
  await equivalentImage((await readDoc()).nodes.root.images[0], copySource);
  assert.equal((await readDoc()).nodes.root.text, '摘录');
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, sourceFile);
  await page.keyboard.press('Control+o');
  await node('a').waitFor();
  file = sourceFile;
  await saved(doc => doc.nodes.a.images?.length === 1 && doc.nodes.b.images?.length === 1);

  stage = 'image and node context menu clipboard actions';
  console.log(`Media: ${stage}`);
  await clipboardText('media-test: no image');
  let menu = await imageMenu('a');
  for (const name of ['复制图片', '剪切图片', '粘贴图片', '删除图片']) assert.equal(await menu.getByRole('menuitem', { name, exact: true }).count(), 1);
  await menu.getByRole('menuitem', { name: '复制图片', exact: true }).click();
  await expectNativePng();
  menu = await imageMenu('b');
  await menu.getByRole('menuitem', { name: '粘贴图片', exact: true }).click();
  await saved(doc => doc.nodes.b.images?.length === 2);
  await equivalentImage((await readDoc()).nodes.b.images[1], copySource);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.b.images?.length === 1);
  const smallerSource = (await readDoc()).nodes.b.images[0];
  menu = await imageMenu('b');
  await menu.getByRole('menuitem', { name: '剪切图片', exact: true }).click();
  await saved(doc => !doc.nodes.b.images?.length);
  await expectNativePng();
  assert.equal((await readDoc()).nodes.b.text, original.nodes.b.text);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.b.images?.length === 1);
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await node('a').click({ button: 'right', position: { x: 10, y: 10 } });
  await page.locator('.context-menu').getByRole('button', { name: /^粘贴(?:\s|$)/ }).click();
  await saved(doc => doc.nodes.a.images?.length === 2);
  await equivalentImage((await readDoc()).nodes.a.images[1], smallerSource);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.a.images?.length === 1);

  stage = 'non-image clipboard paste on image stays silent';
  const beforePlainPaste = await readDoc();
  await clipboardText('media-test: ordinary text');
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await image('a').click();
  await page.keyboard.press('Control+v');
  const plainMenu = await imageMenu('a');
  await plainMenu.getByRole('menuitem', { name: '粘贴图片', exact: true }).click();
  await page.waitForTimeout(400);
  assert.deepEqual(await readDoc(), beforePlainPaste);
  assert.equal(await page.locator('.app-error, .toast').count(), 0);
  const persisted = await readDoc();
  await close();

  stage = 'self-contained moved file and restart';
  console.log(`Media: ${stage}`);
  const moved = path.join(maps, '收藏', '图文笔记.mindmap');
  await fs.mkdir(path.dirname(moved), { recursive: true });
  await fs.rename(file, moved);
  file = moved;
  await writeWorkspace();
  await launch();
  await eventually(async () => await page.locator('.canvas .node-image img').count() === 2 && await page.locator('.canvas .node-image img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), '移动后重启图片未加载');
  assert.deepEqual(await readDoc(), persisted);
  await sameColumn();
  near((await logicalBox(node('a'))).width, (await logicalBox(node('b'))).width);
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await page.screenshot({ path: path.join(results, 'node-media.png'), timeout: 10000 });

  stage = 'PDF containing inline images';
  const pdf = path.join(home, '图文笔记.pdf');
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, pdf);
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
  await eventually(async () => fs.stat(pdf).then(info => info.size > 1000).catch(() => false), '图文PDF未生成', 30000);
  const bytes = await fs.readFile(pdf);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  await eventually(async () => await page.locator('#pdf-export').count() === 0 && await page.locator('.app.busy').count() === 0, 'PDF暂存未清理');
  assert.deepEqual(await readDoc(), persisted);
  assert.equal(await page.locator('.app-error').count(), 0);
  assert.deepEqual(errors, []);
  await fs.copyFile(pdf, path.join(results, 'node-media.pdf'));
  await restoreClipboard();
  console.log(JSON.stringify({ success: true, clipboardOnly, home, file, pdf, columnWidth: (await logicalBox(node('a'))).width, images: 2, checks: [...(clipboardOnly ? [] : ['non-100% pointer resize synchronizes a column across parents', 'reflow and no node overlap', 'preview does not save; release is one undo', 'Escape cancels column and image resizing', 'native bitmap paste on node and in editor preserves text', 'proportional resize expands column', 'image undo/redo and image-only deletion']), 'text copy/cut remain native in editor', 'image copy/cut writes native PNG', 'cross-node and cross-document paste preserve original pixels and display size', 'queued paste can be undone immediately and redone', 'image and node context menu clipboard actions', 'non-image paste on image is silent', 'moved self-contained file survives restart', 'PDF generated with media', 'original common clipboard formats restored'] }, null, 2));
} catch (error) {
  console.error(`Media test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, file }));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) {
    await restoreClipboard().catch(error => { console.error('Clipboard restore failed:', error.message); process.exitCode = 1; });
    await app.close().catch(() => {});
  }
}
