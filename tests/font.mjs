import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'font-'));
const file = path.join(home, '导图', '字体检查 Font.mindmap');
const pdf = path.join(home, 'NeverMind.pdf');
const original = createDocument('字体检查 Font');
original.columnWidths = { 1: 178 };
original.nodes = {
  root: { id: 'root', text: '阅读与思考\nReading & reflection', children: ['alpha', 'beta'], collapsed: false },
  alpha: { id: 'alpha', text: '中文和 English 同时清楚\nCompare different observations', children: [], collapsed: false },
  beta: { id: 'beta', text: '保留文字和所有联系\nContinue exploring ideas', children: [], collapsed: false },
};
original.relationships = [{ id: 'relation', sourceId: 'alpha', targetId: 'beta', text: '两种观点之间的联系\nRelated ideas' }];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const initialBytes = await fs.readFile(file, 'utf8');
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const capture = async name => {
  let timer;
  try {
    const png = await Promise.race([
      app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true });
        return image.isEmpty() ? null : image.toPNG().toString('base64');
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (png) await fs.writeFile(path.join(home, name), Buffer.from(png, 'base64'));
    else console.log(`Optional screenshot skipped: ${name}`);
  } catch { console.log(`Optional screenshot unavailable: ${name}`); }
  finally { clearTimeout(timer); }
};
const eventually = async (check, message, timeout = 15000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const launch = async () => {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.canvas [data-node-id="alpha"]').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
};
const close = async () => {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
};
const switchFont = async font => {
  if (!await page.locator('.file-menu').count()) await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('combobox', { name: '字体', exact: true }).selectOption(font);
  await page.waitForFunction(expected => document.documentElement.dataset.font === expected, font);
  await eventually(async () => await page.getByRole('combobox', { name: '字体', exact: true }).isEnabled(), '字体切换未完成');
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
};
const mermaid = async () => {
  await app.evaluate(({ clipboard }) => { globalThis.__fontCopy = clipboard.writeText; clipboard.writeText = text => { globalThis.__fontText = text; }; });
  try {
    await page.getByRole('button', { name: '复制到 Obsidian', exact: true }).click();
    return await app.evaluate(() => globalThis.__fontText);
  } finally {
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.__fontCopy; delete globalThis.__fontCopy; delete globalThis.__fontText; });
  }
};
const noClipping = async () => {
  const issues = await page.locator('.canvas .mind-node').evaluateAll(nodes => nodes.flatMap(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('.node-text, .node-editor')].flatMap(element => {
      const content = element.getBoundingClientRect();
      return content.left < box.left - 1 || content.top < box.top - 1 || content.right > box.right + 1 || content.bottom > box.bottom + 1 || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 ? [node.getAttribute('data-node-id')] : [];
    });
  }));
  assert.deepEqual(issues, [], '字体切换后正文和编辑器不能裁切');
  assert.equal(await page.locator('.relationship-label').evaluate(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1), false);
};

try {
  await launch();
  assert.equal(await page.locator('html').getAttribute('data-font'), 'serif');
  const originalMermaid = await mermaid();
  await noClipping();

  stage = 'switch every visible app surface to NeverMind';
  await switchFont('nevermind');
  const selectors = ['.brand > span', '.document-title', '.library-header > span', '.library-entry > span:last-child', '.canvas .mind-node', '.relationship-label-text'];
  for (const selector of selectors) {
    const element = page.locator(selector).first();
    await element.waitFor();
    assert.ok((await element.evaluate(element => getComputedStyle(element).fontFamily)).includes('NeverMind'), `${selector} 应使用 NeverMind`);
  }
  assert.equal(await page.evaluate(() => document.fonts.check('14px NeverMind', 'English') && document.fonts.check('700 14px NeverMind', 'English')), true);
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const documentNode = await client.send('DOM.getDocument');
  const textNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '.canvas [data-node-id="alpha"] .node-text' });
  const actualFonts = (await client.send('CSS.getPlatformFontsForNode', { nodeId: textNode.nodeId })).fonts;
  assert.ok(actualFonts.some(font => /NeverMind/i.test(font.familyName) && font.isCustomFont && font.glyphCount > 0), '正文实际应绘制内置 NeverMind 字形');
  assert.ok(actualFonts.some(font => /YaHei/i.test(font.familyName) && font.glyphCount > 0), '中文实际应绘制微软雅黑字形');
  await client.detach();
  await noClipping();
  await capture('nevermind.png');

  stage = 'node editor and outline match the chosen font';
  await page.locator('.canvas [data-node-id="alpha"]').dblclick();
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await editor.waitFor();
  assert.ok((await editor.evaluate(element => getComputedStyle(element).fontFamily)).includes('NeverMind'));
  await noClipping();
  await editor.press('Control+Enter');
  await page.getByRole('button', { name: '显示大纲', exact: true }).click();
  assert.ok((await page.locator('.outline-panel .outline-row').first().evaluate(element => getComputedStyle(element).fontFamily)).includes('NeverMind'));
  await page.getByRole('button', { name: '导图库', exact: true }).click();
  for (const name of ['缩小', '放大']) {
    await page.getByRole('button', { name, exact: true }).click();
    await noClipping();
  }
  assert.equal(await mermaid(), originalMermaid, '字体设置不能写进 Mermaid');
  assert.equal(await fs.readFile(file, 'utf8'), initialBytes, '字体选择不能改写导图内容');

  stage = 'native font selector keys do not edit the selected node';
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  const select = page.getByRole('combobox', { name: '字体', exact: true });
  await select.focus();
  await select.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
  await select.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  assert.equal(await page.locator('.canvas [data-node-id="alpha"]').count(), 1);
  assert.equal(await fs.readFile(file, 'utf8'), initialBytes);
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();

  stage = 'PDF keeps NeverMind on white paper';
  await app.evaluate(({ BrowserWindow, dialog }, target) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const print = contents.printToPDF.bind(contents);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    contents.printToPDF = async options => {
      globalThis.__fontPdf = await contents.executeJavaScript(`(() => {
        const stage = document.querySelector('#pdf-export');
        return {
          background: getComputedStyle(stage).backgroundColor,
          fonts: [...stage.querySelectorAll('.mind-node, .relationship-label-text')].map(element => getComputedStyle(element).fontFamily)
        };
      })()`);
      return print(options);
    };
  }, pdf);
  await page.emulateMedia({ media: 'print' });
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
  await eventually(async () => fs.stat(pdf).then(info => info.size > 1000).catch(() => false), 'NeverMind PDF 未生成', 30000);
  await eventually(async () => await page.locator('#pdf-export').count() === 0, 'PDF 暂存未清理');
  await page.emulateMedia({ media: null });
  const print = await app.evaluate(() => globalThis.__fontPdf);
  assert.equal(print.background, 'rgb(255, 255, 255)');
  assert.ok(print.fonts.length >= 4 && print.fonts.every(font => font.includes('NeverMind')));
  const embeddedFonts = (await fs.readFile(pdf)).toString('latin1');
  assert.match(embeddedFonts, /\/FontName\s*\/[^\s]*NeverMind/, 'PDF 应嵌入 NeverMind 字体');
  assert.match(embeddedFonts, /\/FontName\s*\/[^\s]*MicrosoftYaHei/, 'PDF 应嵌入中文字体');

  stage = 'font persists on reopen and the original can be restored';
  await close();
  await launch();
  assert.equal(await page.locator('html').getAttribute('data-font'), 'nevermind');
  await noClipping();
  await switchFont('serif');
  assert.ok((await page.locator('.canvas .mind-node').first().evaluate(element => getComputedStyle(element).fontFamily)).includes('URW Classico'));
  await noClipping();
  assert.equal(await mermaid(), originalMermaid);
  await close();
  await launch();
  assert.equal(await page.locator('html').getAttribute('data-font'), 'serif');
  assert.equal(await fs.readFile(file, 'utf8'), initialBytes);
  assert.equal(await page.locator('.app-error, .save-error, .toast').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, pdf, actualFonts, checks: ['all app surfaces', 'actual NeverMind and Chinese glyphs', 'editor and display clipping', 'zoom', 'native select key boundaries', 'white PDF font', 'reopen persistence', 'restore original', 'map bytes and Mermaid unchanged'] }, null, 2));
} catch (error) {
  console.error(`Font test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, pdf }));
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
