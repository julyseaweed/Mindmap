import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, descendants, validateDocument } from '../src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const home = await fs.mkdtemp(path.join(results, 'node-clipboard-'));
const maps = path.join(home, '导图');
const sourceFile = path.join(maps, '复制来源.mindmap');
const targetFile = path.join(maps, '粘贴目标.mindmap');
const workspaceFile = path.join(home, '.mindmap', 'workspace.json');
const branchType = 'electron application/osclipboard;format="Mindmap.Nodes"';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVFcAAAAASUVORK5CYII=';
const picture = id => ({ id, dataUrl: png, width: 64, height: 64, naturalWidth: 1, naturalHeight: 1 });
const original = createDocument('复制来源');
original.columnWidths = { 1: 300, 2: 220 };
original.nodes = {
  root: { id: 'root', text: '节点剪贴板测试', children: ['source', 'target'], collapsed: false },
  source: { id: 'source', text: '摘录主题\nSource branch', children: ['detail', 'picture'], collapsed: true, images: [picture('sourceImage')] },
  detail: { id: 'detail', text: '折叠后代', children: ['leaf'], collapsed: false },
  leaf: { id: 'leaf', text: '更深一层', children: [], collapsed: false },
  picture: { id: 'picture', text: '带图片的后代', children: [], collapsed: false, images: [picture('hiddenImage')] },
  target: { id: 'target', text: '当前导图中的目标', children: [], collapsed: false },
};
const other = createDocument('粘贴目标');
other.nodes.root.text = '另一张导图';
other.nodes.root.children = ['destination'];
other.nodes.destination = { id: 'destination', text: '粘贴到这里', children: [], collapsed: false };
await fs.mkdir(maps, { recursive: true });
await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
await fs.writeFile(sourceFile, JSON.stringify(validateDocument(original), null, 2));
await fs.writeFile(targetFile, JSON.stringify(validateDocument(other), null, 2));
await fs.writeFile(workspaceFile, JSON.stringify({ current: sourceFile, recent: [] }));

const env = { ...process.env, INKMAP_HOME: home, INKMAP_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.INKMAP_DEV;
let app;
let page;
let file = sourceFile;
let stage = 'launch';
let clipboardBackup = null;
const errors = [];
const node = id => page.locator(`.canvas .mind-node[data-node-id="${id}"]`);
const readDoc = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const eventually = async (check, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  } while (Date.now() < deadline);
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
};
const saved = async (check, allowError = false) => {
  const result = await eventually(async () => {
    if (await page.locator('.app[data-save-state="saved"]').count() !== 1) return false;
    const doc = await readDoc();
    return await check(doc) ? doc : false;
  }, '节点剪贴板修改未完成保存');
  if (!allowError) assert.equal(await page.locator('.app-error, .save-error').count(), 0);
  return result;
};

// Preserve every original representation only in the test process's private memory.
// This survives closing/relaunching the app without placing clipboard data in artifacts or logs.
const backupClipboard = async () => {
  clipboardBackup = await app.evaluate(async ({ clipboard }) => {
    const result = [];
    for (const item of await clipboard.read()) {
      const entries = [];
      for (const type of item.types) {
        const payload = await item.getType(type);
        entries.push(type === 'electron application/bookmark'
          ? { type, kind: 'bookmark', value: payload }
          : { type, kind: 'bytes', value: Buffer.from(await payload.arrayBuffer()).toString('base64') });
      }
      result.push(entries);
    }
    return result;
  });
};
const restoreWriteMethod = async () => {
  if (!app) return;
  await app.evaluate(({ clipboard }) => {
    if (globalThis.__nodeClipboardOriginalWrite) {
      clipboard.write = globalThis.__nodeClipboardOriginalWrite;
      delete globalThis.__nodeClipboardOriginalWrite;
    }
  });
};
// Refuse foreign clipboard data in this isolated process before a paste can save it.
// Native writes and the final private backup restoration remain unmodified.
const installClipboardReadGuard = async () => {
  await app.evaluate(({ clipboard }, fixture) => {
    if (globalThis.__nodeClipboardReadGuard) return;
    const read = clipboard.read;
    const readText = clipboard.readText;
    const rejectForeign = () => { throw new Error('Clipboard changed outside this test.'); };
    const isAllowedText = value => fixture.texts.includes(value.replace(/\r\n?/g, '\n').replace(/\0+$/, ''));
    const isAllowedBranch = doc => {
      try {
        if (!doc?.nodes || Object.keys(doc.nodes).length !== 4) return false;
        const visited = new Set();
        const tree = id => {
          if (visited.has(id) || visited.size >= 4) throw new Error('Invalid fixture');
          visited.add(id);
          const current = doc.nodes[id];
          return {
            text: current.text, collapsed: current.collapsed,
            ...(current.images ? { images: current.images.map(({ id: _, ...image }) => image) } : {}),
            children: current.children.map(tree),
          };
        };
        return JSON.stringify(tree(doc.rootId)) === fixture.tree && visited.size === 4;
      } catch { return false; }
    };
    globalThis.__nodeClipboardReadGuard = { read, readText };
    clipboard.read = async function (...args) {
      const items = await read.apply(this, args);
      let recognized = false;
      for (const item of items) {
        if (item.types.some(type => type.startsWith('image/'))) rejectForeign();
        if (item.types.includes(fixture.branchType)) {
          const blob = await item.getType(fixture.branchType);
          if (blob.size > 128 * 1024) rejectForeign();
          let branch;
          try { branch = JSON.parse((await blob.text()).replace(/\0+$/, '')); }
          catch { rejectForeign(); }
          if (!isAllowedBranch(branch)) rejectForeign();
          recognized = true;
        }
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          if (blob.size > 4096 || !isAllowedText(await blob.text())) rejectForeign();
          recognized = true;
        }
      }
      if (!recognized) rejectForeign();
      return items;
    };
    clipboard.readText = async function (...args) {
      const value = await readText.apply(this, args);
      if (!isAllowedText(value)) rejectForeign();
      return value;
    };
  }, {
    branchType,
    tree: JSON.stringify(contentTree(original, 'source')),
    texts: ['摘录主题\nSource branch\n\t折叠后代\n\t\t更深一层\n\t带图片的后代', 'node-clipboard: keep this sentinel', '第一段\nSecond line\n第三段'],
  });
};
const restoreClipboard = async () => {
  if (clipboardBackup === null) return;
  try { if (app) await app.evaluate(() => true); }
  catch { app = null; page = null; }
  // A crashed renderer or a completed restart must not prevent restoring the user's clipboard.
  if (!app) app = await electron.launch({ args: [root], env, timeout: 30000 });
  await restoreWriteMethod();
  await app.evaluate(async ({ clipboard, ClipboardItem }, snapshot) => {
    if (globalThis.__nodeClipboardReadGuard) {
      Object.assign(clipboard, globalThis.__nodeClipboardReadGuard);
      delete globalThis.__nodeClipboardReadGuard;
    }
    const items = snapshot.map(entries => new ClipboardItem(Object.fromEntries(entries.map(entry => [
      entry.type,
      entry.kind === 'bookmark' ? entry.value : new Blob([Buffer.from(entry.value, 'base64')]),
    ]))));
    if (items.length) await clipboard.write(items);
    else clipboard.clear();
  }, clipboardBackup);
  clipboardBackup = null;
};
const launch = async () => {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('renderer crashed'));
  const visible = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1260, 820);
    return window.isVisible();
  });
  assert.equal(visible, false, '测试窗口必须隐藏且使用隔离目录');
  if (clipboardBackup !== null) await installClipboardReadGuard();
  await node('root').waitFor({ timeout: 15000 });
  await saved(() => true);
};
const close = async () => {
  if (!app) return;
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('应用关闭未完成。')), 12000); })]); }
  finally { clearTimeout(timer); }
  await app.close().catch(() => {});
  app = null;
  page = null;
};
const selectNode = async id => {
  await page.getByRole('button', { name: '适应画布 (Ctrl + 0)', exact: true }).click();
  const element = node(id);
  const box = await element.boundingBox();
  assert.ok(box, '待选节点应在画布中可见');
  await element.click({ position: { x: Math.min(8, box.width / 4), y: Math.min(8, box.height / 4) } });
  await eventually(async () => await element.getAttribute('aria-selected') === 'true', '节点未选中');
};
const contextMenu = async id => {
  await selectNode(id);
  await node(id).click({ button: 'right', position: { x: 6, y: 6 } });
  const menu = page.locator('.context-menu');
  await menu.waitFor();
  return menu;
};
const clipboardBranch = () => app.evaluate(async ({ clipboard }, type) => {
  for (const item of await clipboard.read()) {
    if (item.types.includes(type)) return JSON.parse((await (await item.getType(type)).text()).replace(/\0+$/, ''));
  }
  return null;
}, branchType);
const copied = id => eventually(async () => {
  const branch = await clipboardBranch();
  return branch?.rootId === id ? branch : false;
}, '系统剪贴板未保存完整节点结构');
const writeText = text => app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
const contentTree = (doc, id) => {
  const current = doc.nodes[id];
  return {
    text: current.text, collapsed: current.collapsed,
    ...(current.images ? { images: current.images.map(({ id: _, ...image }) => image) } : {}),
    children: current.children.map(child => contentTree(doc, child)),
  };
};
const allIds = doc => Object.values(doc.nodes).flatMap(current => [current.id, ...(current.images ?? []).map(image => image.id)]);
const assertInserted = (before, after, parentId, source, sourceRoot) => {
  const previous = before.nodes[parentId].children;
  const next = after.nodes[parentId].children;
  assert.equal(next.length, previous.length + 1);
  assert.deepEqual(next.slice(0, previous.length), previous);
  const inserted = next.at(-1);
  const insertedIds = descendants(after, inserted);
  const sourceIds = descendants(source, sourceRoot);
  assert.equal(insertedIds.length, sourceIds.length);
  assert.equal(Object.keys(after.nodes).length, Object.keys(before.nodes).length + sourceIds.length);
  assert.deepEqual(contentTree(after, inserted), contentTree(source, sourceRoot));
  const existing = new Set([...allIds(before), ...allIds(source)]);
  const generated = insertedIds.flatMap(id => [id, ...(after.nodes[id].images ?? []).map(image => image.id)]);
  assert.equal(new Set(generated).size, generated.length, '每个新节点和图片的ID应唯一');
  assert.ok(generated.every(id => !existing.has(id)), '粘贴应为全部节点和图片建立新ID');
  return inserted;
};
const openDocument = async target => {
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, target);
  await page.keyboard.press('Control+o');
  await eventually(async () => JSON.parse(await fs.readFile(workspaceFile, 'utf8')).current === target, '目标导图未打开');
  file = target;
  await saved(doc => doc.id === (target === sourceFile ? original.id : other.id));
};
const clipboardFingerprint = () => app.evaluate(async ({ clipboard }) => {
  const { createHash } = process.getBuiltinModule('crypto');
  const hashes = [];
  for (const item of await clipboard.read()) for (const type of item.types) {
    const payload = await item.getType(type);
    const bytes = type === 'electron application/bookmark' ? Buffer.from(JSON.stringify(payload)) : Buffer.from(await payload.arrayBuffer());
    hashes.push([type, createHash('sha256').update(bytes).digest('hex')]);
  }
  hashes.sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
});

try {
  await launch();
  await backupClipboard();
  await installClipboardReadGuard();

  stage = 'keyboard copy includes images and collapsed descendants';
  assert.equal(await node('detail').count(), 0);
  assert.equal(await node('picture').count(), 0);
  const originalBytes = await fs.readFile(sourceFile, 'utf8');
  await selectNode('source');
  await page.keyboard.press('Control+c');
  const branch = await copied('source');
  assert.equal(await app.evaluate(({ clipboard }, type) => clipboard.has(type), branchType), true);
  assert.deepEqual(contentTree(branch, branch.rootId), contentTree(original, 'source'));
  assert.deepEqual(Object.keys(branch.nodes).sort(), ['source', 'detail', 'leaf', 'picture'].sort());
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '摘录主题\nSource branch\n\t折叠后代\n\t\t更深一层\n\t带图片的后代');
  assert.equal(await fs.readFile(sourceFile, 'utf8'), originalBytes, '复制不应修改原文件');

  stage = 'keyboard paste creates a new complete child subtree';
  let before = await readDoc();
  await selectNode('target');
  await page.keyboard.press('Control+v');
  let after = await saved(doc => doc.nodes.target.children.length === 1);
  const firstPaste = assertInserted(before, after, 'target', branch, branch.rootId);
  assert.equal(after.nodes[firstPaste].collapsed, true);

  stage = 'successful cut removes the complete subtree and undo restores it';
  const beforeCut = await readDoc();
  await selectNode('source');
  await page.keyboard.press('Control+x');
  await saved(doc => !doc.nodes.source && !doc.nodes.detail && !doc.nodes.leaf && !doc.nodes.picture);
  await copied('source');
  await page.keyboard.press('Control+z');
  after = await saved(doc => !!doc.nodes.source);
  assert.deepEqual(after, beforeCut);

  stage = 'clipboard write failure retains both subtree and previous clipboard';
  await app.evaluate(async ({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({
    'text/plain': 'node-clipboard: keep this sentinel',
    'electron application/osclipboard;format="Mindmap.TestSentinel"': new Blob(['private test marker']),
  })]));
  const previousFingerprint = await clipboardFingerprint();
  before = await readDoc();
  await app.evaluate(({ clipboard }) => {
    globalThis.__nodeClipboardOriginalWrite = clipboard.write;
    clipboard.write = async () => { throw new Error('node-clipboard-injected-write-failure'); };
  });
  try {
    await selectNode('source');
    await page.keyboard.press('Control+x');
    await eventually(async () => (await page.locator('.app-error').textContent())?.includes('node-clipboard-injected-write-failure'), '剪切失败未显示错误');
    assert.deepEqual(await readDoc(), before, '写入失败不得删除原子树');
    assert.equal(await clipboardFingerprint(), previousFingerprint, '写入失败不得清空原剪贴板');
  } finally { await restoreWriteMethod(); }
  await page.locator('.app-error').getByRole('button', { name: '关闭提示', exact: true }).click();

  stage = 'copy and paste across documents';
  await selectNode('source');
  await page.keyboard.press('Control+c');
  await copied('source');
  await openDocument(targetFile);
  before = await readDoc();
  await selectNode('destination');
  await page.keyboard.press('Control+v');
  after = await saved(doc => doc.nodes.destination.children.length === 1);
  const crossDocumentPaste = assertInserted(before, after, 'destination', branch, branch.rootId);

  stage = 'system structure survives complete application restart';
  await close();
  await launch();
  const afterRestartClipboard = await copied('source');
  assert.deepEqual(contentTree(afterRestartClipboard, 'source'), contentTree(branch, 'source'));
  before = await readDoc();
  await selectNode('root');
  await page.keyboard.press('Control+v');
  after = await saved(doc => doc.nodes.root.children.length === before.nodes.root.children.length + 1);
  assertInserted(before, after, 'root', branch, branch.rootId);

  stage = 'node context menu copy, paste, cut, and undo';
  let menu = await contextMenu(crossDocumentPaste);
  await menu.getByRole('button', { name: /^复制节点/ }).click();
  const menuBranch = await copied(crossDocumentPaste);
  before = await readDoc();
  menu = await contextMenu('destination');
  await menu.getByRole('button', { name: /^粘贴(?:\s|$)/ }).click();
  after = await saved(doc => doc.nodes.destination.children.length === before.nodes.destination.children.length + 1);
  const menuPaste = assertInserted(before, after, 'destination', menuBranch, menuBranch.rootId);
  before = await readDoc();
  menu = await contextMenu(menuPaste);
  await menu.getByRole('button', { name: /^剪切节点/ }).click();
  await saved(doc => !doc.nodes[menuPaste]);
  await copied(menuPaste);
  await page.keyboard.press('Control+z');
  after = await saved(doc => !!doc.nodes[menuPaste]);
  assert.deepEqual(after, before);

  stage = 'plain multiline text becomes one child of the selected node';
  const plainText = '第一段\r\nSecond line\n第三段';
  await writeText(plainText);
  before = await readDoc();
  await selectNode('destination');
  await page.keyboard.press('Control+v');
  after = await saved(doc => doc.nodes.destination.children.length === before.nodes.destination.children.length + 1);
  assert.equal(Object.keys(after.nodes).length, Object.keys(before.nodes).length + 1);
  const pastedText = after.nodes[after.nodes.destination.children.at(-1)];
  assert.equal(pastedText.text, '第一段\nSecond line\n第三段');
  assert.deepEqual(pastedText.children, []);
  assert.equal(pastedText.images, undefined);
  assert.equal(after.nodes.destination.text, before.nodes.destination.text);
  assert.equal(await page.getByRole('textbox', { name: '编辑节点', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(results, 'node-clipboard.png') });

  stage = 'restore original clipboard';
  await restoreClipboard();
  await close();
  console.log(JSON.stringify({ success: true, home, checks: ['native structure and plain text', 'collapsed descendants and images', 'fresh node and image IDs', 'cut only after successful write', 'undo', 'cross-document paste', 'clipboard survives app restart', 'node context menu operations', 'multiline text as one child', 'all original clipboard formats restored'] }, null, 2));
} catch (error) {
  console.error(`Node clipboard test failed at: ${stage}`);
  // Assertion errors may include actual values: never print clipboard payloads.
  throw new Error(`Node clipboard test failed (${error?.name ?? 'Error'}, ${error?.code ?? 'no code'}).`);
} finally {
  if (page && !page.isClosed()) await page.mouse.up().catch(() => {});
  try { await restoreClipboard(); }
  catch { console.error('Unable to restore the original clipboard.'); process.exitCode = 1; }
  if (app) await app.close().catch(() => {});
}
