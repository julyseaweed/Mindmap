import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, welcomeDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'desktop-'));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-node-id="root"]').waitFor({ timeout: 15000 });
  return page;
};
const readCurrent = async () => {
  const state = JSON.parse(await fs.readFile(path.join(home, '.mindmap', 'workspace.json'), 'utf8'));
  return JSON.parse(await fs.readFile(state.current, 'utf8'));
};
const waitSave = async page => {
  await page.locator('.app[data-save-state="saved"]').waitFor();
};
const expectTitle = (page, title) => page.waitForFunction(expected => document.querySelector('.document-title')?.textContent === expected, title);
const selectedId = page => page.locator('.mind-node.selected').getAttribute('data-node-id');
const expectBlankEditor = async page => {
  await page.waitForFunction(() => {
    const editor = document.querySelector('textarea[aria-label="编辑节点"]');
    return editor && document.activeElement === editor && editor.value === '' && !editor.placeholder && editor.selectionStart === 0 && editor.selectionEnd === 0;
  });
};
try {
  let page = await launch();
  assert.equal(await page.locator('.mind-node').count(), 1);
  const initialEditor = page.getByRole('textbox', { name: '编辑节点' });
  await initialEditor.waitFor();
  await expectBlankEditor(page);
  assert.equal(await page.locator('.canvas-label, .empty-hint, .canvas-meta, .statusbar, .titlebar-caption').count(), 0);
  assert.equal(await page.getByText('已保存到本地', { exact: true }).count(), 0);
  assert.equal(await page.locator('.brand > span').innerText(), "Mindmap");
  assert.equal(await page.locator('.brand > span').evaluate(element => getComputedStyle(element).fontWeight), '400');
  assert.equal(await page.locator('.brand strong').count(), 0);
  await page.screenshot({ path: path.join(results, '01-clean-start.png') });

  // The empty editor accepts typing immediately, without a preliminary click.
  await page.keyboard.insertText('直接开始记录');
  await expectTitle(page, '直接开始记录');
  assert.equal(await initialEditor.isVisible(), true);
  await waitSave(page);
  let savedTitleDoc = await readCurrent();
  assert.equal(savedTitleDoc.title, '直接开始记录');
  assert.equal(savedTitleDoc.nodes.root.text, '直接开始记录');
  await page.keyboard.press('Control+Enter');

  // A root edit updates the title live; cancelling restores both, including on disk.
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点' }).fill('  新的   思路\n继续记录  ');
  await expectTitle(page, '新的 思路 继续记录');
  await page.keyboard.press('Escape');
  await expectTitle(page, '直接开始记录');
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), '直接开始记录');
  await waitSave(page);
  savedTitleDoc = await readCurrent();
  assert.equal(savedTitleDoc.title, '直接开始记录');
  assert.equal(savedTitleDoc.nodes.root.text, '直接开始记录');

  // The original edit is one undo step containing the node and its automatic title.
  await page.keyboard.press('Control+z');
  await expectTitle(page, '未命名导图');
  assert.equal((await page.locator('[data-node-id="root"] .node-text').innerText()).trim(), '');
  await waitSave(page);
  savedTitleDoc = await readCurrent();
  assert.equal(savedTitleDoc.title, '未命名导图');
  assert.equal(savedTitleDoc.nodes.root.text, '');
  await page.keyboard.press('Control+Shift+z');
  await expectTitle(page, '直接开始记录');
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), '直接开始记录');
  await waitSave(page);
  savedTitleDoc = await readCurrent();
  assert.equal(savedTitleDoc.title, '直接开始记录');
  assert.equal(savedTitleDoc.nodes.root.text, '直接开始记录');

  // An explicitly chosen file title remains independent when the root text changes.
  await page.locator('.document-title').click();
  await page.getByRole('textbox', { name: '导图名称' }).fill('独立文件名');
  await page.getByRole('textbox', { name: '导图名称' }).press('Enter');
  await expectTitle(page, '独立文件名');
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), '直接开始记录');
  await page.locator('[data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点' }).fill('中心节点的新内容');
  await expectTitle(page, '独立文件名');
  await page.keyboard.press('Control+Enter');
  await waitSave(page);
  savedTitleDoc = await readCurrent();
  assert.equal(savedTitleDoc.title, '独立文件名');
  assert.equal(savedTitleDoc.nodes.root.text, '中心节点的新内容');

  // Existing unnamed files gain a title from their root text and save it in place.
  const legacyPath = path.join(home, '导图', '旧未命名导图.mindmap');
  const legacyDoc = welcomeDocument();
  legacyDoc.title = '未命名导图';
  legacyDoc.nodes.root.text = '旧导图\n已有  名称';
  await fs.writeFile(legacyPath, JSON.stringify(legacyDoc, null, 2), 'utf8');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, legacyPath);
  await page.keyboard.press('Control+o');
  await expectTitle(page, '旧导图 已有 名称');
  await waitSave(page);
  const migratedDoc = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
  assert.equal(migratedDoc.title, '旧导图 已有 名称');
  assert.deepEqual(migratedDoc.nodes, legacyDoc.nodes);
  assert.equal((await readCurrent()).title, migratedDoc.title);

  // A saved image-only root is content, so reopening it must not start text editing.
  const picturePath = path.join(home, '导图', '图片导图.mindmap');
  const pictureDoc = createDocument();
  pictureDoc.nodes.root.images = [{ id: 'picture', width: 64, height: 64, naturalWidth: 1, naturalHeight: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=' }];
  const pictureBytes = JSON.stringify(pictureDoc, null, 2);
  await fs.writeFile(picturePath, pictureBytes, 'utf8');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, picturePath);
  await page.keyboard.press('Control+o');
  await page.locator('[data-image-id="picture"]').waitFor();
  assert.equal(await page.locator('.node-editor').count(), 0);
  await waitSave(page);
  assert.equal(await fs.readFile(picturePath, 'utf8'), pictureBytes);

  // Complex interaction checks use an explicit test fixture, never startup instructions.
  const fixturePath = path.join(home, '导图', '交互测试.mindmap');
  await fs.writeFile(fixturePath, JSON.stringify(welcomeDocument(), null, 2), 'utf8');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fixturePath);
  await page.keyboard.press('Control+o');
  await expectTitle(page, '从一个想法开始');
  await page.locator('[data-node-id="keep"]').waitFor();
  assert.equal(await page.locator('.mind-node').count(), 9);
  await page.locator('[data-node-id="root"]').click();
  await page.keyboard.press('Tab');
  await expectBlankEditor(page);
  await page.keyboard.insertText('边看边记录');
  const branch = await selectedId(page);
  await page.keyboard.press('Tab');
  await page.getByRole('textbox', { name: '编辑节点' }).fill('中文 "双引号" & #标签 <script> `反引号`');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.insertText('第二行');
  const child = await selectedId(page);
  await page.keyboard.press('Enter');
  await expectBlankEditor(page);
  await page.keyboard.insertText('下一个观点');
  const sibling = await selectedId(page);
  await page.keyboard.press('Control+Enter');
  await waitSave(page);
  let stored = await readCurrent();
  assert.deepEqual(stored.nodes[branch].children, [child, sibling]);
  assert.ok(stored.nodes[child].text.endsWith('\n第二行'));
  assert.ok(stored.nodes[child].text.includes('<script>'));
  assert.equal(await page.locator('.mind-node').count(), 12);

  // Chinese IME candidate confirmation must not create an extra sibling.
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点' }).evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await page.locator('.mind-node').count(), 12);
  await page.keyboard.press('Control+Enter');

  // Collapsing affects editing only, not the Mermaid result.
  await page.locator(`[data-node-id="${branch}"]`).click();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.mind-node').count(), 10);
  await app.evaluate(({ clipboard }) => {
    // Native clipboard behavior is covered by the media/clipboard suites. Capture
    // this renderer-to-main export locally so the general UI suite stays isolated.
    globalThis.__desktopWriteText = clipboard.writeText;
    clipboard.writeText = async text => { globalThis.__desktopCopiedText = text; };
  });
  let mermaid;
  try {
    await page.getByRole('button', { name: '复制到 Obsidian', exact: true }).click();
    mermaid = await app.evaluate(() => globalThis.__desktopCopiedText);
  } finally {
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = globalThis.__desktopWriteText;
      delete globalThis.__desktopWriteText;
      delete globalThis.__desktopCopiedText;
    });
  }
  assert.ok(mermaid.startsWith('```mermaid\n'));
  assert.ok(mermaid.includes('#34;双引号#34;'));
  assert.ok(mermaid.includes('第二行'));
  await fs.writeFile(path.join(results, 'export.md'), mermaid, 'utf8');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('.mind-node').count(), 12);

  // Delete and undo restore the entire subtree.
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('.mind-node').count(), 9);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('.mind-node').count(), 12);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await page.locator('.mind-node').count(), 9);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('.mind-node').count(), 12);

  // Actual mouse drag changes the parent, rather than just its screen coordinates.
  await page.keyboard.press('Control+0');
  const source = await page.locator(`[data-node-id="${sibling}"]`).boundingBox();
  const target = await page.locator('[data-node-id="keep"]').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await waitSave(page);
  stored = await readCurrent();
  assert.ok(stored.nodes.keep.children.includes(sibling));
  assert.ok(!stored.nodes[branch].children.includes(sibling));

  // Search finds content inside a collapsed branch and reveals it.
  await page.locator(`[data-node-id="${branch}"]`).click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: '搜索内容' }).fill('第二行');
  await page.getByRole('textbox', { name: '搜索内容' }).press('Enter');
  assert.equal(await selectedId(page), child);
  await page.getByRole('button', { name: '关闭查找', exact: true }).click();

  // Check renderer markup/style matches the agreed black thin outlines.
  const style = await page.locator('.mind-node.selected').evaluate(element => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow }));
  assert.equal(style.border, 'rgb(17, 17, 17)');
  assert.ok(style.shadow.includes('1.2px'));
  assert.equal(await page.locator('.connections > path').first().evaluate(element => getComputedStyle(element).stroke), 'rgb(17, 17, 17)');
  await page.keyboard.press('Control+0');
  await page.screenshot({ path: path.join(results, '02-edited.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 800));
  await page.keyboard.press('Control+0');
  await page.screenshot({ path: path.join(results, '03-half-screen.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 820));

  // Saving a copy must keep the source document, selection, view and undo history active.
  await waitSave(page);
  const restoredWidth = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()[0]);
  await page.waitForFunction(width => Math.abs(innerWidth - width) < 3, restoredWidth);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sourceSession = await page.evaluate(() => window.inkmap.boot());
  const sourceSelection = await selectedId(page);
  const sourceView = await page.locator('.canvas > .world').evaluate(element => element.style.transform);
  const sourceUndo = await page.getByRole('button', { name: '撤销 (Ctrl + Z)', exact: true }).isEnabled();
  const copyPath = path.join(home, '测试副本.mindmap');
  await app.evaluate(({ dialog }, targetPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath }); }, copyPath);
  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(500);
  assert.ok((await fs.readFile(copyPath, 'utf8')).includes('边看边记录'));
  const afterCopySession = await page.evaluate(() => window.inkmap.boot());
  assert.equal(afterCopySession.path, sourceSession.path, '保存副本不应切换工作文件');
  assert.equal(afterCopySession.token, sourceSession.token);
  assert.equal(await selectedId(page), sourceSelection);
  assert.equal(await page.locator('.canvas > .world').evaluate(element => element.style.transform), sourceView);
  assert.equal(await page.getByRole('button', { name: '撤销 (Ctrl + Z)', exact: true }).isEnabled(), sourceUndo);
  const mdPath = path.join(home, '导图', '测试导出.md');
  await app.evaluate(({ dialog }, targetPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath }); }, mdPath);
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 Markdown', exact: true }).click();
  await page.waitForTimeout(400);
  assert.ok((await fs.readFile(mdPath, 'utf8')).startsWith('```mermaid'));

  // Close while text is still being edited, then relaunch from the same app directory.
  await page.locator('[data-node-id="root"]').dblclick();
  await page.getByRole('textbox', { name: '编辑节点' }).fill('关闭前最后一个想法');
  await expectTitle(page, '关闭前最后一个想法');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await app.process().exitCode;
  await app.close().catch(() => {});
  page = await launch();
  assert.equal(await page.locator('[data-node-id="root"] .node-text').innerText(), '关闭前最后一个想法');
  await expectTitle(page, '关闭前最后一个想法');
  assert.equal((await readCurrent()).title, '关闭前最后一个想法');

  // Validate exported syntax with the actual Mermaid renderer in an isolated test window.
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) => { const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } }); void window.loadURL('about:blank'); });
  const mermaidPage = await nextWindow;
  await mermaidPage.addScriptTag({ path: path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') });
  const parsed = await mermaidPage.evaluate(async text => {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    const code = text.replace(/^```mermaid\n/, '').replace(/\n```\n?$/, '');
    await window.mermaid.parse(code);
    const rendered = await window.mermaid.render('test-map', code);
    document.body.innerHTML = rendered.svg;
    return { nodes: document.querySelectorAll('.node').length, text: document.body.textContent };
  }, mermaid);
  assert.equal(parsed.nodes, 12);
  assert.ok(parsed.text.includes('第二行'));
  await mermaidPage.screenshot({ path: path.join(results, '04-mermaid-export.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, rendererErrors: errors, checks: ['clean startup', 'immediate typing and autosave', 'live root title and persistence', 'root title cancel and undo/redo', 'custom title preservation', 'legacy unnamed title migration', 'uniform title weight', 'keyboard', 'Chinese IME', 'multiline', 'folding', 'subtree undo/redo', 'drag reparent', 'search hidden nodes', 'black outline style', 'half-screen', 'native save-as', 'Markdown export', 'close/reopen title persistence', 'Mermaid rendering'] }, null, 2));
} catch (error) {
  if (app) { try { const page = await app.firstWindow(); await page.screenshot({ path: path.join(results, 'failure.png') }); console.error(await page.locator('body').innerText()); } catch {} }
  throw error;
} finally {
  await app?.close().catch(() => {});
}
