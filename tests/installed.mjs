import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultTarget = await fs.stat('D:\\apps').then(info => info.isDirectory()).catch(() => false)
  ? 'D:\\apps\\Mindmap'
  : path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'Programs', 'Mindmap');
const target = path.resolve(process.argv[2] || process.env.INKMAP_INSTALL_DIR || defaultTarget);
const results = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'installed-'));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const app = await electron.launch({ executablePath: path.join(target, "Mindmap.exe"), args: [], env, timeout: 30000 });
const errors = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.backgroundThrottling = false;
    window.setSize(1260, 820);
    window.webContents.invalidate();
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, name: app.getName(), userData: app.getPath('userData'), path: app.getAppPath() }));
  assert.equal(info.packaged, true);
  assert.equal(info.name, "Mindmap");
  assert.equal(info.userData, path.join(home, '.mindmap', 'runtime'));
  assert.equal(await page.evaluate(() => ['copyImage', 'pasteImage', 'copyBranch', 'pasteBranch', 'pasteText'].every(name => typeof window.inkmap[name] === 'function')), true);
  const state = JSON.parse(await fs.readFile(path.join(home, '.mindmap', 'workspace.json'), 'utf8'));
  assert.equal(path.dirname(state.current), path.join(home, '导图'));
  const doc = JSON.parse(await fs.readFile(state.current, 'utf8'));
  assert.equal(doc.nodes.root.text, '中心主题');
  assert.equal(Object.keys(doc.nodes).length, 1);
  assert.equal(await page.locator('.mind-node').count(), 1);
  const editor = page.getByRole('textbox', { name: '编辑节点' });
  await editor.waitFor();
  await page.waitForFunction(() => {
    const editor = document.querySelector('textarea[aria-label="编辑节点"]');
    return editor && document.activeElement === editor && editor.selectionStart === 0 && editor.selectionEnd === editor.value.length;
  });
  assert.equal(await editor.inputValue(), '中心主题');
  assert.equal(await page.locator('.canvas-label, .empty-hint, .canvas-meta, .statusbar, .titlebar-caption').count(), 0);
  assert.equal(await page.getByText('已保存到本地', { exact: true }).count(), 0);
  const brand = page.locator('.brand > span');
  assert.equal(await brand.isVisible(), true);
  assert.equal(await brand.innerText(), "Mindmap");
  assert.equal(await page.locator('.brand strong').count(), 0);
  const typography = await brand.evaluate(element => ({ weight: getComputedStyle(element).fontWeight, family: getComputedStyle(element).fontFamily }));
  assert.equal(typography.weight, '400');
  assert.ok(typography.family.includes('URW Classico'));
  assert.ok((await editor.evaluate(element => getComputedStyle(element).fontFamily)).includes('PMingLiU'));
  assert.equal(await page.evaluate(() => document.fonts.check('16px "URW Classico"', "Mindmap")), true);
  assert.equal(await page.locator('.app-icon').evaluate(img => img.complete && img.naturalWidth > 0), true);
  // Visual layout is captured in the desktop/library checks; this hidden packaged
  // smoke check verifies rendering state, persistence, and IPC without a compositor capture.
  await page.keyboard.insertText('标题联动检查');
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === '标题联动检查');
  await page.locator('.app[data-save-state="saved"]').waitFor();
  assert.equal(JSON.parse(await fs.readFile(state.current, 'utf8')).title, '标题联动检查');
  const library = page.getByRole('complementary', { name: '导图库' });
  await library.getByRole('button', { name: '标题联动检查', exact: true }).waitFor();
  assert.equal(await library.locator('.library-root').count(), 0);
  assert.equal(await library.locator('.library-item').count(), 1);
  assert.equal(await library.locator('.library-row.is-selected').count(), 1);
  const scroll = library.locator('.library-scroll');
  const scrollBox = await scroll.boundingBox();
  await scroll.click({ position: { x: scrollBox.width / 2, y: scrollBox.height - 10 } });
  assert.equal(await library.locator('.library-row.is-selected').count(), 0);
  assert.equal(await page.locator('.document-title').innerText(), '标题联动检查');
  await library.getByRole('button', { name: '标题联动检查', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).waitFor();
  assert.equal(await library.locator('.library-row.is-selected').count(), 1);
  assert.equal(await library.locator('.library-row.is-selected').getAttribute('data-library-path'), state.current);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  assert.equal(await page.getByText('最近打开', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, ...info, home, currentFile: state.current, cleanStartup: true, typography, customIcon: true }, null, 2));
} finally { await app.close(); }
