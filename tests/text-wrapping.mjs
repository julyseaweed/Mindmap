import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'text-wrapping-'));
const file = path.join(home, '导图', '排版检查.mindmap');
const original = createDocument('排版检查');
original.columnWidths = { 1: 190 };
original.nodes = {
  root: { id: 'root', text: '排版 Typography', children: ['english', 'punctuation', 'long', 'manual'], collapsed: false },
  english: { id: 'english', text: 'Fresh ideas connect people and provide useful insight. Clear words belong together.', children: [], collapsed: false },
  punctuation: { id: 'punctuation', text: '甲乙丙丁戊己庚辛，壬癸「中文」；下一句。我们（认真阅读），理解《新的想法》！再想一想？English, words (stay together).\n甲乙丙中文，testing。\n“中文”English（中文）English', children: [], collapsed: false },
  long: { id: 'long', text: 'A Supercalifragilisticexpialidocious example remains readable.', children: [], collapsed: false },
  manual: { id: 'manual', text: 'Explicit line\n手动换行\n\nKeep this gap.', children: [], collapsed: false },
};
original.relationships = [{ id: 'relation', sourceId: 'english', targetId: 'punctuation', text: 'Related observations should keep whole words together, and respect punctuation. 中文联系（继续思考），把文字看清楚。' }];
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.mkdir(path.join(home, '.mindmap'), { recursive: true });
await fs.writeFile(file, JSON.stringify(original, null, 2));
await fs.writeFile(path.join(home, '.mindmap', 'workspace.json'), JSON.stringify({ current: file, recent: [] }));
await fs.writeFile(path.join(home, '.mindmap', 'appearance.json'), JSON.stringify({ theme: 'light', font: 'serif' }));
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
const page = await app.firstWindow();
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let stage = 'launch';
const report = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const lines = id => node(id).locator('.node-text > span').allTextContents();
const normalized = values => values.map(value => value.replace(/\u00a0/g, ' ').trim());
const eventually = async (check, message, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(message);
};
const fit = () => page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
const switchFont = async font => {
  if (await page.locator('html').getAttribute('data-font') === font) return;
  await page.getByRole('button', { name: font === 'serif' ? '切换到衬线体' : '切换到无衬线体', exact: true }).click();
  await page.locator(`html[data-font="${font}"]`).waitFor();
  await eventually(() => page.locator('.titlebar .font-toggle').isEnabled(), '字体尚未加载');
};
const switchTheme = async theme => {
  if (await page.locator('html').getAttribute('data-theme') === theme) return;
  await page.getByRole('button', { name: theme === 'dark' ? '切换到深色模式' : '切换到浅色模式', exact: true }).click();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
};
const checkLines = async (locator, text, label) => {
  const observed = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const lines = [...element.children].map(line => line.textContent);
    return {
      lines,
      width: parseFloat(style.width),
      widths: lines.map(line => context.measureText(line.trim()).width),
      words: [...new Set(element.textContent.match(/[A-Za-z]+/g) || [])].map(word => ({ word, width: context.measureText(word).width })),
      overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
    };
  });
  assert.equal(observed.lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), `${label}: 换行不能更改正文`);
  assert.equal(observed.overflow, false, `${label}: 正文不应裁切`);
  for (let i = 0; i < observed.lines.length; i++) {
    const line = observed.lines[i].trim();
    assert.ok(!/^[，。！？、；：）】》〉」』〕］｝,.!?;:)}\]]/.test(line), `${label}: 标点不能行首 ${JSON.stringify(observed.lines)}`);
    assert.ok(!/[（【《〈「『〔［｛({\[]$/.test(line), `${label}: 前括号不能行尾 ${JSON.stringify(observed.lines)}`);
    assert.ok(observed.widths[i] <= observed.width + 0.8, `${label}: 第 ${i + 1} 行超出框宽`);
  }
  for (const word of text.match(/[A-Za-z]+/g) || []) {
    const measured = observed.words.find(item => item.word === word);
    if (measured && measured.width <= observed.width) assert.ok(observed.lines.some(line => line.includes(word)), `${label}: ${word} 应完整换行`);
  }
  return observed.lines;
};

// A textarea does not expose its anonymous line boxes. Mirror its actual computed
// typography and wrapping properties, then use DOM ranges to observe Chromium's
// line breaks independently of the application's canvas-measurement algorithm.
const browserEditorLines = locator => locator.evaluate(editor => {
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  for (const property of ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'wordSpacing', 'lineHeight', 'whiteSpace', 'wordBreak', 'overflowWrap', 'lineBreak', 'textAlign', 'textIndent', 'direction', 'tabSize', 'textSpacingTrim', 'textAutospace']) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', width: style.width, padding: '0', margin: '0', border: 'none', visibility: 'hidden', boxSizing: 'content-box' });
  const text = document.createTextNode(editor.value);
  mirror.append(text);
  document.body.append(mirror);
  const lines = [];
  const starts = [];
  let lastTop = null;
  let current = '';
  try {
    for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(editor.value)) {
      if (segment === '\n') { lines.push(current); current = ''; lastTop = null; continue; }
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + segment.length);
      const rect = range.getBoundingClientRect();
      if (lastTop !== null && Math.abs(rect.top - lastTop) > 1) { lines.push(current); current = ''; }
      if (!current && segment.trim()) starts.push(rect.left - mirror.getBoundingClientRect().left);
      current += segment;
      lastTop = rect.top;
    }
    lines.push(current);
    return { lines, starts, wordBreak: style.wordBreak, lineBreak: style.lineBreak, clipped: editor.scrollWidth > editor.clientWidth + 1 || editor.scrollHeight > editor.clientHeight + 1 };
  } finally { mirror.remove(); }
});
const displayStarts = locator => locator.evaluateAll(spans => spans.filter(span => span.textContent.trim()).map(span => {
    const rect = span.getBoundingClientRect();
    const range = document.createRange();
    range.setStart(span.firstChild, 0); range.setEnd(span.firstChild, 1);
    const scale = new DOMMatrix(getComputedStyle(span.closest('.world')).transform).a;
    return (range.getBoundingClientRect().left - rect.left) / scale;
}));
const centered = (display, editor, label) => {
  assert.equal(display.length, editor.length, `${label}: 编辑前后应有相同的非空行`);
  for (let index = 0; index < display.length; index++) assert.ok(Math.abs(display[index] - editor[index]) < 0.2, `${label}: 第 ${index + 1} 行进入编辑时不能横向偏移 (${display[index]} → ${editor[index]})`);
};
const checkEditor = async (id, expected) => {
  const starts = await displayStarts(node(id).locator('.node-text > span'));
  await node(id).click();
  await node(id).focus();
  await page.keyboard.press('F2');
  const editor = page.getByRole('textbox', { name: '编辑节点', exact: true });
  await editor.waitFor();
  const observed = await browserEditorLines(editor);
  assert.equal(observed.wordBreak, 'normal');
  assert.equal(observed.lineBreak, 'strict');
  assert.equal(observed.clipped, false, `${id}: 编辑时不能裁切`);
  assert.deepEqual(normalized(observed.lines), normalized(expected), `${id}: 浏览器编辑器应与显示态换行一致`);
  centered(starts, observed.starts, id);
  await editor.press('Control+Enter');
  assert.deepEqual(await lines(id), expected, `${id}: 进入退出编辑不能重排文字`);
};
const snapshot = () => page.evaluate(() => ({
  nodes: Object.fromEntries([...document.querySelectorAll('.canvas .mind-node')].map(node => [node.dataset.nodeId, [...node.querySelectorAll('.node-text > span')].map(line => line.textContent)])),
  relations: Object.fromEntries([...document.querySelectorAll('.canvas .relationship-label')].map(label => [label.dataset.relationshipId, [...label.querySelectorAll('.relationship-label-text > span')].map(line => line.textContent)])),
}));

try {
  await node('english').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1420, 1020);
    window.webContents.backgroundThrottling = false;
  });
  await fit();
  stage = 'manual narrow column';
  await node('english').click();
  const handle = page.getByRole('separator', { name: '调整节点列宽', exact: true });
  const initial = Number(await handle.getAttribute('aria-valuenow'));
  const scale = await page.locator('.world').evaluate(world => new DOMMatrix(getComputedStyle(world).transform).a);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (130 - initial) * scale, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await eventually(async () => Number(await handle.getAttribute('aria-valuenow')) === 130, '拖动列宽未更新到 130px');
  await page.locator('.app[data-save-state="saved"]').waitFor();
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.columnWidths['1'], 130);
  assert.deepEqual(saved.nodes, original.nodes);
  await fit();

  for (const font of ['serif', 'nevermind']) {
    await switchFont(font);
    await fit();
    for (const theme of ['light', 'dark']) {
      stage = `${font} ${theme} display and editor`;
      console.log(`Text wrapping: ${stage}`);
      await switchTheme(theme);
      const observed = {};
      for (const [id, item] of Object.entries(original.nodes)) {
        observed[id] = await checkLines(node(id).locator('.node-text'), item.text, `${font} ${theme} ${id}`);
        await checkEditor(id, observed[id]);
      }
      assert.ok(observed.english.length > 2, '英语样例应发生自动换行');
      assert.ok(!observed.long.some(line => line.includes('Supercalifragilisticexpialidocious')), '超宽单词仍应紧急换行，不得溢出');
      assert.ok(observed.manual.includes(''), '显式空行应保留');
      const label = page.locator('.canvas .relationship-label');
      const relationLines = await checkLines(label.locator('.relationship-label-text'), original.relationships[0].text, `${font} ${theme} relation`);
      const relationStarts = await displayStarts(label.locator('.relationship-label-text > span'));
      await label.dblclick();
      const relationEditor = page.getByRole('textbox', { name: '编辑联系文字', exact: true });
      const editorLines = await browserEditorLines(relationEditor);
      assert.equal(editorLines.wordBreak, 'normal');
      assert.equal(editorLines.lineBreak, 'strict');
      assert.equal(editorLines.clipped, false, '联系编辑器不能裁切');
      assert.deepEqual(normalized(editorLines.lines), normalized(relationLines), '联系文字编辑与显示换行一致');
      centered(relationStarts, editorLines.starts, '联系');
      await relationEditor.press('Enter');
      report.push({ font, theme, nodes: observed, relationLines });
    }

    stage = `${font} white PDF retains displayed line breaks`;
    console.log(`Text wrapping: ${stage}`);
    const expected = await snapshot();
    const pdf = path.join(home, `${font}-wrapping.pdf`);
    await app.evaluate(({ BrowserWindow, dialog }, destination) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const realPrint = contents.printToPDF.bind(contents);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
      contents.printToPDF = async options => {
        globalThis.__wrappingPdf = await contents.executeJavaScript(`(() => {
          const host = document.querySelector('#pdf-export');
          return {
            background: getComputedStyle(host).backgroundColor,
            nodes: Object.fromEntries([...host.querySelectorAll('.mind-node')].map(node => [node.dataset.nodeId, [...node.querySelectorAll('.node-text > span')].map(line => line.textContent)])),
            relations: Object.fromEntries([...host.querySelectorAll('.relationship-label')].map(label => [label.dataset.relationshipId, [...label.querySelectorAll('.relationship-label-text > span')].map(line => line.textContent)])),
            editors: host.querySelectorAll('textarea').length
          };
        })()`);
        return realPrint(options);
      };
      globalThis.__wrappingRestorePrint = () => { contents.printToPDF = realPrint; };
    }, pdf);
    await page.emulateMedia({ media: 'print' });
    try {
      await page.getByRole('button', { name: '文件菜单', exact: true }).click();
      await page.getByRole('button', { name: '导出为 PDF', exact: true }).click();
      await eventually(() => fs.stat(pdf).then(stat => stat.size > 1000).catch(() => false), 'PDF 未写入隔离测试目录', 30000);
      await eventually(async () => await page.locator('#pdf-export').count() === 0, 'PDF 暂存未清除');
      const printed = await app.evaluate(() => globalThis.__wrappingPdf);
      assert.equal(printed.background, 'rgb(255, 255, 255)');
      assert.equal(printed.editors, 0);
      assert.deepEqual(printed.nodes, expected.nodes);
      assert.deepEqual(printed.relations, expected.relations);
      assert.ok((await fs.readFile(pdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));
    } finally {
      await page.emulateMedia({ media: null });
      await app.evaluate(() => globalThis.__wrappingRestorePrint());
    }
    await fit();
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    assert.deepEqual(await snapshot(), expected, '缩放不应改变段落换行');
    await page.locator('.zoom-value').click();
    assert.deepEqual(await snapshot(), expected, '回到 100% 不应改变段落换行');
    await fit();
  }
  const final = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(final.nodes, original.nodes, '排版不能写入硬换行或改变文本');
  assert.deepEqual(final.relationships, original.relationships);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(home, 'wrapping-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: true, home, checks: ['manual narrow column', 'whole English words', 'CJK and Latin punctuation', 'overlong token fallback', 'manual newlines', 'native editor line agreement', 'both fonts and themes', 'relationship text and editor', 'real white PDF line agreement', 'zoom stability', 'document text unchanged'] }, null, 2));
} catch (error) {
  console.error(`Text wrapping test failed at ${stage}`, error);
  console.error(JSON.stringify({ home, report }));
  throw error;
} finally {
  await app.close().catch(() => {});
}
