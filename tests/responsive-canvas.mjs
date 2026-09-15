import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'responsive-canvas-'));
const file = path.join(home, '导图', '窄窗口.mindmap');
const original = createDocument('窄窗口');
original.nodes = {
  root: { id: 'root', text: '阅读\nReading', children: ['alpha', 'beta'], collapsed: false },
  alpha: { id: 'alpha', text: '观察\nObserve', children: ['detail'], collapsed: false },
  detail: { id: 'detail', text: '细节', children: [], collapsed: false },
  beta: { id: 'beta', text: '思考\nReflect', children: [], collapsed: false },
};
original.relationships = [{ id: 'relation', sourceId: 'alpha', targetId: 'beta', text: '联系\nRelation' }];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const smoke = process.env.INKMAP_TEST_RESPONSIVE_SMOKE === '1';
let app;
let page;
let stage = 'launch';
const errors = [];
const checked = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const eventually = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  } while (Date.now() < deadline);
  throw new Error(message);
};
const setWindow = async width => {
  const actual = await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(width, 420);
    return window.getContentSize();
  }, width);
  await eventually(async () => await page.evaluate(([width, height]) => Math.abs(innerWidth - width) < 2 && Math.abs(innerHeight - height) < 2, actual), '窄窗口内容尺寸未更新');
};
const setAppearance = async (font, theme) => {
  if (await page.locator('html').getAttribute('data-font') !== font) {
    await page.locator('.font-toggle').click();
    await page.waitForFunction(font => document.documentElement.dataset.font === font, font);
    await eventually(() => page.locator('.font-toggle').isEnabled(), '字体切换没有完成');
  }
  if (await page.locator('html').getAttribute('data-theme') !== theme) {
    await page.locator('.theme-toggle').click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await eventually(() => page.locator('.theme-toggle').isEnabled(), '主题切换没有完成');
  }
};
const setSidebar = async mode => {
  const library = mode.startsWith('library'), outline = mode.startsWith('outline');
  if (library && !await page.locator('.library-panel').count()) await page.getByRole('button', { name: '导图库', exact: true }).click();
  else if (outline && !await page.locator('.outline-panel').count()) await page.getByRole('button', { name: '显示大纲', exact: true }).click();
  else if (mode === 'none') {
    if (await page.locator('.library-panel').count()) await page.getByRole('button', { name: '导图库', exact: true }).click();
    if (await page.locator('.outline-panel').count()) await page.getByRole('button', { name: '显示大纲', exact: true }).click();
  }
  if (library || outline) {
    const separator = page.getByRole('separator', { name: `调整${library ? '导图库' : '大纲'}宽度`, exact: true });
    if (mode.endsWith('max')) await separator.press('End');
    else await separator.dblclick();
    const expected = mode.endsWith('max') ? Number(await separator.getAttribute('aria-valuemax')) : Math.min(248, Number(await separator.getAttribute('aria-valuemax')));
    await eventually(async () => Number(await separator.getAttribute('aria-valuenow')) === expected, '侧栏宽度没有更新');
  }
};
const checkToolbars = async description => {
  const result = await page.locator('.canvas').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect();
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    const bars = ['.selection-toolbar', '.zoom-controls'].map(selector => {
      const bar = canvas.querySelector(selector);
      return {
        selector,
        rect: rect(bar),
        buttons: [...bar.querySelectorAll('button')].map(button => {
          const box = rect(button);
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { name: button.getAttribute('aria-label') || button.title || button.textContent, rect: box, hit: !!hit && (hit === button || button.contains(hit)) };
        }),
      };
    });
    return { canvas: rect(canvas), viewport: { width: innerWidth, height: innerHeight }, bars };
  });
  const { canvas, viewport, bars } = result;
  for (const bar of bars) {
    assert.ok(Math.abs(bar.rect.x + bar.rect.width / 2 - canvas.x - canvas.width / 2) < 1.5, `${description} ${bar.selector} 应相对画布居中：${JSON.stringify(result)}`);
    assert.ok(bar.rect.left >= canvas.left && bar.rect.right <= canvas.right && bar.rect.top >= canvas.top && bar.rect.bottom <= canvas.bottom, `${description} ${bar.selector} 不能超出画布`);
    for (const button of bar.buttons) {
      const box = button.rect;
      assert.ok(box.width > 0 && box.height > 0 && box.left >= Math.max(0, canvas.left) && box.right <= Math.min(viewport.width, canvas.right) && box.top >= canvas.top && box.bottom <= Math.min(viewport.height, canvas.bottom), `${description} ${button.name} 应完整显示`);
      assert.equal(button.hit, true, `${description} ${button.name} 不能被其他元素遮住`);
    }
  }
  assert.ok(bars[0].rect.bottom + 4 <= bars[1].rect.top, `${description} 节点菜单和缩放条应分行且互不遮挡`);
  checked.push({ description, canvasWidth: canvas.width, menuWidth: bars[0].rect.width });
};
const cameraScale = () => page.locator('.world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
const saveCompleted = check => eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && check(await readDoc()), '新增节点或撤销未保存');
const capture = async () => {
  let timer;
  try {
    const png = await Promise.race([
      app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true });
        return image.isEmpty() ? null : image.toPNG().toString('base64');
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (png) {
      const output = path.join(home, 'narrow-window.png');
      await fs.writeFile(output, Buffer.from(png, 'base64'));
      return output;
    }
    console.log('Optional narrow-window screenshot skipped: hidden compositor unavailable.');
  } catch { console.log('Optional narrow-window screenshot unavailable.'); }
  finally { clearTimeout(timer); }
  return null;
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await node('alpha').waitFor();
  if (!smoke) for (const font of ['serif', 'nevermind']) for (const theme of ['light', 'dark']) {
    await setAppearance(font, theme);
    for (const windowWidth of [560, 720, 960]) {
      await setWindow(windowWidth);
      for (const sidebar of ['none', 'library', 'library-max', 'outline', 'outline-max']) {
        stage = `${windowWidth}px ${sidebar} ${font} ${theme}`;
        await setSidebar(sidebar);
        await fit();
        await node('alpha').click();
        await checkToolbars(`${stage} node`);
        await page.locator('.canvas .relationship-label').click();
        await checkToolbars(`${stage} relationship`);
      }
    }
    console.log(`Responsive canvas: ${font}/${theme}, ${checked.length} toolbar states checked.`);
  }

  stage = 'real actions in the narrowest canvas';
  await setAppearance('nevermind', 'dark');
  await setWindow(560);
  await setSidebar('library-max');
  await fit();
  if (smoke) {
    await page.locator('.canvas .relationship-label').click();
    await checkToolbars('narrowest canvas relationship');
  }
  await node('alpha').click();
  if (smoke) await checkToolbars('narrowest canvas node');
  const scale = await cameraScale();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await eventually(async () => await cameraScale() > scale, '窄画布的放大按钮应正常操作');
  await fit();
  await page.getByTitle('添加子节点', { exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await editor.fill('测试新增');
  await editor.press('Control+Enter');
  await saveCompleted(doc => Object.keys(doc.nodes).length === 5);
  await page.keyboard.press('Control+z');
  await saveCompleted(doc => Object.keys(doc.nodes).length === 4);
  await fit();
  await node('alpha').click();
  await page.getByRole('button', { name: '更多节点操作', exact: true }).click();
  const menu = page.locator('.context-menu');
  await menu.waitFor();
  const menuBounds = await menu.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= viewport.width + 1 && menuBounds.y + menuBounds.height <= viewport.height + 1, '更多菜单应在小窗口内完整显示或可滚动');
  await page.keyboard.press('Escape');
  await checkToolbars('narrowest canvas after real actions');
  assert.deepEqual((await readDoc()).nodes, original.nodes);
  assert.deepEqual((await readDoc()).relationships, original.relationships);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  const screenshot = await capture();
  console.log(JSON.stringify({ success: true, home, smoke, screenshot, scenarios: checked.length, checks: [...(smoke ? ['560px window at 420px height, NeverMind/dark, maximum library width'] : ['560/720/960px windows at 420px height', 'no sidebar and both sidebars at default/maximum widths', 'both fonts and themes']), 'node and relationship toolbars centered within canvas', 'all controls visible and hit-testable', 'separate centered zoom row', 'real zoom, child creation, undo and more menu', 'document preserved and no application errors'] }, null, 2));
} catch (error) {
  console.error(`Responsive canvas test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, lastScenarios: checked.slice(-4) }));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
