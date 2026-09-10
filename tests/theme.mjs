import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'theme-'));
const maps = path.join(home, '导图');
const file = path.join(maps, '主题测试.mindmap');
const appearance = path.join(home, '.mindmap', 'appearance.json');
const original = createDocument('灵感整理');
original.nodes.root.text = '正在思考';
original.nodes.root.children = ['reading', 'idea'];
original.nodes.reading = { id: 'reading', text: '阅读要点', children: [], collapsed: false };
original.nodes.idea = { id: 'idea', text: 'A clear idea', children: [], collapsed: false };
await fs.mkdir(path.join(maps, '资料'), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.dirname(appearance), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [{ path: file, title: original.title, updatedAt: new Date().toISOString() }] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const colors = {};
const eventually = async (check, message, timeout = 10000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    return { visible: window.isVisible(), contentWidth: window.getContentSize()[0] };
  });
  assert.equal(windowState.visible, false);
  await eventually(async () => Math.abs(await page.evaluate(() => innerWidth) - windowState.contentWidth) < 3, '隐藏窗口内容尺寸未更新');
  await page.locator('[data-node-id="root"]').waitFor();
  await page.locator('.library-panel').waitFor();
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
const panel = name => page.locator(name === '导图库' ? '.library-panel' : '.outline-panel');
const width = async name => (await panel(name).boundingBox()).width;
const expectWidth = async (name, expected) => {
  await eventually(async () => Math.abs(await width(name) - expected) < 1.5, `${name}宽度未保留 ${expected}`);
};
const show = async name => {
  await page.getByRole('button', { name: name === '导图库' ? '导图库' : '显示大纲', exact: true }).click();
  await panel(name).waitFor();
};
const resize = async (name, delta) => {
  const before = await width(name);
  const box = await page.getByRole('separator', { name: `调整${name}宽度`, exact: true }).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 12 });
  await page.mouse.up();
  await expectWidth(name, before + delta);
};
const storedTheme = async () => JSON.parse(await fs.readFile(appearance, 'utf8')).theme;
const setTheme = async theme => {
  const label = theme === 'dark' ? '切换到深色模式' : '切换到浅色模式';
  const toggle = page.locator('.titlebar').getByRole('button', { name: label, exact: true });
  assert.equal(await page.locator('.titlebar button').count(), 1);
  await toggle.click();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await eventually(async () => await storedTheme() === theme, '主题偏好没有写入隔离目录');
  assert.equal(await page.evaluate(() => window.inkmap.getTheme()), theme);
};
const copy = async () => {
  await app.evaluate(({ clipboard }) => {
    // Capture this fixture's export without reading or replacing the user's clipboard.
    globalThis.__themeWriteText = clipboard.writeText;
    globalThis.__themeCopiedText = '';
    clipboard.writeText = text => { globalThis.__themeCopiedText = text; };
  });
  try {
    await page.getByRole('button', { name: '复制到 Obsidian', exact: true }).click();
    await eventually(async () => (await app.evaluate(() => globalThis.__themeCopiedText)).includes('flowchart LR'), 'Mermaid未复制');
    assert.equal(await page.locator('.app-error, .toast').count(), 0);
    return await app.evaluate(() => globalThis.__themeCopiedText);
  } finally {
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = globalThis.__themeWriteText;
      delete globalThis.__themeWriteText;
      delete globalThis.__themeCopiedText;
    });
  }
};
const stableState = async () => ({
  file: await fs.readFile(file, 'utf8'),
  selected: await page.locator('.mind-node.selected').getAttribute('data-node-id'),
  librarySelection: await page.locator('.library-row.is-selected').getAttribute('data-library-path'),
  nodes: await page.locator('.mind-node').count(),
  font: await page.locator('.mind-node').first().evaluate(element => getComputedStyle(element).fontFamily),
});

// Resolve transparent surfaces through their ancestors, then compare rendered colors.
const paint = async (locator, property = 'color') => locator.evaluate((element, property) => {
  const rgba = value => {
    const values = value.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3) throw new Error(`Unsupported computed color: ${value}`);
    return [...values.slice(0, 3), values[3] ?? 1];
  };
  const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3]));
  const layers = [];
  for (let current = element; current; current = current.parentElement) layers.push(rgba(getComputedStyle(current).backgroundColor));
  let background = [255, 255, 255];
  for (const layer of layers.reverse()) background = over(layer, background);
  const raw = getComputedStyle(element).getPropertyValue(property);
  const foreground = over(rgba(raw), background);
  const luminance = color => {
    const linear = color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return { raw, background, foregroundLuminance, backgroundLuminance, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05) };
}, property);
const readable = async (name, locator, { dark = true, property = 'color', minimum = 4.5 } = {}) => {
  const sample = await paint(locator, property);
  colors[name] = sample;
  if (dark) assert.ok(sample.backgroundLuminance < .15, `${name}未使用深色背景: ${JSON.stringify(sample)}`);
  assert.ok(sample.contrast >= minimum, `${name}对比不足: ${JSON.stringify(sample)}`);
  return sample;
};
const screenshot = name => page.screenshot({ path: path.join(results, name), timeout: 10000 });

try {
  await launch();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.evaluate(() => window.inkmap.initialTheme), 'light');
  colors.lightCanvas = await paint(page.locator('.canvas'));
  assert.ok(colors.lightCanvas.backgroundLuminance > .8);
  await resize('导图库', 80);
  await show('大纲');
  await resize('大纲', 50);
  await show('导图库');
  await expectWidth('导图库', 328);
  const before = await stableState();
  const mermaid = await copy();

  stage = 'dark surfaces';
  await setTheme('dark');
  assert.deepEqual(await stableState(), before);
  await expectWidth('导图库', 328);
  assert.equal(await copy(), mermaid, '主题不能改变Mermaid展示结果');
  await readable('canvas', page.locator('.canvas'));
  await readable('brand', page.locator('.brand span'));
  await readable('document title', page.locator('.document-title'));
  await readable('library', page.locator('.library-entry').last());
  await readable('node text', page.locator('[data-node-id="root"] .node-text'));
  for (const [name, locator, property] of [
    ['node border', page.locator('[data-node-id="root"]'), 'border-top-color'],
    ['connection', page.locator('.connections > path').first(), 'stroke'],
    ['arrow', page.locator('.connections marker path'), 'stroke'],
  ]) {
    const sample = await readable(name, locator, { property, minimum: 3 });
    assert.ok(sample.foregroundLuminance > .5, `${name}深色模式应为亮色`);
  }
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await screenshot('theme-dark.png');

  stage = 'dark portal menu and input';
  await page.getByRole('button', { name: '更多操作：灵感整理', exact: true }).click();
  const menu = page.getByRole('menu');
  await readable('portal menu', menu.getByRole('menuitem', { name: '重命名', exact: true }));
  await screenshot('theme-dark-menu.png');
  await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名', exact: true });
  await readable('rename heading', rename.locator('h2'));
  const filename = rename.getByLabel('文件名', { exact: true });
  await filename.fill('临时名称');
  await readable('rename input', filename);
  await readable('rename save', rename.getByRole('button', { name: '保存', exact: true }), { dark: false });
  await screenshot('theme-dark-input.png');
  await rename.getByRole('button', { name: '取消', exact: true }).click();

  stage = 'dark search and help';
  await page.getByRole('button', { name: '查找节点 (Ctrl + F)', exact: true }).click();
  const search = page.getByRole('textbox', { name: '搜索内容', exact: true });
  await search.fill('阅读');
  await readable('search input', search);
  await readable('search result', page.locator('.search-results > button').first());
  await page.getByRole('button', { name: '关闭查找', exact: true }).click();
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await readable('file menu', page.locator('.file-menu > button').first());
  await page.locator('.file-menu').getByRole('button', { name: /^快捷键/ }).click();
  const help = page.getByRole('dialog', { name: '快捷键', exact: true });
  await readable('help heading', help.locator('h2'));
  await readable('help text', help.locator('.shortcut-grid > div > span').first());
  await page.getByRole('button', { name: '关闭快捷键', exact: true }).click();

  stage = 'outline and theme state isolation';
  await show('大纲');
  await expectWidth('大纲', 298);
  await readable('outline', page.locator('.outline-row > button[role="treeitem"]').first());
  await setTheme('light');
  await expectWidth('大纲', 298);
  assert.ok((await paint(page.locator('.outline-panel'))).backgroundLuminance > .8);
  await setTheme('dark');
  await show('导图库');
  await expectWidth('导图库', 328);
  assert.deepEqual(await stableState(), before);
  const rejection = await page.evaluate(async () => {
    try { await window.inkmap.setTheme('sepia'); return false; }
    catch { return true; }
  });
  assert.equal(rejection, true, '非法主题必须被IPC拒绝');
  assert.equal(await storedTheme(), 'dark');
  assert.equal(await page.evaluate(() => window.inkmap.getTheme()), 'dark');

  stage = 'edit and save in dark mode';
  await page.locator('[data-node-id="idea"]').dblclick();
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await readable('node editor', editor);
  await editor.fill('在深色下记录 English');
  await editor.press('Control+Enter');
  await page.locator('.app[data-save-state="saved"]').waitFor();
  await eventually(async () => JSON.parse(await fs.readFile(file, 'utf8')).nodes.idea.text === '在深色下记录 English', '深色模式编辑没有保存');
  const updated = await stableState();
  const updatedMermaid = await copy();
  assert.notEqual(updatedMermaid, mermaid);
  await setTheme('light');
  assert.deepEqual(await stableState(), updated);
  assert.equal(await copy(), updatedMermaid);
  await expectWidth('导图库', 328);
  await setTheme('dark');
  await close();

  stage = 'restart dark';
  await launch();
  assert.equal(await page.evaluate(() => window.inkmap.initialTheme), 'dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await fs.readFile(file, 'utf8'), updated.file);
  assert.equal(await page.locator('[data-node-id="idea"] .node-text').innerText(), '在深色下记录 English');
  await expectWidth('导图库', 248);
  assert.equal(await copy(), updatedMermaid);
  await setTheme('light');
  await close();

  stage = 'restart light';
  await launch();
  assert.equal(await page.evaluate(() => window.inkmap.initialTheme), 'light');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await storedTheme(), 'light');
  assert.equal(await fs.readFile(file, 'utf8'), updated.file);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, checks: ['real light/dark toggle', 'theme-only persistence', 'unchanged document, selection and in-window sidebar widths', 'theme-independent Mermaid', 'readable dark canvas, outline, library, portals, search and help', 'light node borders, connections and arrows', 'dark edit and save', 'invalid theme rejected', 'dark and light survive restart'], colors }, null, 2));
} catch (error) {
  console.error(`Theme test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, colors }, null, 2));
  if (page && !page.isClosed()) console.error(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
