import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'canvas-viewport-'));
const file = path.join(home, '导图', 'Viewport.mindmap');
const original = createDocument('Viewport');
original.nodes = { root: { id: 'root', text: 'Canvas viewport', children: [], collapsed: false } };
for (let row = 0; row < 12; row++) {
  let parent = 'root';
  for (let depth = 0; depth < 14; depth++) {
    const id = `r${row}d${depth}`;
    original.nodes[parent].children.push(id);
    original.nodes[id] = { id, text: `Row ${row}, level ${depth}\n中英文混排测试节点`, children: [], collapsed: false };
    parent = id;
  }
}
original.relationships = [{ id: 'relation', sourceId: 'r0d12', targetId: 'r11d12', text: '远端联系\nFar relationship' }];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page;
let stage = 'launch';
const checked = [];
const errors = [];
const eventually = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  } while (Date.now() < deadline);
  throw new Error(message);
};
const state = () => page.evaluate(() => {
  const rect = element => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const canvas = document.querySelector('.canvas');
  const bars = ['.selection-toolbar', '.zoom-controls'].map(selector => {
    const bar = canvas.querySelector(selector);
    if (!bar) return { selector, missing: true };
    return { selector, rect: rect(bar), buttons: [...bar.querySelectorAll('button')].map(button => {
      const box = rect(button);
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { name: button.getAttribute('aria-label') || button.title || button.textContent, rect: box, hit: !!hit && (hit === button || button.contains(hit)) };
    }) };
  });
  return {
    canvas: rect(canvas), bars,
    scroll: [...document.querySelectorAll('html, body, #root, .app, .workspace, .canvas')].map(element => ({ name: element.className || element.tagName, left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth, height: element.scrollHeight })),
    camera: getComputedStyle(document.querySelector('.world')).transform,
    active: document.activeElement?.className,
    editor: document.querySelector('.node-editor') ? rect(document.querySelector('.node-editor')) : null,
  };
});
const checkControls = async description => {
  const result = await state();
  const { canvas, bars } = result;
  for (const scroll of result.scroll) assert.deepEqual([scroll.left, scroll.top], [0, 0], `${description}: viewport must not become a browser scroll surface: ${JSON.stringify(result)}`);
  for (const bar of bars) {
    assert.ok(!bar.missing, `${description}: missing ${bar.selector}`);
    const box = bar.rect;
    assert.ok(Math.abs(box.left + box.width / 2 - canvas.left - canvas.width / 2) < 1.5, `${description}: ${bar.selector} must be centered: ${JSON.stringify(result)}`);
    assert.ok(box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom, `${description}: ${bar.selector} must remain inside viewport`);
    for (const button of bar.buttons) {
      const b = button.rect;
      assert.ok(b.width > 0 && b.height > 0 && b.left >= canvas.left && b.right <= canvas.right && b.top >= canvas.top && b.bottom <= canvas.bottom, `${description}: ${button.name} must be completely visible`);
      assert.equal(button.hit, true, `${description}: ${button.name} must be hit-testable`);
    }
  }
  assert.ok(bars[0].rect.bottom + 4 <= bars[1].rect.top, `${description}: toolbar rows must not overlap`);
  checked.push({ description, width: canvas.width, camera: result.camera });
};
const setWindow = async (width, height = 700) => {
  const actual = await app.evaluate(({ BrowserWindow }, [width, height]) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(width, height);
    return window.getContentSize();
  }, [width, height]);
  await eventually(async () => await page.evaluate(([width, height]) => Math.abs(innerWidth - width) < 2 && Math.abs(innerHeight - height) < 2, actual), 'Window content size did not update');
};
const pan = async (deltaX, deltaY) => {
  const before = (await state()).camera;
  const bounds = await page.locator('.canvas').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 20);
  await page.mouse.wheel(deltaX, deltaY);
  await eventually(async () => (await state()).camera !== before, 'Trackpad pan did not update the camera');
};
const editor = () => page.getByRole('textbox', { name: '编辑节点', exact: true });
const checkEditor = async description => {
  await editor().waitFor();
  const { canvas, editor: box, active } = await state();
  assert.equal(active, 'node-editor', `${description}: editor must have keyboard focus`);
  assert.ok(box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom, `${description}: edited node must be revealed by the camera`);
};
const finish = async () => {
  await editor().press('Control+Enter');
  await eventually(() => page.locator('.app[data-save-state="saved"]').count().then(count => count === 1), 'Edit did not save');
};
const setSidebar = async mode => {
  if (mode === 'library' && !await page.locator('.library-panel').count()) await page.getByRole('button', { name: '导图库', exact: true }).click();
  if (mode === 'outline' && !await page.locator('.outline-panel').count()) await page.getByRole('button', { name: '显示大纲', exact: true }).click();
  if (mode === 'none') {
    if (await page.locator('.library-panel').count()) await page.getByRole('button', { name: '导图库', exact: true }).click();
    if (await page.locator('.outline-panel').count()) await page.getByRole('button', { name: '显示大纲', exact: true }).click();
  } else {
    await page.getByRole('separator', { name: `调整${mode === 'library' ? '导图库' : '大纲'}宽度`, exact: true }).press('End');
  }
};
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
    if (png) await fs.writeFile(path.join(home, `${name}.png`), Buffer.from(png, 'base64'));
  } finally { clearTimeout(timer); }
};

try {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.mind-node[data-node-id="r11d13"]').waitFor();
  await setWindow(920);
  if (await page.locator('.library-panel').count()) await page.getByRole('button', { name: '导图库', exact: true }).click();
  await checkControls('large diagram initially fit');
  stage = 'zoom then edit selected offscreen root';
  await page.getByTitle('恢复 100%', { exact: true }).click();
  await checkControls('zoomed diagram');
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).waitFor();
  await checkControls(stage);
  await page.keyboard.press('Escape');
  stage = 'pan selected root beyond right edge then edit';
  await pan(-1800, -700);
  await checkControls('panned diagram before edit');
  await page.keyboard.press('F2');
  await editor().waitFor();
  await checkControls(stage);
  await checkEditor(stage);

  stage = 'typing multiline text and adding a child';
  await editor().fill('Canvas viewport\nLonger text changes the node height.\n节点文字\nMultiline content');
  await checkControls('editing larger node');
  await editor().press('Tab');
  await checkEditor('new child editing');
  await checkControls('new child editing');
  await editor().fill('Temporary child');
  await finish();
  await checkControls('new child saved');
  await page.keyboard.press('Delete');
  await checkControls('child deleted');
  await page.keyboard.press('Control+z');
  await checkControls('child restored by undo');
  await page.keyboard.press('Delete');

  stage = 'keyboard navigation into distant columns';
  await page.keyboard.press('ArrowLeft');
  for (let depth = 0; depth < 14; depth++) {
    await page.keyboard.press('ArrowRight');
    await checkControls(`keyboard depth ${depth}`);
  }
  await pan(-700, -400);
  await page.keyboard.press('F2');
  await checkControls('far node editor after pan');
  await checkEditor('far node editor after pan');
  await page.keyboard.press('Escape');
  console.log(`Canvas viewport: pan, edit, node actions and distant keyboard navigation passed (${checked.length} states).`);

  for (const width of [560, 1280, 720]) {
    await setWindow(width, width === 560 ? 420 : 700);
    for (const sidebar of ['none', 'library', 'outline']) {
      stage = `${width}px ${sidebar}: offscreen edit and resize`;
      await setSidebar(sidebar);
      await checkControls(`${stage} before pan`);
      await pan(-1100, -500);
      await page.getByRole('button', { name: '更多节点操作', exact: true }).click();
      await page.locator('.context-menu').getByText('编辑节点', { exact: true }).click();
      await checkControls(`${stage} editing`);
      await checkEditor(stage);
      await editor().press('ArrowRight');
      await editor().press('End');
      await checkControls(`${stage} caret moved`);
      await page.keyboard.press('Escape');
    }
    console.log(`Canvas viewport: ${width}px with both sidebars passed (${checked.length} states).`);
  }

  stage = 'split screen to maximized window and back without fitting';
  await setSidebar('none');
  await pan(-900, -300);
  await page.keyboard.press('F2');
  await checkControls('split screen before maximize');
  await capture('split-screen');
  const restoreSize = await page.evaluate(() => [innerWidth, innerHeight]);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await eventually(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), 'Window did not maximize');
  await eventually(async () => (await page.evaluate(() => innerWidth)) > restoreSize[0], 'Maximized size did not reach the renderer');
  await checkControls('maximized while editing panned node');
  await checkEditor('maximized while editing panned node');
  await capture('maximized');
  await editor().press('End');
  await checkControls('maximized caret movement');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
  await eventually(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMaximized()), 'Window did not restore');
  await eventually(async () => page.evaluate(([width, height]) => Math.abs(innerWidth - width) < 2 && Math.abs(innerHeight - height) < 2, restoreSize), 'Restored size did not reach the renderer');
  await checkControls('restored window while editing');
  await checkEditor('restored window while editing');
  await page.keyboard.press('Escape');
  console.log(`Canvas viewport: maximize and restore passed (${checked.length} states).`);

  stage = 'browser focus cannot shift viewport controls';
  await page.locator('.mind-node[data-node-id="r11d13"]').evaluate(node => {
    node.focus();
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  await checkControls(stage);
  stage = 'zoom and fit controls remain operational after interactions';
  const beforeZoom = (await state()).camera;
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await eventually(async () => (await state()).camera !== beforeZoom, 'Zoom control did not update camera');
  await checkControls(stage);
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  await checkControls('fit after distant edits');
  stage = 'relationship editing after panning';
  await page.locator('.relationship-label').click();
  await checkControls('relationship selected');
  await pan(-1100, -400);
  await page.getByRole('button', { name: '编辑联系文字', exact: true }).click();
  const relationshipEditor = page.getByRole('textbox', { name: '编辑联系文字', exact: true });
  await relationshipEditor.waitFor();
  await checkControls('offscreen relationship editor');
  await relationshipEditor.fill('Changed relationship\n联系编辑');
  await relationshipEditor.press('End');
  await checkControls('relationship typing and caret movement');
  await relationshipEditor.press('Escape');
  await checkControls('relationship edit cancelled');
  await eventually(() => page.locator('.app[data-save-state="saved"]').count().then(count => count === 1), 'Final edits did not save');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(saved.nodes).length, Object.keys(original.nodes).length, 'Only temporary test nodes should be removed');
  assert.deepEqual(saved.relationships, original.relationships, 'Cancelled relationship edits must preserve the document');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, scenarios: checked.length, checked }, null, 2));
} catch (error) {
  console.error(`Canvas viewport test failed at: ${stage}`, error);
  if (page && !page.isClosed()) {
    const diagnostic = { home, state: await state().catch(() => null), checked };
    await fs.writeFile(path.join(home, 'failure.json'), JSON.stringify(diagnostic, null, 2));
    await capture('viewport-failure').catch(() => {});
    console.error(JSON.stringify(diagnostic, null, 2));
  }
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
