import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'pdf-export-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '阅读与思考.mindmap');
const pdf = path.join(home, '阅读与思考.pdf');
const retryPdf = path.join(home, '重试导出.pdf');
const original = createDocument('阅读与思考');
original.nodes.root.text = '阅读与思考\nIdeas worth keeping';
for (let i = 1; i <= 8; i++) {
  const id = `branch${i}`;
  const detail = `detail${i}`;
  const leaf = `leaf${i}`;
  original.nodes.root.children.push(id);
  original.nodes[id] = { id, text: `第 ${i} 个观察\nObservation ${i}`, children: [detail], collapsed: false };
  original.nodes[detail] = { id: detail, text: `从文字中发现新的联系\nA connection to remember ${i}`, children: [leaf], collapsed: false };
  original.nodes[leaf] = { id: leaf, text: `继续追问与记录 ${i}\nWhat comes next?`, children: [], collapsed: false };
}
original.nodes.root.children.push('folded');
original.nodes.folded = { id: 'folded', text: '暂时收起的分支', children: ['hidden'], collapsed: true };
original.nodes.hidden = { id: 'hidden', text: '这条折叠内容不应导出', children: [], collapsed: false };
await fs.mkdir(maps, { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [{ path: file, title: original.title, updatedAt: new Date().toISOString() }] }));
await fs.writeFile(path.join(home, '.mindmap', 'appearance.json'), JSON.stringify({ theme: 'dark' }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const eventually = async (check, message, timeout = 15000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < until);
  throw new Error(message);
};
const show = async name => {
  await page.getByRole('button', { name: name === '导图库' ? '导图库' : '显示大纲', exact: true }).click();
  await page.locator(name === '导图库' ? '.library-panel' : '.outline-panel').waitFor();
};
const setWidth = async (name, width) => {
  const separator = page.getByRole('separator', { name: `调整${name}宽度`, exact: true });
  await separator.focus();
  await separator.press('Home');
  for (let step = 200; step < width; step += 10) await separator.press('ArrowRight');
  await eventually(async () => Number(await separator.getAttribute('aria-valuenow')) === width, '侧栏宽度未更新');
};
const state = async () => ({
  document: await fs.readFile(file, 'utf8'),
  screen: await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    view: document.querySelector('.canvas > .world').style.transform,
    selected: document.querySelector('.canvas .mind-node.selected')?.getAttribute('data-node-id'),
    nodes: [...document.querySelectorAll('.canvas .mind-node')].map(node => ({ id: node.getAttribute('data-node-id'), text: node.textContent })),
    width: document.querySelector('.resizable-sidebar').getBoundingClientRect().width,
    background: getComputedStyle(document.querySelector('.canvas')).backgroundColor,
    nodeStyle: (() => {
      const style = getComputedStyle(document.querySelector('.canvas .mind-node'));
      return { padding: style.padding, border: style.borderWidth, font: style.font, lineHeight: style.lineHeight };
    })(),
    printStyles: [...document.head.querySelectorAll('style')].filter(style => style.textContent.includes('@page')).length,
  })),
});
const testState = () => app.evaluate(() => ({
  dialogs: globalThis.__pdfTest.dialogs,
  calls: globalThis.__pdfTest.calls,
  options: globalThis.__pdfTest.options,
  staging: globalThis.__pdfTest.staging,
}));
const configure = (mode, target) => app.evaluate((_, config) => {
  globalThis.__pdfTest.mode = config.mode;
  globalThis.__pdfTest.target = config.target;
}, { mode, target });
const exportPdf = async () => {
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
};
const cleaned = () => eventually(async () => await page.locator('#pdf-export').count() === 0 && await page.locator('.app.busy').count() === 0, '导出后的暂存画布没有清理');
const checkPdf = async target => {
  await eventually(async () => fs.stat(target).then(info => info.size > 1000).catch(() => false), '没有生成完整PDF文件', 30000);
  const bytes = await fs.readFile(target);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.subarray(-1024).toString().includes('%%EOF'), 'PDF缺少结尾标记');
  return bytes.length;
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
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
  await eventually(async () => Math.abs(await page.evaluate(() => innerWidth) - windowState.width) < 3, '窗口大小未同步');
  await page.locator('.canvas [data-node-id="root"]').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('.canvas [data-node-id="hidden"]').count(), 0);
  await setWidth('导图库', 300);
  await show('大纲');
  await setWidth('大纲', 270);
  await show('导图库');

  // Deliberately move a large graph partly offscreen and away from its export scale.
  await page.locator('.zoom-value').click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  const canvas = await page.locator('.canvas').boundingBox();
  await page.mouse.move(canvas.x + 30, canvas.y + 25);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(canvas.x + 250, canvas.y + 140, { steps: 10 });
  await page.mouse.up({ button: 'middle' });
  const offscreen = await page.evaluate(() => {
    const bounds = document.querySelector('.canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.canvas .mind-node')].some(node => {
      const rect = node.getBoundingClientRect();
      return rect.right > bounds.right || rect.bottom > bounds.bottom || rect.left < bounds.left || rect.top < bounds.top;
    });
  });
  assert.equal(offscreen, true, 'fixture必须有视口外的节点');
  assert.notEqual(await page.locator('.zoom-value').innerText(), '100%');
  const before = await state();
  const visibleIds = before.screen.nodes.map(node => node.id).sort();
  if (!executablePath) await page.screenshot({ path: path.join(results, 'pdf-export-screen.png'), timeout: 10000 });

  // Picker responses stay inside the isolated home; successful calls use real Chromium PDF output.
  await app.evaluate(({ BrowserWindow, dialog }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const originalPrint = contents.printToPDF.bind(contents);
    globalThis.__pdfTest = { mode: 'normal', target: '', dialogs: 0, calls: 0, options: null, staging: null };
    dialog.showSaveDialog = async () => {
      const test = globalThis.__pdfTest;
      test.dialogs++;
      return test.mode === 'cancel' ? { canceled: true } : { canceled: false, filePath: test.target };
    };
    contents.printToPDF = async options => {
      const test = globalThis.__pdfTest;
      test.calls++;
      test.options = options;
      test.staging = await contents.executeJavaScript(`(() => {
        const stage = document.querySelector('#pdf-export');
        return stage ? {
          ids: [...stage.querySelectorAll('.mind-node')].map(node => node.getAttribute('data-node-id')).sort(),
          text: stage.textContent,
          controls: stage.querySelectorAll('.titlebar, .toolbar, .library-panel, .outline-panel, .selection-toolbar, .collapse-button, .node-resize-handle, .node-image-resizer').length,
          selection: stage.querySelectorAll('.mind-node.selected, .node-image.is-selected').length
        } : null;
      })()`);
      if (test.mode === 'failure') throw new Error('测试打印失败');
      return originalPrint(options);
    };
  });

  stage = 'normal PDF export';
  await configure('normal', pdf);
  await exportPdf();
  const pdfBytes = await checkPdf(pdf);
  await cleaned();
  assert.deepEqual(await state(), before, '导出不能改变文件、主题、画布视角或选中');
  assert.equal(await page.locator('.app-error, .toast').count(), 0);
  const first = await testState();
  assert.equal(first.calls, 1);
  assert.deepEqual(first.staging.ids, visibleIds, 'PDF必须包含全部当前展开节点，包括视口外节点');
  assert.equal(first.staging.controls, 0, '导出暂存中不能混入应用控件');
  assert.equal(first.staging.selection, 0, '导出不能包含编辑器的选中强调');
  assert.ok(!first.staging.text.includes(original.nodes.hidden.text));
  assert.ok(first.staging.text.includes('Ideas worth keeping'));

  stage = 'cancel PDF export';
  await configure('cancel', path.join(home, '取消.pdf'));
  await exportPdf();
  await eventually(async () => (await testState()).dialogs === 2, '取消对话框未触发');
  await cleaned();
  assert.equal((await testState()).calls, 1, '取消后不应开始打印');
  assert.equal(await fs.stat(path.join(home, '取消.pdf')).then(() => true).catch(() => false), false);
  assert.deepEqual(await state(), before);
  assert.equal(await page.locator('.app-error, .toast').count(), 0);

  stage = 'failed export cleanup and retry';
  await configure('failure', path.join(home, '失败.pdf'));
  await exportPdf();
  await page.locator('.app-error').waitFor();
  await cleaned();
  assert.deepEqual(await state(), before);
  assert.equal(await fs.stat(path.join(home, '失败.pdf')).then(() => true).catch(() => false), false);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await configure('normal', retryPdf);
  await exportPdf();
  const retryBytes = await checkPdf(retryPdf);
  await cleaned();
  assert.equal((await testState()).calls, 3);
  assert.deepEqual(await state(), before);
  assert.equal(await page.locator('.app-error, .toast').count(), 0);
  await show('大纲');
  assert.equal(Number(await page.getByRole('separator', { name: '调整大纲宽度', exact: true }).getAttribute('aria-valuenow')), 270);
  await show('导图库');
  assert.deepEqual(await state(), before);
  assert.deepEqual(errors, []);
  await fs.copyFile(pdf, path.join(results, 'pdf-export.pdf'));
  console.log(JSON.stringify({ success: true, home, pdf, retryPdf, pdfBytes, retryBytes, printOptions: first.options, visibleNodeCount: visibleIds.length, checks: ['real PDF menu output', 'all expanded nodes including offscreen', 'folded children excluded', 'cancel without PDF or error', 'failed print cleanup and successful retry', 'document, dark theme, view, selection and both sidebar widths unchanged'] }, null, 2));
} catch (error) {
  console.error(`PDF test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, pdf, retryPdf }));
  if (page && !page.isClosed()) console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
