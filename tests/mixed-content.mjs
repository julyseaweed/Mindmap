import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.INKMAP_TEST_RESULTS || path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'mixed-content-'));
const file = path.join(home, '导图', '图文顺序.mindmap');
const pdf = path.join(home, '图文顺序.pdf');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABACAYAAADRTbMSAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGiSURBVHhe7dHNTQNBEAVhh0wIZGACIiAOEAPIEkjr0so/vb0zTW8dvosl7zx1nT6/Pr7V14k/qBcDN2fg5gzcnIGbM3BzBm7OwM0ZuDkDN2fg5p4O/PL6Vgr36ZqBA87v54fxv6MZ+EEMF8FvjmDgOxgpA9/Yk4FvYJhMfGsvBl7BGHvi29kMDAwwAjdkMvACDz8St2Qx8AKPPhK3ZDHwLx58Bm7KYOAicf9w21YGNvA1Hng27nsWD1wBN25h4JUDz8aNWxh45cCzceMWhw7Mw1bCrVEGLopbowxcFLdGGbgobo0ycFHcGnXYwDxoNdwbddjAFzxqJdwaZeCiuDXKwEVxa5SBi+LWKAMXxa1Rhw58wcNWwZ1RBl457mzcuIWBVw48GzducfjAFzzwTNy2lYENfI0Hno37onjoGbgpg4EXePCRuCWLgRd49JG4JYuBgYcfgRsyGXgFA+yJb2cz8A2MkYlv7cXAdzBMBr6xJwM/iJEi+M0RDBzAcPfw/yM9HVj/i4GbM3BzBm7OwM0ZuDkDN2fg5gzcnIGbM3BzBm7uB08tGWTqrda2AAAAAElFTkSuQmCC';
const picture = { id: 'picture', dataUrl: png, width: 120, height: 64, naturalWidth: 120, naturalHeight: 64 };
const above = '图片上方的说明\nText above the image';
const below = '图片下方也能继续记录\nText below the image';
const fixture = createDocument('图文顺序');
fixture.columnWidths = { 1: 270 };
fixture.nodes = {
  root: { id: 'root', text: '图文笔记', children: ['mixed', 'target'], collapsed: false },
  // A legacy document has no textSegments: its existing text must remain above the image.
  mixed: { id: 'mixed', text: above, images: [picture], children: ['child'], collapsed: false },
  child: { id: 'child', text: '原有子节点', children: [], collapsed: false },
  target: { id: 'target', text: '复制到这里', children: [], collapsed: false },
};
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(file, JSON.stringify(fixture));
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page, stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const image = (id = 'mixed', index = 0) => node(id).locator('.node-image').nth(index);
const editor = () => page.getByRole('textbox', { name: '编辑节点', exact: true });
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  throw new Error(message);
};
const saved = async check => {
  await eventually(async () => await page.locator('.app[data-save-state="saved"]').count() === 1 && check(await readDoc()), `修改未按预期保存 (${stage})`);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  return readDoc();
};
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const select = async id => { await fit(); await node(id).click({ position: { x: 2, y: 2 } }); await node(id).focus(); };
const finishEdit = async () => { if (await editor().count()) await editor().press('Control+Enter'); };
const imageMenu = async (name, id = 'mixed', index = 0) => {
  await fit();
  await image(id, index).click({ button: 'right' });
  await page.getByRole('menu', { name: '图片操作', exact: true }).getByRole('menuitem', { name, exact: true }).click();
};
const expectEditor = async (segment, value) => {
  await editor().waitFor();
  assert.equal(await editor().evaluate(element => element.closest('[data-text-segment]')?.getAttribute('data-text-segment')), String(segment));
  assert.equal(await editor().inputValue(), value);
  assert.equal(await editor().evaluate(element => document.activeElement === element), true);
};
const blocks = id => node(id).evaluate(element => [...element.querySelectorAll('[data-text-segment], .node-image')].map(block => {
  const rect = block.getBoundingClientRect();
  return { type: block.classList.contains('node-image') ? 'image' : 'text', top: rect.top, bottom: rect.bottom, height: rect.height };
}).filter(block => block.height > 0));
const ordered = async (id, expected) => {
  const content = await blocks(id);
  assert.deepEqual(content.map(block => block.type), expected, '文字和图片必须按内容顺序排列');
  for (let i = 1; i < content.length; i++) assert.ok(content[i].top >= content[i - 1].bottom - 1, '相邻图文不能重叠');
};
const noClipping = async () => {
  const issues = await page.locator('.canvas .mind-node').evaluateAll(nodes => nodes.flatMap(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('.node-text, .node-editor, .node-image')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || element.scrollHeight > element.clientHeight + 1 ? [node.getAttribute('data-node-id')] : [];
    });
  }));
  assert.deepEqual(issues, [], '图文或编辑框不能超出节点边框');
};
const capture = async name => {
  assert.equal(await page.locator('.node-image-menu').count(), 0, '编辑完成后不应保留图片菜单');
  let timer;
  try {
    await page.waitForTimeout(150);
    const png = await Promise.race([
      app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64')),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (png) await fs.writeFile(path.join(home, name), Buffer.from(png, 'base64'));
  } catch { console.log(`Optional screenshot unavailable: ${name}`); }
  finally { clearTimeout(timer); }
};
const launch = async () => {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1400, 960);
    globalThis.__mixedClipboard = { branch: null, image: null, text: '', copies: 0 };
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler); };
    // Every clipboard endpoint stays in memory; tests never touch the system clipboard.
    replace('clipboard:copy-branch', (_, branch) => { globalThis.__mixedClipboard = { branch, image: null, text: '', copies: globalThis.__mixedClipboard.copies + 1 }; });
    replace('clipboard:copy-image', (_, image) => { globalThis.__mixedClipboard = { branch: null, image, text: '', copies: globalThis.__mixedClipboard.copies + 1 }; });
    replace('clipboard:copy', (_, text) => { globalThis.__mixedClipboard = { branch: null, image: null, text, copies: globalThis.__mixedClipboard.copies + 1 }; });
    replace('clipboard:paste-branch', () => globalThis.__mixedClipboard.branch);
    replace('clipboard:paste-image', () => globalThis.__mixedClipboard.image);
    replace('clipboard:paste-text', () => globalThis.__mixedClipboard.text);
    return window.isVisible();
  }), false);
  await node('mixed').waitFor();
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

try {
  await launch();
  stage = 'legacy image supports text below and above';
  assert.equal((await readDoc()).nodes.mixed.text, above);
  await imageMenu('在图片下方输入');
  await expectEditor(1, '');
  await editor().fill(below); await finishEdit();
  await saved(doc => doc.nodes.mixed.text === `${above}\n${below}`);
  assert.deepEqual((await readDoc()).nodes.mixed.textSegments, [above, below]);
  await ordered('mixed', ['text', 'image', 'text']);
  const changedAbove = '更新上方说明\nUpdated image introduction';
  await imageMenu('在图片上方输入');
  await expectEditor(0, above);
  await editor().fill(changedAbove); await finishEdit();
  await saved(doc => doc.nodes.mixed.textSegments?.[0] === changedAbove);

  stage = 'double-click beside an image and image Enter edit following text';
  const bounds = await node('mixed').boundingBox(), pictureBounds = await image().boundingBox();
  assert.ok(bounds && pictureBounds && bounds.x + bounds.width - pictureBounds.x - pictureBounds.width > 10);
  await page.mouse.dblclick(bounds.x + bounds.width - 10, pictureBounds.y + pictureBounds.height / 2);
  await expectEditor(1, below); await editor().press('Escape');
  await image().click(); await page.keyboard.press('Enter');
  await expectEditor(1, below); await editor().press('Escape');

  stage = 'branch clipboard retains ordered content and children';
  await select('mixed'); await page.keyboard.press('Control+c');
  await eventually(() => app.evaluate(() => globalThis.__mixedClipboard.branch?.rootId === 'mixed'), '未复制整个图文分支');
  await select('target'); await page.keyboard.press('Control+v');
  const pastedDoc = await saved(doc => doc.nodes.target.children.length === 1);
  const pastedId = pastedDoc.nodes.target.children[0];
  assert.deepEqual(pastedDoc.nodes[pastedId].textSegments, [changedAbove, below]);
  assert.equal(pastedDoc.nodes[pastedDoc.nodes[pastedId].children[0]].text, fixture.nodes.child.text);
  assert.notEqual(pastedDoc.nodes[pastedId].images[0].id, picture.id);
  await fit(); await ordered(pastedId, ['text', 'image', 'text']);

  stage = 'individual image copy, cut, delete and undo preserve both text sides';
  await image().click(); await page.keyboard.press('Control+c');
  await eventually(() => app.evaluate(() => globalThis.__mixedClipboard.image?.id === 'picture'), '未复制单张图片');
  await select('target'); await page.keyboard.press('Control+v'); await finishEdit();
  await saved(doc => doc.nodes.target.images?.length === 1);
  assert.equal((await readDoc()).nodes.target.text, fixture.nodes.target.text);
  const beforeCut = (await readDoc()).nodes.mixed;
  await fit(); await image().click(); await page.keyboard.press('Control+x');
  await saved(doc => !doc.nodes.mixed.images?.length);
  assert.equal((await readDoc()).nodes.mixed.text, `${changedAbove}\n${below}`);
  await select('mixed'); await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.mixed.images?.length === 1);
  assert.deepEqual((await readDoc()).nodes.mixed, beforeCut);
  await imageMenu('删除图片');
  await saved(doc => !doc.nodes.mixed.images?.length);
  await select('mixed'); await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.mixed.images?.length === 1);
  assert.deepEqual((await readDoc()).nodes.mixed, beforeCut);

  stage = 'paste at the caret splits text and continues below the inserted picture';
  const prefix = '第二张图片之前 Before ', suffix = '之后 After';
  await imageMenu('在图片下方输入');
  await editor().fill(prefix + suffix);
  await editor().evaluate((element, offset) => element.setSelectionRange(offset, offset), prefix.length);
  // A synthetic paste carries only fixture bytes; no native paste action or real clipboard is used.
  await editor().evaluate((element, source) => {
    const bytes = Uint8Array.from(atob(source.split(',')[1]), value => value.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'fixture.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png);
  await eventually(async () => await image('mixed', 1).count() === 1, '光标处没有插入图片');
  await expectEditor(2, suffix);
  assert.equal(await editor().evaluate(element => element.selectionStart), 0, '粘贴后光标应在图片后文本的开头');
  assert.equal(await editor().evaluate(element => element.selectionEnd), 0, '粘贴后不应选中并覆盖原有后半段文字');
  await editor().press('Control+z');
  await saved(doc => doc.nodes.mixed.images?.length === 1 && doc.nodes.mixed.textSegments?.[1] === prefix + suffix);
  await select('mixed'); await page.keyboard.press('Control+Shift+z');
  await saved(doc => doc.nodes.mixed.images?.length === 2 && doc.nodes.mixed.textSegments?.[2] === suffix);
  await imageMenu('在图片下方输入', 'mixed', 1);
  await expectEditor(2, suffix);
  await editor().press('Home'); await page.keyboard.insertText('补充 '); await finishEdit();
  let expectedSegments = [changedAbove, prefix, '补充 ' + suffix];
  await saved(doc => doc.nodes.mixed.images?.length === 2 && doc.nodes.mixed.textSegments?.[2] === expectedSegments[2]);
  assert.deepEqual((await readDoc()).nodes.mixed.textSegments, expectedSegments);
  assert.equal((await readDoc()).nodes.mixed.text, expectedSegments.join('\n'));
  await ordered('mixed', ['text', 'image', 'text', 'image', 'text']);

  stage = 'paste directly after an image and retain empty text between adjacent pictures';
  const beforeAdjacent = (await readDoc()).nodes.mixed;
  await fit(); await image().click(); await page.keyboard.press('Control+c');
  await eventually(() => app.evaluate(() => globalThis.__mixedClipboard.image?.id === 'picture'), '未复制相邻图片 fixture');
  await page.keyboard.press('Control+v');
  await saved(doc => doc.nodes.mixed.images?.length === 3);
  await finishEdit();
  expectedSegments = [changedAbove, '', prefix, '补充 ' + suffix];
  let adjacent = (await readDoc()).nodes.mixed;
  assert.deepEqual(adjacent.textSegments, expectedSegments);
  assert.equal(adjacent.images[0].id, beforeAdjacent.images[0].id);
  assert.equal(adjacent.images[2].id, beforeAdjacent.images[1].id, '新图片必须插在当前图片之后，不能跳到节点底部');
  assert.ok(!beforeAdjacent.images.some(item => item.id === adjacent.images[1].id));
  assert.equal(adjacent.text, expectedSegments.filter(Boolean).join('\n'));
  await ordered('mixed', ['text', 'image', 'image', 'text', 'image', 'text']);
  await imageMenu('在图片下方输入', 'mixed', 0);
  await expectEditor(1, '');
  await editor().press('Delete');
  await expectEditor(1, '');
  assert.deepEqual((await readDoc()).nodes.mixed, adjacent, '空文字段按 Delete 不应删除节点或其他内容');
  await editor().fill('临时文字 Temporary text'); await editor().press('Escape');
  await saved(doc => doc.nodes.mixed.textSegments?.[1] === '');
  assert.deepEqual((await readDoc()).nodes.mixed, adjacent, 'Escape 应只回退当前段的临时文字');
  await imageMenu('删除图片', 'mixed', 1);
  await saved(doc => doc.nodes.mixed.images?.length === 2);
  assert.deepEqual((await readDoc()).nodes.mixed, beforeAdjacent, '删除相邻的新图不应丢失两侧文字或原图');
  await select('mixed'); await page.keyboard.press('Control+z');
  await saved(doc => doc.nodes.mixed.images?.length === 3);
  assert.deepEqual((await readDoc()).nodes.mixed, adjacent);

  stage = 'saved content survives a complete restart';
  const savedNodes = (await readDoc()).nodes;
  await close(); await launch();
  assert.deepEqual((await readDoc()).nodes, savedNodes);
  await ordered('mixed', ['text', 'image', 'image', 'text', 'image', 'text']);

  stage = 'themes, fonts and editing keep all content inside the node';
  for (const font of ['serif', 'nevermind']) {
    if (await page.locator('html').getAttribute('data-font') !== font) {
      await page.getByRole('button', { name: font === 'nevermind' ? '切换到无衬线体' : '切换到衬线体', exact: true }).click();
      await eventually(async () => await page.locator('.titlebar .font-toggle').isEnabled(), '字体尚未加载');
    }
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-toggle').click();
      await fit(); await noClipping();
      await ordered('mixed', ['text', 'image', 'image', 'text', 'image', 'text']);
      await imageMenu('在图片下方输入', 'mixed', 2);
      await expectEditor(3, expectedSegments[3]); await noClipping();
      await finishEdit();
      await capture(`${font}-${theme}.png`);
    }
  }

  stage = 'white PDF keeps text-image order from the dark canvas';
  const beforeExport = await fs.readFile(file, 'utf8');
  await app.evaluate(({ BrowserWindow, dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const print = contents.printToPDF.bind(contents);
    contents.printToPDF = async options => {
      globalThis.__mixedPdf = await contents.executeJavaScript(`(() => {
        const stage = document.querySelector('#pdf-export');
        const node = stage.querySelector('[data-node-id="mixed"]');
        return {
          background: getComputedStyle(stage).backgroundColor,
          editors: stage.querySelectorAll('textarea').length,
          blocks: [...node.querySelectorAll('[data-text-segment], .node-image')].filter(element => element.getBoundingClientRect().height > 0).map(element => ({ type: element.classList.contains('node-image') ? 'image' : 'text', top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom })),
          text: node.textContent
        };
      })()`);
      return print(options);
    };
  }, pdf);
  await page.emulateMedia({ media: 'print' });
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
  await eventually(() => fs.stat(pdf).then(info => info.size > 1000).catch(() => false), 'PDF 未生成', 30000);
  await eventually(async () => await page.locator('#pdf-export, .app.busy').count() === 0, 'PDF 导出没有清理');
  const printed = await app.evaluate(() => globalThis.__mixedPdf);
  await page.emulateMedia({ media: 'screen' });
  assert.equal(printed.background, 'rgb(255, 255, 255)');
  assert.equal(printed.editors, 0);
  assert.deepEqual(printed.blocks.map(block => block.type), ['text', 'image', 'image', 'text', 'image', 'text']);
  for (let i = 1; i < printed.blocks.length; i++) assert.ok(printed.blocks[i].top >= printed.blocks[i - 1].bottom - 1);
  for (const text of expectedSegments) assert.ok(printed.text.includes(text.replaceAll('\n', '')), 'PDF 缺少某段文字');
  const bytes = await fs.readFile(pdf);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.subarray(-1024).toString().includes('%%EOF'));
  assert.equal(await fs.readFile(file, 'utf8'), beforeExport);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  await close();
  console.log(JSON.stringify({ success: true, home, pdf, checks: ['legacy document', 'text above and below images', 'image-side double-click and Enter', 'whole branch clipboard', 'image copy/cut/delete and undo', 'caret insertion with immediate undo/redo', 'paste below images and continue typing', 'empty segment Delete and Escape', 'save and reopen', 'both fonts and themes', 'real white PDF with ordered blocks', 'no system clipboard access'] }, null, 2));
} catch (error) {
  console.error(`Mixed-content test failed at: ${stage}`);
  console.error(JSON.stringify({ home, pdf }));
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
}
