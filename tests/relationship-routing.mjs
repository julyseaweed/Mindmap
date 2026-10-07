import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(process.env.INKMAP_TEST_RESULTS || os.tmpdir(), 'mindmap-relationship-routing-'));
const maps = path.join(home, '导图');
await fs.mkdir(maps, { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'));
const leaf = (id, text = id, children = []) => ({ id, text, children, collapsed: false });
const vertical = createDocument('Vertical corridor');
vertical.nodes = {
  root: leaf('root', 'Root', ['above', 'below']),
  above: leaf('above', '上方', ['above-child']),
  below: leaf('below', '下方', ['below-child']),
  'above-child': leaf('above-child', 'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight'),
  'below-child': leaf('below-child', 'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight'),
};
const blocked = createDocument('Blocked corridor');
blocked.nodes = { root: leaf('root', 'Root', ['above', 'middle', 'below']), above: leaf('above', '上方'), middle: leaf('middle', '中间障碍'), below: leaf('below', '下方') };
const horizontal = createDocument('Horizontal tree edge');
horizontal.nodes = { root: leaf('root', '母节点', ['child']), child: leaf('child', '子节点') };
const compact = createDocument('Compact label corridor');
compact.nodes = {
  root: leaf('root', 'Root', ['above', 'below']), above: leaf('above', '上方', ['above-child']),
  'above-child': leaf('above-child', 'One\nTwo\nThree\nFour'), below: leaf('below', '下方'),
};
const fixtures = [vertical, blocked, horizontal, compact];
const paths = new Map(fixtures.map(doc => [doc.title, path.join(maps, `${doc.title}.mindmap`)]));
for (const doc of fixtures) await fs.writeFile(paths.get(doc.title), JSON.stringify(doc, null, 2));
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: paths.get(vertical.title), recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page;
let stage = 'launch';
const errors = [];
const checks = [];
const screenshots = [];
const pdf = path.join(home, 'routing.pdf');
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const line = () => page.locator('.canvas .relationship-line');
const label = () => page.locator('.canvas .relationship-label');
const editor = () => page.getByRole('textbox', { name: '编辑联系文字', exact: true });
const read = title => fs.readFile(paths.get(title), 'utf8').then(JSON.parse);
const eventually = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const saved = (title, predicate) => eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && predicate(await read(title)), `${title}: 保存未完成`);
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const launch = async () => {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.setSize(1360, 900);
    // This suite must never access the actual system clipboard.
    for (const channel of ['clipboard:copy', 'clipboard:copy-image', 'clipboard:copy-branch', 'clipboard:paste-image', 'clipboard:paste-branch', 'clipboard:paste-text']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => { throw new Error(`Unexpected clipboard access: ${channel}`); });
    }
  });
  await node('root').waitFor();
  await fit();
};
const close = async () => {
  const current = app;
  const exited = new Promise(resolve => current.process().once('exit', resolve));
  await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭未完成')), 12000); })]); }
  finally { clearTimeout(timer); }
  await current.close().catch(() => {});
  app = null;
};
const open = async title => {
  await page.locator('.library-entry').filter({ hasText: title }).click();
  await eventually(async () => await page.locator('.document-title').innerText() === title, '切换导图未完成');
  await fit();
};
const create = async (source, target) => {
  await node(source).click();
  await page.getByRole('button', { name: '添加联系', exact: true }).click();
  await node(target).click();
  await editor().waitFor();
  assert.equal(await editor().inputValue(), '');
};
const geometry = () => page.locator('.canvas').evaluate(canvas => {
  const line = canvas.querySelector('.relationship-line');
  const points = Array.from({ length: 241 }, (_, index) => {
    const p = line.getPointAtLength(line.getTotalLength() * index / 240);
    return { x: p.x, y: p.y };
  });
  const nodes = Object.fromEntries([...canvas.querySelectorAll('.mind-node')].map(node => [node.dataset.nodeId, { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }]));
  const caption = canvas.querySelector('.relationship-label');
  return { path: line.getAttribute('d'), length: line.getTotalLength(), points, nodes, label: caption ? { x: parseFloat(caption.style.left), y: parseFloat(caption.style.top), width: parseFloat(caption.style.width), height: parseFloat(caption.style.height) } : null };
});
const clear = route => {
  for (const [id, box] of Object.entries(route.nodes)) {
    assert.equal(route.points.some(p => p.x > box.x + .5 && p.x < box.x + box.width - .5 && p.y > box.y + .5 && p.y < box.y + box.height - .5), false, `联系不得穿过 ${id}`);
    if (route.label) assert.equal(route.label.x < box.x + box.width - .5 && route.label.x + route.label.width > box.x + .5 && route.label.y < box.y + box.height - .5 && route.label.y + route.label.height > box.y + .5, false, `文字不得盖住 ${id}`);
  }
};
const directVertical = route => {
  clear(route);
  const a = route.nodes.above, b = route.nodes.below;
  const gap = b.y - a.y - a.height;
  assert.ok(Math.abs(route.points[0].y - a.y - a.height) < 1, '应从上方节点底边出发');
  assert.ok(Math.abs(route.points.at(-1).y - b.y) < 1, '应从下方节点顶边进入');
  assert.ok(Math.abs(route.points[0].x - a.x - a.width / 2) < 1 && Math.abs(route.points.at(-1).x - b.x - b.width / 2) < 1, '同列联系应连接两个相向边的中点');
  assert.ok(route.points.every(p => p.x >= a.x - 1 && p.x <= a.x + a.width + 1 && p.y >= a.y + a.height - 1 && p.y <= b.y + 1), '无障碍时应利用节点间空白，不绕到外侧');
  assert.ok(route.points.every((p, index) => index === 0 || p.y >= route.points[index - 1].y - .1), '上下连线不应掉头折返');
  assert.ok(route.length <= gap * 1.2, '无障碍上下联系不应大幅绕行');
};
const dragHandle = async (which, dx, dy, cancel = false) => {
  const handle = page.locator(`.canvas .relationship-handle[data-control="${which}"]`);
  const box = await handle.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
};
const capture = async name => {
  if (process.env.INKMAP_ROUTING_SCREENSHOT !== '1') return;
  const output = path.join(home, name);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  try {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: output, timeout: 10000 });
    screenshots.push(output);
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide()); }
};

try {
  await launch();
  stage = 'empty same-column relationship uses the free corridor';
  await create('above', 'below');
  const initial = await geometry();
  await fs.writeFile(path.join(home, 'initial-route.json'), JSON.stringify(initial, null, 2));
  if (process.env.INKMAP_ROUTING_REPRO === '1') {
    console.log(JSON.stringify({ repro: true, home, initial }, null, 2));
  } else {
    directVertical(initial);
    stage = 'ordinary typing keeps the compact route stable';
    const text = '关系\nRelation';
    for (const value of ['关', '关系', text]) {
      await editor().fill(value);
      const next = await geometry();
      directVertical(next);
      assert.equal(next.path, initial.path, '输入普通一两行说明不能令线路跳动');
    }
    await editor().press('Enter');
    await saved(vertical.title, doc => doc.relationships?.[0].text === text);
    await page.locator('.canvas').click({ position: { x: 40, y: 40 } });
    await fit();
    await capture('vertical-route.png');
    checks.push('empty and labeled same-column connections stay in the free corridor');

    stage = 'both fonts and themes keep the horizontal label opaque and editable';
    for (const font of ['serif', 'nevermind']) for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-font') !== font) { await page.locator('.font-toggle').click(); await page.waitForFunction(f => document.documentElement.dataset.font === f, font); }
      if (await page.locator('html').getAttribute('data-theme') !== theme) { await page.locator('.theme-toggle').click(); await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme); }
      await fit();
      directVertical(await geometry());
      const appearance = await label().evaluate(element => {
        const style = getComputedStyle(element), transform = new DOMMatrix(style.transform);
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { background: style.backgroundColor, paper: getComputedStyle(document.querySelector('.canvas')).backgroundColor, lineHeight: style.lineHeight, rotated: transform.b !== 0 || transform.c !== 0, hit: element === hit || element.contains(hit), clipped: element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1 };
      });
      assert.equal(appearance.background, appearance.paper);
      assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)');
      assert.equal(appearance.lineHeight, '21px');
      assert.equal(appearance.rotated, false); assert.equal(appearance.hit, true); assert.equal(appearance.clipped, false);
      await label().dblclick();
      assert.equal(await editor().evaluate(e => document.activeElement === e && getComputedStyle(e).borderTopWidth === '0px' && getComputedStyle(e).outlineStyle === 'none'), true);
      await editor().press('Escape');
    }
    checks.push('both fonts and themes: horizontal label masks the dashed line, frameless editor');

    stage = 'adding a child below moves only the endpoints and never folds through the source';
    await node('below').click();
    await page.getByTitle('添加子节点', { exact: true }).click();
    const nodeEditor = page.getByRole('textbox', { name: '编辑节点', exact: true });
    await nodeEditor.fill('New leaf'); await nodeEditor.press('Control+Enter');
    await saved(vertical.title, doc => doc.nodes.below.children.length === 2);
    await fit();
    directVertical(await geometry());
    await page.keyboard.press('Control+z');
    await saved(vertical.title, doc => doc.nodes.below.children.length === 1);
    assert.deepEqual((await read(vertical.title)).nodes, vertical.nodes);
    directVertical(await geometry());
    checks.push('adding a child to the lower endpoint preserves the free vertical corridor without a folded return');

    stage = 'manual controls, cancel, undo and save preserve the chosen shape';
    const automatic = await line().getAttribute('d');
    await label().click();
    await dragHandle(1, 75, 0);
    await saved(vertical.title, doc => !!doc.relationships?.[0].control1);
    const first = (await read(vertical.title)).relationships[0];
    assert.notEqual(await line().getAttribute('d'), automatic);
    await page.keyboard.press('Control+z');
    await saved(vertical.title, doc => !doc.relationships?.[0].control1);
    assert.equal(await line().getAttribute('d'), automatic);
    await page.keyboard.press('Control+Shift+z');
    await saved(vertical.title, doc => JSON.stringify(doc.relationships?.[0]) === JSON.stringify(first));
    await label().click();
    await dragHandle(2, 45, 0);
    await saved(vertical.title, doc => JSON.stringify(doc.relationships?.[0]) !== JSON.stringify(first));
    const shaped = (await read(vertical.title)).relationships[0];
    const shapedPath = await line().getAttribute('d');
    await label().click(); await dragHandle(1, -30, 20, true);
    assert.equal(await line().getAttribute('d'), shapedPath);
    await close(); await launch();
    assert.deepEqual((await read(vertical.title)).relationships, [shaped]);
    assert.equal(await line().getAttribute('d'), shapedPath);
    checks.push('both handles remain draggable; cancel, undo, redo and restart preserve manual controls');

    stage = 'white PDF preserves the curve and label without handles or clipping';
    await app.evaluate(({ BrowserWindow, dialog }, pdf) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents, print = contents.printToPDF.bind(contents);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf });
      contents.printToPDF = async options => {
        globalThis.__routingPdf = await contents.executeJavaScript(`(() => {
          const stage = document.querySelector('#pdf-export'), bounds = stage.getBoundingClientRect();
          const label = stage.querySelector('.relationship-label'), line = stage.querySelector('.relationship-line');
          return { path: line.getAttribute('d'), text: label.textContent, background: getComputedStyle(label).backgroundColor, stroke: getComputedStyle(line).stroke, dash: getComputedStyle(line).strokeDasharray, controls: stage.querySelectorAll('.relationship-handle, .relationship-hit, .relationship-guide').length, clipped: [...stage.querySelectorAll('.mind-node, .relationship-line, .relationship-label')].some(e => { const r=e.getBoundingClientRect();return r.left < bounds.left-1 || r.right > bounds.right+1 || r.top < bounds.top-1 || r.bottom > bounds.bottom+1; }) };
        })()`);
        return print(options);
      };
    }, pdf);
    await page.emulateMedia({ media: 'print' });
    await page.getByRole('button', { name: '文件菜单', exact: true }).click();
    await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
    await eventually(() => fs.stat(pdf).then(s => s.size > 1000).catch(() => false), 'PDF未生成', 30000);
    await eventually(async () => await page.locator('#pdf-export').count() === 0, 'PDF暂存未清理');
    await page.emulateMedia({ media: null });
    const printed = await app.evaluate(() => globalThis.__routingPdf);
    assert.equal(printed.path, shapedPath); assert.equal(printed.text.replace(/\s/g, ''), text.replace(/\s/g, ''));
    assert.equal(printed.background, 'rgb(255, 255, 255)'); assert.equal(printed.stroke, 'rgb(17, 17, 17)');
    assert.notEqual(printed.dash, 'none'); assert.equal(printed.controls, 0); assert.equal(printed.clipped, false);
    assert.equal((await fs.readFile(pdf)).subarray(0, 5).toString(), '%PDF-');
    checks.push('white PDF keeps the saved curve, label gap, dashed stroke and complete bounds');

    stage = 'two-line label fits a compact corridor without a false collision';
    await open(compact.title); await create('above', 'below');
    const compactEmpty = await geometry();
    directVertical(compactEmpty);
    assert.equal(compactEmpty.nodes.below.y - compactEmpty.nodes.above.y - compactEmpty.nodes.above.height, 59.5);
    await editor().fill(text); await editor().press('Enter');
    await saved(compact.title, doc => doc.relationships?.[0].text === text);
    const compactLabeled = await geometry();
    assert.equal(compactLabeled.label.height, 50, '两行文字应连同上下留白占50px');
    directVertical(compactLabeled);
    assert.equal(compactLabeled.path, compactEmpty.path, '实际放得下的两行文字不能迫使连线折返或绕路');
    checks.push('a 50px two-line label fits a 59.5px corridor without false collision or folded return');

    stage = 'an intervening node is avoided';
    await open(blocked.title); await create('above', 'below');
    await editor().fill('绕开障碍'); await editor().press('Enter');
    await saved(blocked.title, doc => doc.relationships?.[0].text === '绕开障碍');
    clear(await geometry());
    await page.locator('.canvas').click({ position: { x: 40, y: 40 } });
    await fit();
    await capture('blocked-route.png');
    checks.push('an intervening same-column node and all caption bounds are avoided');

    stage = 'same-row connection stays distinct from the existing parent-child edge';
    await open(horizontal.title); await create('root', 'child');
    await editor().fill('额外联系'); await editor().press('Enter');
    await saved(horizontal.title, doc => doc.relationships?.[0].text === '额外联系');
    const across = await geometry(); clear(across);
    const centerY = across.nodes.root.y + across.nodes.root.height / 2;
    assert.ok(across.points.filter(p => p.x > across.nodes.root.x + across.nodes.root.width + 5 && p.x < across.nodes.child.x - 5).every(p => Math.abs(p.y - centerY) > 5), '联系不能与同排父子实线重合');
    await page.locator('.canvas').click({ position: { x: 40, y: 40 } });
    await fit();
    await capture('horizontal-route.png');
    checks.push('same-row parent-child relationship avoids retracing its existing solid edge');

    for (const fixture of fixtures) assert.deepEqual((await read(fixture.title)).nodes, fixture.nodes, '联系编辑不能修改导图节点');
    assert.deepEqual(errors, []); assert.equal(await page.locator('.app-error, .save-error').count(), 0);
    console.log(JSON.stringify({ success: true, home, pdf, screenshots, initialRoute: { length: initial.length, endpointGap: initial.nodes.below.y - initial.nodes.above.y - initial.nodes.above.height, path: initial.path }, checks }, null, 2));
  }
} catch (error) {
  console.error(`Relationship routing test failed at: ${stage}`, error);
  console.error(JSON.stringify({ home, pdf }));
  if (page && !page.isClosed()) await geometry().then(route => fs.writeFile(path.join(home, 'failure-route.json'), JSON.stringify(route, null, 2))).catch(() => {});
  throw error;
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  if (app) await app.close().catch(() => {});
}
