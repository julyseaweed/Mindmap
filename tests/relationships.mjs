import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, toMermaid } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'relationships-'));
const file = path.join(home, '导图', '关系测试.mindmap');
const pdf = path.join(home, '关系测试.pdf');
const fixture = createDocument('关系测试');
fixture.nodes = {
  root: { id: 'root', text: '阅读与思考', children: ['alpha', 'beta', 'gamma'], collapsed: false },
  alpha: { id: 'alpha', text: '观察\nObservation', children: ['detail'], collapsed: false },
  detail: { id: 'detail', text: '一个具体例子', children: [], collapsed: false },
  beta: { id: 'beta', text: '推论\nConclusion', children: [], collapsed: false },
  gamma: { id: 'gamma', text: '其他思考', children: [], collapsed: false },
};
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, JSON.stringify(fixture, null, 2));
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const lines = () => page.locator('.canvas .relationship-line');
const label = () => page.locator('.canvas .relationship-label');
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 15000) => {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < until);
  throw new Error(message);
};
const saved = async predicate => {
  await eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && await predicate(await readDoc()), '联系没有按预期保存');
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
};
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const framelessEditor = async () => {
  const appearance = await page.locator('.relationship-editor').evaluate(editor => {
    const label = editor.closest('.relationship-label');
    const editorStyle = getComputedStyle(editor);
    return {
      focused: document.activeElement === editor,
      color: editorStyle.color,
      caret: editorStyle.caretColor,
      background: getComputedStyle(label).backgroundColor,
      paper: getComputedStyle(document.querySelector('.canvas')).backgroundColor,
      surfaces: [label, editor].map(element => {
        const style = getComputedStyle(element);
        return { outline: style.outlineStyle, shadow: style.boxShadow, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
      }),
    };
  });
  assert.equal(appearance.focused, true, '无框编辑仍应有输入焦点');
  assert.equal(appearance.caret, appearance.color, '光标应随文字颜色适应主题');
  assert.notEqual(appearance.caret, appearance.background);
  assert.equal(appearance.background, appearance.paper, '编辑时文字区域也应遮住虚线');
  for (const surface of appearance.surfaces) {
    assert.equal(surface.outline, 'none', '联系文字编辑时不能显示轮廓框');
    assert.equal(surface.shadow, 'none', '联系文字编辑时不能显示阴影框');
    assert.deepEqual(surface.borders, ['0px', '0px', '0px', '0px'], '联系文字编辑时不能显示边框');
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
    if (png) await fs.writeFile(path.join(home, name), Buffer.from(png, 'base64'));
    else console.log(`Optional screenshot skipped: ${name}`);
  } catch { console.log(`Optional screenshot unavailable: ${name}`); }
  finally { clearTimeout(timer); }
};
const launch = async () => {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const width = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1360, 900);
    return window.getContentSize()[0];
  });
  await eventually(async () => Math.abs(await page.evaluate(() => innerWidth) - width) < 3, '隐藏窗口尺寸未同步');
  await node('alpha').waitFor();
  await fit();
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
const dragControl = async (control, dx, dy, cancel = false) => {
  const handle = page.locator(`.canvas .relationship-handle[data-control="${control}"]`);
  const box = await handle.boundingBox();
  assert.ok(box, `第 ${control} 个曲线控制点应可见`);
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return { control: element?.getAttribute('data-control'), tag: element?.tagName, className: element?.getAttribute('class'), nodeId: element?.closest('[data-node-id]')?.getAttribute('data-node-id') };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(hit.control, String(control), `曲线控制点被其他元素遮住：${JSON.stringify(hit)}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
};

try {
  await launch();
  stage = 'cancel creation without changing nodes';
  await node('alpha').click();
  await page.getByRole('button', { name: '添加联系', exact: true }).click();
  await page.keyboard.press('Escape');
  await node('beta').click();
  assert.equal(await lines().count(), 0);
  assert.deepEqual((await readDoc()).nodes, fixture.nodes);

  stage = 'create labeled relationship';
  await node('alpha').click();
  await page.getByRole('button', { name: '添加联系', exact: true }).click();
  await node('beta').click();
  const editor = page.locator('.relationship-editor');
  await editor.waitFor();
  assert.equal(await editor.inputValue(), '');
  assert.equal(await editor.evaluate(element => document.activeElement === element), true);
  await framelessEditor();
  const text = '观察支持推论\nEvidence supports the conclusion';
  await editor.fill(text);
  await editor.press('Enter');
  await saved(doc => doc.relationships?.length === 1 && doc.relationships[0].text === text);
  const initial = (await readDoc()).relationships[0];
  assert.equal(initial.sourceId, 'alpha');
  assert.equal(initial.targetId, 'beta');
  assert.deepEqual((await readDoc()).nodes, fixture.nodes, '联系不能改变父子结构');
  assert.equal(await lines().count(), 1);
  assert.equal((await label().innerText()).replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.notEqual(await lines().evaluate(element => getComputedStyle(element).strokeDasharray), 'none');

  stage = 'default relationship route and label avoid existing nodes';
  const routeCollisions = await page.locator('.canvas').evaluate(canvas => {
    const line = canvas.querySelector('.relationship-line');
    const transform = line.getScreenCTM();
    const length = line.getTotalLength();
    const nodes = [...canvas.querySelectorAll('.mind-node')].map(element => ({ id: element.getAttribute('data-node-id'), box: element.getBoundingClientRect() }));
    const crossed = new Set();
    for (let distance = 2; distance < length - 2; distance += 2) {
      const point = line.getPointAtLength(distance).matrixTransform(transform);
      for (const { id, box } of nodes) {
        if (point.x > box.left + 0.5 && point.x < box.right - 0.5 && point.y > box.top + 0.5 && point.y < box.bottom - 0.5) crossed.add(id);
      }
    }
    const label = canvas.querySelector('.relationship-label').getBoundingClientRect();
    return {
      crossedNodes: [...crossed],
      labelOverlaps: nodes.filter(({ box }) => label.left < box.right - 0.5 && label.right > box.left + 0.5 && label.top < box.bottom - 0.5 && label.bottom > box.top + 0.5).map(({ id }) => id),
    };
  });
  assert.deepEqual(routeCollisions.crossedNodes, [], '自动联系线应绕开节点，包括右侧已有子节点');
  assert.deepEqual(routeCollisions.labelOverlaps, [], '自动联系文字应放在节点之外');

  stage = 'light and dark labels stay horizontal and cover the line';
  for (const theme of ['light', 'dark']) {
    const current = await page.locator('html').getAttribute('data-theme');
    if (current !== theme) await page.getByRole('button', { name: theme === 'dark' ? '切换到深色模式' : '切换到浅色模式', exact: true }).click();
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
    const appearance = await label().evaluate(element => {
      const style = getComputedStyle(element);
      const textStyle = getComputedStyle(element.querySelector('.relationship-label-text'));
      const matrix = new DOMMatrix(style.transform);
      return { background: style.backgroundColor, paper: getComputedStyle(document.querySelector('.canvas')).backgroundColor, color: textStyle.color, fontSize: textStyle.fontSize, weight: textStyle.fontWeight, rotated: matrix.b !== 0 || matrix.c !== 0, clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 };
    });
    assert.equal(appearance.background, appearance.paper, '联系文字应使用画布底色遮住虚线');
    assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(appearance.color, appearance.background);
    assert.equal(appearance.fontSize, '14px');
    assert.equal(appearance.weight, '400');
    assert.equal(appearance.rotated, false);
    assert.equal(appearance.clipped, false);
    await label().dblclick();
    await framelessEditor();
    assert.equal(await editor.inputValue(), text);
    await editor.press('Escape');
    await saved(doc => doc.relationships?.[0].text === text);
  }
  await capture('relationships-dark.png');

  stage = 'two draggable controls and one-step undo';
  await label().click();
  assert.equal(await page.locator('.canvas .relationship-handle').count(), 2);
  const initialPath = await lines().getAttribute('d');
  await dragControl(1, 70, -50);
  await saved(doc => !!doc.relationships?.[0].control1);
  const firstControl = (await readDoc()).relationships[0].control1;
  assert.notEqual(await lines().getAttribute('d'), initialPath);
  await page.keyboard.press('Control+z');
  await saved(doc => JSON.stringify(doc.relationships?.[0].control1) === JSON.stringify(initial.control1));
  assert.equal(await lines().getAttribute('d'), initialPath);
  await page.keyboard.press('Control+Shift+z');
  await saved(doc => JSON.stringify(doc.relationships?.[0].control1) === JSON.stringify(firstControl));
  await label().click();
  await dragControl(2, 45, 40);
  await saved(doc => !!doc.relationships?.[0].control2);
  const shaped = (await readDoc()).relationships[0];
  await label().click();
  await dragControl(1, -30, 30, true);
  await saved(doc => JSON.stringify(doc.relationships?.[0]) === JSON.stringify(shaped));

  stage = 'cancel text edit and native text editing';
  await label().dblclick();
  await editor.fill('取消这次编辑');
  await editor.press('Escape');
  await saved(doc => doc.relationships?.[0].text === text);
  await label().dblclick();
  await editor.press('Control+a');
  await editor.press('Backspace');
  assert.equal(await editor.inputValue(), '');
  assert.equal(await lines().count(), 1, '清空编辑文字不能误删联系');
  await editor.fill(text);
  await editor.press('Enter');

  stage = 'save and reopen exact shape';
  await saved(doc => JSON.stringify(doc.relationships?.[0]) === JSON.stringify(shaped));
  await close();
  await launch();
  assert.equal((await label().innerText()).replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.deepEqual((await readDoc()).relationships, [shaped]);

  stage = 'white PDF includes labels and curves without controls';
  await label().click();
  await app.evaluate(({ BrowserWindow, dialog }, target) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const print = contents.printToPDF.bind(contents);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    contents.printToPDF = async options => {
      globalThis.__relationshipPdf = await contents.executeJavaScript(`(() => {
        const stage = document.querySelector('#pdf-export');
        const label = stage.querySelector('.relationship-label');
        const line = stage.querySelector('.relationship-line');
        const rect = stage.getBoundingClientRect();
        return {
          text: label.textContent,
          background: getComputedStyle(label).backgroundColor,
          line: { color: getComputedStyle(line).stroke, width: getComputedStyle(line).strokeWidth, dash: getComputedStyle(line).strokeDasharray },
          controls: stage.querySelectorAll('.relationship-hit, .relationship-handle, .relationship-guide, [data-relationship-control]').length,
          selections: stage.querySelectorAll('[data-relationship-id].is-selected').length,
          outside: [...stage.querySelectorAll('.relationship-line, .relationship-label, .mind-node')].some(element => {
            const box = element.getBoundingClientRect();
            return box.left < rect.left - 1 || box.top < rect.top - 1 || box.right > rect.right + 1 || box.bottom > rect.bottom + 1;
          })
        };
      })()`);
      return print(options);
    };
  }, pdf);
  await page.emulateMedia({ media: 'print' });
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
  await eventually(async () => fs.stat(pdf).then(info => info.size > 1000).catch(() => false), '关系 PDF 未生成', 30000);
  await eventually(async () => await page.locator('#pdf-export').count() === 0, 'PDF 暂存未清理');
  await page.emulateMedia({ media: null });
  const print = await app.evaluate(() => globalThis.__relationshipPdf);
  assert.equal(print.text.replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(print.background, 'rgb(255, 255, 255)');
  assert.equal(print.line.color, 'rgb(17, 17, 17)');
  assert.equal(print.line.width, '1px');
  assert.notEqual(print.line.dash, 'none');
  assert.equal(print.controls, 0);
  assert.equal(print.selections, 0);
  assert.equal(print.outside, false, '导出页面不能裁切联系和文字');
  assert.equal((await fs.readFile(pdf)).subarray(0, 5).toString(), '%PDF-');

  stage = 'delete only the relationship, then undo';
  await label().click();
  await page.keyboard.press('Delete');
  await saved(doc => !doc.relationships?.length);
  assert.deepEqual((await readDoc()).nodes, fixture.nodes);
  assert.equal(await lines().count(), 0);
  await page.keyboard.press('Control+z');
  await saved(doc => doc.relationships?.length === 1);
  assert.deepEqual((await readDoc()).relationships, [shaped]);

  stage = 'delete endpoint cleans relationship and undo restores both';
  await node('beta').click();
  await page.keyboard.press('Delete');
  await saved(doc => !doc.nodes.beta && !doc.relationships?.length);
  assert.equal(await lines().count(), 0);
  await page.keyboard.press('Control+z');
  await saved(doc => !!doc.nodes.beta && doc.relationships?.length === 1);
  assert.deepEqual((await readDoc()).relationships, [shaped]);
  assert.deepEqual((await readDoc()).nodes, fixture.nodes);
  stage = 'actual Mermaid parses escaped relationship labels';
  const mermaidDoc = await readDoc();
  mermaidDoc.relationships[0].text = '中文 "quote" & #hash <tag> | pipe `tick` \\ path\n第二行';
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) => {
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    void window.loadURL('about:blank');
  });
  const mermaidPage = await nextWindow;
  await mermaidPage.addScriptTag({ path: path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') });
  const parsed = await mermaidPage.evaluate(async text => {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    const code = text.replace(/^```mermaid\n/, '').replace(/\n```\n?$/, '');
    await window.mermaid.parse(code);
    const rendered = await window.mermaid.render('relationship-test', code);
    document.body.innerHTML = rendered.svg;
    return { nodes: document.querySelectorAll('.node').length, text: document.body.textContent };
  }, toMermaid(mermaidDoc));
  assert.equal(parsed.nodes, Object.keys(fixture.nodes).length);
  assert.ok(parsed.text.includes('第二行'));
  await mermaidPage.close();
  assert.equal(await page.locator('.app-error, .save-error, .toast').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, home, pdf, checks: ['create and cancel', 'automatic route and label clear existing nodes', 'frameless focused editing in both themes', 'horizontal multiline label and paper gap in both themes', 'two draggable controls', 'drag and edit cancellation', 'one-step undo and redo', 'save and reopen shape', 'white PDF without controls or clipping', 'delete relationship independently', 'endpoint removal and undo'] }, null, 2));
} catch (error) {
  console.error(`Relationship test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, pdf }));
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({
    errors: [...document.querySelectorAll('.app-error, .save-error')].map(element => element.textContent),
    selectedNode: document.querySelector('.canvas .mind-node.selected')?.getAttribute('data-node-id'),
    selectedRelationships: [...document.querySelectorAll('.canvas [data-relationship-id].is-selected')].map(element => element.getAttribute('data-relationship-id')),
    paths: [...document.querySelectorAll('.canvas .relationship-line')].map(element => element.getAttribute('d')),
    controls: [...document.querySelectorAll('.canvas .relationship-handle')].map(element => ({ control: element.getAttribute('data-control'), cx: element.getAttribute('cx'), cy: element.getAttribute('cy') })),
    saveState: document.querySelector('.app')?.getAttribute('data-save-state'),
  })).catch(() => null));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
