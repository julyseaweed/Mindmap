import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'import-desktop-'));
const maps = path.join(home, '导图');
const originalFile = path.join(maps, '原来的工作.mindmap');
const workspace = path.join(home, '.mindmap', 'workspace.json');
const markdown = path.join(home, '外部笔记.md');
const mermaid = path.join(home, '外部流程.mermaid');
const internal = path.join(maps, '阅读文件夹', '文件夹里的笔记.markdown');
const invalid = path.join(home, '不支持的图.mmd');
const flowchart = 'flowchart LR\nA["阅读"] --> B["笔记"]\nA --> C["想法"]\nB -.->|"启发"| C\n';
const markdownBytes = `# 阅读记录\n\n\`\`\`mermaid\n${flowchart}\`\`\`\n`;
const internalBytes = '# 书单\n\n## 本周\n\n- 阅读第一章\n  - 记录问题\n';
const original = createDocument('原来的工作');
original.nodes.root.text = '原来的工作';
await fs.mkdir(path.dirname(internal), { recursive: true });
await fs.mkdir(path.dirname(workspace), { recursive: true });
await fs.writeFile(originalFile, JSON.stringify(original));
await fs.writeFile(workspace, JSON.stringify({ current: originalFile, recent: [] }));
await fs.writeFile(markdown, markdownBytes);
await fs.writeFile(mermaid, flowchart);
await fs.writeFile(internal, internalBytes);
await fs.writeFile(invalid, 'sequenceDiagram\nAlice->>Bob: Hello');
const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app, page, stage = 'launch';
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const session = () => page.evaluate(() => window.inkmap.boot());
const readDoc = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(message);
};
const launch = async initialFile => {
  const executablePath = process.env.INKMAP_TEST_EXECUTABLE;
  const incoming = initialFile ? [initialFile] : [];
  app = await electron.launch({ ...(executablePath ? { executablePath, args: incoming } : { args: [root, ...incoming] }), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1260, 860); return window.isVisible();
  }), false);
  await page.locator('.canvas .mind-node').first().waitFor();
};
const close = async () => {
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('关闭时未完成保存')), 15000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {}); app = null; page = null;
};
const chooseFile = async file => {
  await app.evaluate(({ dialog }, selected) => {
    globalThis.__importPickerCalls = 0;
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__importPickerCalls++;
      globalThis.__importPickerOptions = options;
      return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
    };
  }, file);
};
const open = async file => {
  const before = await session();
  await chooseFile(file);
  await page.keyboard.press('Control+o');
  const imported = await eventually(async () => {
    const active = await session();
    return active.token !== before.token ? active : false;
  }, '打开导图未切换到导入结果');
  await page.locator('.app:not(.busy)').waitFor();
  return imported;
};
const selectedNode = () => page.locator('.canvas .mind-node.selected').getAttribute('data-node-id');
const saved = async predicate => eventually(async () => {
  if (await page.locator('.app[data-save-state="saved"]').count() !== 1) return false;
  const active = await session();
  return await predicate(active, await readDoc(active.path)) ? active : false;
}, '导入后编辑未完成保存');
const menuLabels = async () => {
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  const labels = await page.locator('.file-menu button').evaluateAll(buttons => buttons.map(button => button.textContent?.replace(/\s+/g, ' ').trim()));
  await page.keyboard.press('Escape');
  assert.ok(labels.length >= 7, '文件菜单结构应保留');
  return labels;
};

try {
  await launch();
  const originalMenu = await menuLabels();
  assert.equal(originalMenu.filter(label => /打开导图/.test(label)).length, 1);
  assert.ok(originalMenu.every(label => !/导入 Markdown|导入 Mermaid/.test(label)), '扩展原有打开命令，不另加菜单');

  stage = 'cancel picker preserves existing document and node selection';
  await node('root').click(); await node('root').focus();
  const beforeCancel = await session();
  await chooseFile(null); await page.keyboard.press('Control+o');
  await eventually(() => app.evaluate(() => globalThis.__importPickerCalls === 1), '取消选择未调用原有打开命令');
  await page.locator('.app:not(.busy)').waitFor();
  assert.equal((await session()).token, beforeCancel.token);
  assert.equal(await selectedNode(), 'root');

  stage = 'dirty editor is saved before Markdown import through existing menu';
  await node('root').focus(); await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill('切换前最后输入的内容');
  await chooseFile(markdown);
  await page.getByRole('button', { name: '文件菜单', exact: true }).click();
  await page.getByRole('button', { name: /^打开导图/ }).click();
  let imported = await eventually(async () => { const current = await session(); return current.token !== beforeCancel.token ? current : false; }, 'Markdown 未导入');
  await page.locator('.app:not(.busy)').waitFor();
  assert.equal((await readDoc(originalFile)).nodes.root.text, '切换前最后输入的内容');
  assert.equal(path.extname(imported.path), '.mindmap');
  assert.equal(path.dirname(imported.path), maps);
  const pickerExtensions = await app.evaluate(() => globalThis.__importPickerOptions.filters.flatMap(filter => filter.extensions));
  for (const extension of ['mindmap', 'md', 'markdown', 'mmd', 'mermaid']) assert.ok(pickerExtensions.includes(extension));
  assert.deepEqual(await menuLabels(), originalMenu);
  assert.equal(imported.doc.relationships.length, 1);
  const noteId = Object.values(imported.doc.nodes).find(item => item.text === '笔记').id;
  await node(noteId).click(); await node(noteId).focus(); await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: '编辑节点', exact: true }).fill('导入后编辑的节点');
  await page.keyboard.press('Control+Enter');
  await saved((_, doc) => doc.nodes[noteId].text === '导入后编辑的节点');
  await page.locator('.canvas .relationship-label').dblclick();
  await page.getByRole('textbox', { name: '编辑联系文字', exact: true }).fill('导入后编辑的联系');
  await page.keyboard.press('Enter');
  imported = await saved((_, doc) => doc.relationships[0].text === '导入后编辑的联系');
  assert.equal(await fs.readFile(markdown, 'utf8'), markdownBytes);

  stage = 'invalid import keeps current map, selected node and native path';
  await node(noteId).click(); await node(noteId).focus();
  const beforeInvalid = await session();
  const beforeFiles = (await fs.readdir(maps)).sort();
  await chooseFile(invalid); await page.keyboard.press('Control+o');
  await page.locator('.app-error').waitFor();
  assert.equal((await session()).token, beforeInvalid.token);
  assert.equal((await session()).path, beforeInvalid.path);
  assert.equal(await selectedNode(), noteId);
  assert.deepEqual((await fs.readdir(maps)).sort(), beforeFiles);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  assert.equal(await page.locator('.save-error').count(), 0);

  stage = 'native imported edits reopen unchanged';
  await close(); await launch();
  const reopened = await session();
  assert.equal(reopened.path, imported.path);
  assert.equal(reopened.doc.nodes[noteId].text, '导入后编辑的节点');
  assert.equal(reopened.doc.relationships[0].text, '导入后编辑的联系');

  stage = 'raw Mermaid import and Markdown already in library';
  const raw = await open(mermaid);
  assert.equal(raw.doc.relationships[0].text, '启发');
  assert.equal(await fs.readFile(mermaid, 'utf8'), flowchart);
  const internalResult = await open(internal);
  assert.equal(path.extname(internalResult.path), '.mindmap');
  assert.ok(Object.values(internalResult.doc.nodes).some(item => item.text === '记录问题'));
  assert.equal(await fs.readFile(internal, 'utf8'), internalBytes);
  const library = await page.evaluate(() => window.inkmap.library());
  const flatten = entries => entries.flatMap(entry => [entry, ...flatten(entry.children ?? [])]);
  assert.ok(flatten(library.entries).every(entry => entry.path !== internal));
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(await menuLabels(), originalMenu);

  stage = 'startup and second-instance requests also accept imported formats';
  await close(); await launch(mermaid);
  const startup = await session();
  assert.notEqual(startup.path, internalResult.path);
  assert.equal(path.extname(startup.path), '.mindmap');
  assert.equal(startup.doc.relationships[0].text, '启发');
  await chooseFile(internal);
  await app.evaluate(({ app }, incoming) => app.emit('second-instance', {}, [app.getPath('exe'), incoming]), internal);
  const second = await eventually(async () => { const current = await session(); return current.token !== startup.token ? current : false; }, '第二次启动请求未导入 Markdown');
  await page.locator('.app:not(.busy)').waitFor();
  assert.ok(Object.values(second.doc.nodes).some(item => item.text === '记录问题'));
  assert.equal(await fs.readFile(markdown, 'utf8'), markdownBytes);
  assert.equal(await fs.readFile(mermaid, 'utf8'), flowchart);
  assert.equal(await fs.readFile(internal, 'utf8'), internalBytes);
  assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  assert.deepEqual(errors, []);
  await close();
  console.log(JSON.stringify({ success: true, home, checks: ['existing menu and keyboard open', 'picker formats and cancel', 'dirty source saved before switch', 'Markdown and raw Mermaid import', 'editable nodes and relationships', 'native autosave and restart', 'invalid input preserves current selection', 'in-library Markdown import', 'startup and second-instance requests', 'original source bytes unchanged', 'no clipboard access'] }, null, 2));
} catch (error) {
  console.error(`Import desktop test failed at: ${stage}`);
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await app.close().catch(() => {});
  }
}
