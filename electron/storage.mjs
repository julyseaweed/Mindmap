import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDocument, validateDocument } from '../src/core.mjs';

export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export const safeFilename = title => title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 70) || '未命名导图';
const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const samePath = (first, second) => path.relative(first, second) === '';
const naturalOrder = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
const orderKey = (root, file) => path.relative(root, file).split(path.sep).join('/');
const comparableKey = key => process.platform === 'win32' ? key.toLowerCase() : key;
const sameKey = (a, b) => comparableKey(a) === comparableKey(b);
const insideKey = (root, key) => sameKey(root, key) || comparableKey(key).startsWith(comparableKey(root) + '/');
const displayName = entry => entry.kind === 'folder' ? entry.name : entry.title || entry.name.replace(/\.mindmap$/i, '');
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const recoveryHash = content => createHash('sha256').update(content).digest('hex');
const entryName = value => {
  if (typeof value !== 'string') throw new Error('请输入有效名称。');
  const name = value.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || ['.', '..', '.mindmap'].includes(name.toLowerCase()) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('名称包含不能用于本地文件的字符。');
  return name;
};

export class LocalStore {
  constructor(home) {
    this.home = path.resolve(home);
    this.maps = path.join(this.home, '导图');
    this.statePath = path.join(home, '.mindmap', 'workspace.json');
    this.recoveryPath = path.join(home, '.mindmap', 'recovery.json');
    this.orderPath = path.join(home, '.mindmap', 'library-order.json');
    this.order = Object.create(null);
    this.orderLoaded = null;
    this.state = { recent: [], current: null };
    this.current = null;
    this.saveMetadataPending = false;
    this.queue = Promise.resolve();
  }

  async boot() {
    await fs.mkdir(this.maps, { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8')); } catch {}
    if (!this.state || !Array.isArray(this.state.recent)) this.state = { recent: [], current: null };
    this.state.recent = this.state.recent.filter(item => item && typeof item.path === 'string' && path.isAbsolute(item.path));
    // A failed or interrupted disk write is restored as a separate file, keeping the original intact.
    try {
      const recoveryContent = await fs.readFile(this.recoveryPath, 'utf8');
      if (this.state.discardedRecoveryHash === recoveryHash(recoveryContent)) {
        await this.clearRecovery().catch(() => {});
        throw new Error('Recovery belongs to an explicitly deleted document.');
      }
      const recovery = JSON.parse(recoveryContent);
      const doc = validateDocument(recovery.doc);
      let saved = null;
      try { saved = validateDocument(JSON.parse(await fs.readFile(recovery.path, 'utf8'))); }
      catch { /* A missing or damaged original must not discard valid pending edits. */ }
      if (JSON.stringify(doc) !== JSON.stringify(saved)) {
        doc.id = 'n' + randomUUID().replaceAll('-', '');
        const suffix = '（恢复）';
        doc.title = doc.title.slice(0, 200 - suffix.length) + suffix;
        const result = await this.create(doc);
        await this.finishSaveMetadata();
        return { ...result, notice: ['上次未完成保存的内容已恢复为单独的导图。', result.notice].filter(Boolean).join('\n') };
      }
      // The document write may have completed before its workspace record was written.
      const result = await this.open(recovery.path);
      await this.finishSaveMetadata();
      return result;
    } catch {}
    if (this.state.emptyCanvas === true) return this.openEmpty();
    if (this.state.current) {
      try { return await this.open(this.state.current); }
      catch {
        const result = await this.openEmpty();
        return { ...result, notice: result.notice ?? '上次的文件已移动或无法读取。你可以从文件菜单重新打开。' };
      }
    }
    return this.state.draftOnly ? this.openDraft() : this.create();
  }

  async remember() {
    const current = this.current;
    this.state.current = current?.path || null;
    this.state.draftOnly = !!current && !current.path;
    this.state.emptyCanvas = !current;
    if (current?.path) this.state.recent = [{ path: current.path, title: current.doc.title, updatedAt: new Date().toISOString() }, ...this.state.recent.filter(item => item.path !== current.path)].slice(0, 12);
    await atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async rememberSession() {
    try { await this.remember(); }
    catch {
      // Reading/creating the document already succeeded; never strand the renderer on its old token.
      return { ...this.snapshot(), notice: this.current ? '位置记录未能保存，当前导图仍可使用。请重新打开导图或继续编辑后保存。' : '位置记录未能保存，当前画布已清空。' };
    }
    return this.snapshot();
  }

  async clearRecovery() {
    await fs.rm(this.recoveryPath, { force: true });
  }

  async finishSaveMetadata() {
    this.saveMetadataPending = true;
    try {
      await this.remember();
      await this.clearRecovery();
      this.saveMetadataPending = false;
    } catch { /* Content is already on disk; retain the journal and retry metadata on the next save. */ }
  }

  async openDraft() {
    const doc = createDocument();
    this.current = { doc, path: '', token: randomUUID(), diskContent: JSON.stringify(doc, null, 2) };
    this.saveMetadataPending = false;
    return this.rememberSession();
  }

  async openEmpty() {
    this.current = null;
    this.saveMetadataPending = false;
    return this.rememberSession();
  }

  snapshot() {
    return structuredClone({ doc: this.current?.doc ?? null, path: this.current?.path ?? '', token: this.current?.token ?? '', recent: this.state.recent });
  }

  enqueue(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  containsLibraryPath(file) {
    return typeof file === 'string' && path.isAbsolute(file) && within(this.maps, path.resolve(file));
  }

  async libraryPath(file, kind = 'item') {
    if (!this.containsLibraryPath(file)) throw new Error('请选择导图库内的文件或文件夹。');
    const absolute = path.resolve(file);
    const relative = path.relative(this.maps, absolute);
    const parts = relative ? relative.split(path.sep) : [];
    if (parts.some(part => part.toLowerCase() === '.mindmap')) throw new Error('不能操作应用数据目录。');
    const rootStat = await fs.lstat(this.maps);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('导图库不能使用符号链接或目录联接。');
    const rootReal = await fs.realpath(this.maps);
    let cursor = this.maps, stat = rootStat;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('导图库不能使用符号链接或目录联接。');
      if (!within(rootReal, await fs.realpath(cursor))) throw new Error('文件位置超出了导图库。');
    }
    const isMap = stat.isFile() && path.extname(absolute).toLowerCase() === '.mindmap';
    if (kind === 'folder' ? !stat.isDirectory() : kind === 'map' ? !isMap : !stat.isDirectory() && !isMap) throw new Error('请选择有效的导图文件或文件夹。');
    return { path: absolute, kind: stat.isDirectory() ? 'folder' : 'map' };
  }

  async loadOrder() {
    if (!this.orderLoaded) this.orderLoaded = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(this.orderPath, 'utf8'));
        if (saved.version !== 1 || !saved.folders || typeof saved.folders !== 'object') return;
        for (const [folder, entries] of Object.entries(saved.folders)) {
          if (!Array.isArray(entries) || folder.split('/').some(part => ['.', '..'].includes(part)) || folder.includes('\\') || path.isAbsolute(folder)) continue;
          this.order[folder] = entries.filter(entry => entry && typeof entry.name === 'string' && typeof entry.identity === 'string');
        }
      } catch { /* Missing or malformed ordering falls back to the default library order. */ }
    })();
    await this.orderLoaded;
  }

  async saveOrder(next) {
    await atomicWrite(this.orderPath, JSON.stringify({ version: 1, folders: next }, null, 2));
    this.order = next;
  }

  orderFor(folder) {
    const key = orderKey(this.maps, folder);
    const existing = Object.keys(this.order).find(saved => sameKey(saved, key));
    return existing === undefined ? [] : this.order[existing];
  }

  async maintainOrder(next, notice) {
    if (JSON.stringify(next) === JSON.stringify(this.order)) return;
    try { await this.saveOrder(next); }
    catch {
      // The file operation already completed; keep its new session usable even if metadata cannot be written.
      this.order = next;
      return notice;
    }
  }

  remapOrder(source, destination, identity) {
    const sourceKey = orderKey(this.maps, source.path), destinationKey = orderKey(this.maps, destination);
    const next = Object.create(null);
    for (const [folder, entries] of Object.entries(this.order)) {
      if (source.kind === 'folder' && !sameKey(sourceKey, destinationKey) && insideKey(destinationKey, folder) && !insideKey(sourceKey, folder)) continue;
      const key = source.kind === 'folder' && insideKey(sourceKey, folder) ? destinationKey + folder.slice(sourceKey.length) : folder;
      next[key] = entries;
    }
    const sourceParent = orderKey(this.maps, path.dirname(source.path));
    const destinationParent = orderKey(this.maps, path.dirname(destination));
    const oldName = path.basename(source.path), newName = path.basename(destination);
    const sourceParentKey = Object.keys(next).find(key => sameKey(key, sourceParent));
    if (sameKey(sourceParent, destinationParent)) {
      if (sourceParentKey !== undefined) next[sourceParentKey] = next[sourceParentKey]
        .filter(entry => sameKey(entry.name, oldName) ? entry.identity === identity : !sameKey(entry.name, newName))
        .map(entry => sameKey(entry.name, oldName) ? { name: newName, identity } : entry);
    } else {
      if (sourceParentKey !== undefined) next[sourceParentKey] = next[sourceParentKey].filter(entry => !sameKey(entry.name, oldName));
      const destinationParentKey = Object.keys(next).find(key => sameKey(key, destinationParent));
      if (destinationParentKey !== undefined) next[destinationParentKey] = [...next[destinationParentKey].filter(entry => !sameKey(entry.name, newName)), { name: newName, identity }];
    }
    return next;
  }

  removeFromOrder(source) {
    const sourceKey = orderKey(this.maps, source.path), parentKey = orderKey(this.maps, path.dirname(source.path));
    const next = Object.create(null);
    for (const [folder, entries] of Object.entries(this.order)) {
      if (source.kind === 'folder' && insideKey(sourceKey, folder)) continue;
      next[folder] = sameKey(folder, parentKey) ? entries.filter(entry => !sameKey(entry.name, path.basename(source.path))) : entries;
    }
    return next;
  }

  async entryIdentity(item) {
    const stat = await fs.stat(item.path);
    if (item.kind === 'map' && stat.size <= MAX_DOCUMENT_BYTES) {
      try { return 'map:' + validateDocument(JSON.parse(await fs.readFile(item.path, 'utf8'))).id; } catch {}
    }
    return `${item.kind}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }

  async readLibrary(identities = new Map()) {
    await this.loadOrder();
    await this.libraryPath(this.maps, 'folder');
    const readDirectory = async folder => {
      const result = [];
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.toLowerCase() === '.mindmap' || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.mindmap')) continue;
        let item, stat;
        try {
          item = await this.libraryPath(path.join(folder, entry.name));
          stat = await fs.stat(item.path);
          identities.set(item.path, `${item.kind}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
        } catch { continue; }
        if (item.kind === 'folder') {
          try { result.push({ ...item, name: entry.name, children: await readDirectory(item.path) }); } catch { /* A folder removed externally will appear on the next refresh. */ }
        } else {
          const map = { ...item, name: entry.name };
          try {
            if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('文件过大');
            const doc = validateDocument(JSON.parse(await fs.readFile(item.path, 'utf8')));
            map.title = doc.title;
            identities.set(item.path, 'map:' + doc.id);
          } catch { map.invalid = true; }
          result.push(map);
        }
      }
      const ordered = this.orderFor(folder);
      const rank = entry => {
        const index = ordered.findIndex(saved => sameKey(saved.name, entry.name) && saved.identity === identities.get(entry.path));
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      return result.sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || naturalOrder.compare(displayName(a), displayName(b)) || naturalOrder.compare(a.name, b.name) || a.name.localeCompare(b.name));
    };
    return { root: this.maps, entries: await readDirectory(this.maps) };
  }

  async library() {
    await this.queue;
    return this.readLibrary();
  }

  createFolder(name, parentPath = this.maps) {
    return this.enqueue(async () => {
      const parent = await this.libraryPath(parentPath, 'folder');
      const folder = path.join(parent.path, entryName(name));
      try { await fs.mkdir(folder); } catch (error) { if (error.code === 'EEXIST') throw new Error('这里已有同名文件或文件夹。'); throw error; }
      return this.readLibrary();
    });
  }

  async uniquePath(title, folder = this.maps, excludedPath = '') {
    const base = safeFilename(title);
    for (let i = 0; ; i++) {
      const filename = path.join(folder, `${base}${i ? ' ' + (i + 1) : ''}.mindmap`);
      if (excludedPath && samePath(filename, excludedPath)) continue;
      try { await fs.access(filename); } catch (error) { if (error.code === 'ENOENT') return filename; throw error; }
    }
  }

  async writeNewLibraryFile(doc, { excludedPath = '', recovery = false } = {}) {
    await fs.mkdir(this.maps, { recursive: true });
    await this.libraryPath(this.maps, 'folder');
    const content = JSON.stringify(doc, null, 2);
    for (;;) {
      const file = await this.uniquePath(doc.title, this.maps, excludedPath);
      if (recovery) await atomicWrite(this.recoveryPath, JSON.stringify({ path: file, doc }));
      try {
        await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
        return { path: file, content };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }

  create(doc = createDocument(), folderPath = this.maps) {
    return this.enqueue(async () => {
      const folder = await this.libraryPath(folderPath, 'folder');
      const validated = validateDocument(doc);
      const file = await this.uniquePath(validated.title, folder.path);
      await fs.writeFile(file, JSON.stringify(validated, null, 2), { encoding: 'utf8', flag: 'wx' });
      return this.openCurrent(file);
    });
  }

  open(file) {
    return this.enqueue(() => this.openCurrent(file));
  }

  async openCurrent(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('文件路径无效。');
    if (this.containsLibraryPath(file)) await this.libraryPath(file, 'map');
    if (path.extname(file).toLowerCase() !== '.mindmap') throw new Error('请选择 .mindmap 格式的导图文件。');
    const stat = await fs.stat(file);
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('文件过大，暂时无法打开。');
    let raw = await fs.readFile(file, 'utf8');
    const doc = validateDocument(JSON.parse(raw));
    if (!this.containsLibraryPath(file)) {
      doc.id = 'n' + randomUUID().replaceAll('-', '');
      const imported = await this.writeNewLibraryFile(doc);
      file = imported.path;
      raw = imported.content;
    }
    this.current = { doc, path: path.resolve(file), token: randomUUID(), diskContent: raw };
    this.saveMetadataPending = false;
    return this.rememberSession();
  }

  save(doc, token) {
    const validated = validateDocument(doc);
    return this.enqueue(async () => {
      if (!this.current || this.current.token !== token || this.current.doc.id !== validated.id) throw new Error('文件已切换，请重新打开后再保存。');
      const current = this.current;
      const content = JSON.stringify(validated, null, 2);
      const persistNewFile = async () => {
        const saved = await this.writeNewLibraryFile(validated, { excludedPath: current.path, recovery: true });
        current.path = saved.path;
        current.diskContent = content;
        current.doc = validated;
        await this.finishSaveMetadata();
        return { path: saved.path };
      };
      if (!current.path) {
        if (content === current.diskContent) return { path: '' };
        return persistNewFile();
      }
      if (content !== current.diskContent) await atomicWrite(this.recoveryPath, JSON.stringify({ path: current.path, doc: validated }));
      let existing;
      try {
        if (this.containsLibraryPath(current.path)) await this.libraryPath(current.path, 'map');
        existing = await fs.readFile(current.path, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return persistNewFile();
      }
      if (existing !== current.diskContent) throw new Error('文件在其他地方被修改了。请用「另存为」保留当前内容。');
      if (content === current.diskContent) {
        if (this.saveMetadataPending) await this.finishSaveMetadata();
        return { path: current.path };
      }
      await atomicWrite(path.join(this.home, '.mindmap', 'backups', `${validated.id}.mindmap`), existing);
      await atomicWrite(current.path, content);
      current.diskContent = content;
      current.doc = validated;
      await this.finishSaveMetadata();
      return { path: current.path };
    });
  }

  saveAs(doc, token, file) {
    return this.enqueue(async () => {
      if (this.current?.token !== token) throw new Error('文件已切换，请重试。');
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mindmap') throw new Error('文件路径无效。');
      if (this.current.path && samePath(this.current.path, file)) throw new Error('副本需要使用不同的文件名或位置。当前导图会继续自动保存。');
      if (this.containsLibraryPath(file)) {
        await this.libraryPath(path.dirname(file), 'folder');
        try { await this.libraryPath(file, 'map'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const validated = validateDocument(doc);
      if (validated.id !== this.current.doc.id) throw new Error('文件已切换，请重试。');
      validated.id = 'n' + randomUUID().replaceAll('-', '');
      await atomicWrite(file, JSON.stringify(validated, null, 2));
      return { path: path.resolve(file) };
    });
  }

  moveLibraryItem(sourcePath, targetFolderPath) {
    return this.enqueue(async () => {
      const source = await this.libraryPath(sourcePath);
      const target = await this.libraryPath(targetFolderPath, 'folder');
      if (samePath(source.path, this.maps)) throw new Error('不能移动导图库根目录。');
      if (source.kind === 'folder' && within(source.path, target.path)) throw new Error('不能把文件夹移入自身或它的子文件夹。');
      return this.relocate(source, path.join(target.path, path.basename(source.path)));
    });
  }

  renameLibraryItem(sourcePath, name) {
    return this.enqueue(async () => {
      const source = await this.libraryPath(sourcePath);
      if (samePath(source.path, this.maps)) throw new Error('不能重命名导图库根目录。');
      const filename = source.kind === 'map' ? entryName(typeof name === 'string' ? name.replace(/\.mindmap$/i, '') : name) + '.mindmap' : entryName(name);
      return this.relocate(source, path.join(path.dirname(source.path), filename), source.kind === 'map' ? filename.slice(0, -'.mindmap'.length) : undefined);
    });
  }

  arrangeLibraryItem(sourcePath, targetPath, position) {
    return this.enqueue(async () => {
      if (!['before', 'after', 'inside'].includes(position)) throw new Error('请选择有效的放置位置。');
      const source = await this.libraryPath(sourcePath);
      if (samePath(source.path, this.maps)) throw new Error('不能拖动导图库根目录。');
      const target = await this.libraryPath(targetPath, position === 'inside' ? 'folder' : 'item');
      if (position !== 'inside' && samePath(target.path, this.maps)) throw new Error('不能放到导图库根目录外。');
      if (position !== 'inside' && samePath(source.path, target.path)) return { library: await this.readLibrary() };
      const folder = position === 'inside' ? target : await this.libraryPath(path.dirname(target.path), 'folder');
      if (source.kind === 'folder' && within(source.path, folder.path)) throw new Error('不能把文件夹移入自身或它的子文件夹。');
      const destination = path.join(folder.path, path.basename(source.path));
      const moved = !samePath(source.path, destination) ? await this.relocate(source, destination) : null;
      let orderSaved = false;
      try {
        const identities = new Map();
        const library = await this.readLibrary(identities);
        const findEntries = (entries, directory) => {
          for (const entry of entries) {
            if (entry.kind !== 'folder') continue;
            if (samePath(entry.path, directory)) return entry.children ?? [];
            const found = findEntries(entry.children ?? [], directory);
            if (found) return found;
          }
        };
        const entries = samePath(folder.path, this.maps) ? library.entries : findEntries(library.entries, folder.path);
        const dragged = entries?.find(entry => samePath(entry.path, destination));
        if (!dragged) throw new Error('文件位置已改变，请刷新导图库后重试。');
        const ordered = entries.filter(entry => !samePath(entry.path, destination));
        let index = ordered.length;
        if (position !== 'inside') {
          index = ordered.findIndex(entry => samePath(entry.path, target.path));
          if (index === -1) throw new Error('目标位置已改变，请刷新导图库后重试。');
          if (position === 'after') index++;
        }
        ordered.splice(index, 0, dragged);
        const next = Object.assign(Object.create(null), this.order);
        const key = orderKey(this.maps, folder.path);
        for (const existing of Object.keys(next)) if (sameKey(existing, key) && existing !== key) delete next[existing];
        next[key] = ordered.map(entry => ({ name: entry.name, identity: identities.get(entry.path) }));
        await this.saveOrder(next);
        orderSaved = true;
        return { library: await this.readLibrary(), ...(moved?.session ? { session: moved.session } : {}), ...(moved?.notice ? { notice: moved.notice } : {}) };
      } catch (error) {
        if (!moved) throw error;
        let library = moved.library;
        try { library = await this.readLibrary(); } catch {}
        return { library, ...(moved.session ? { session: moved.session } : {}), notice: orderSaved ? '文件已移动，但列表未能刷新，请刷新导图库重试。' : '文件已移动，但排序未能保存，请重试。' };
      }
    });
  }

  deleteLibraryItem(sourcePath, trash) {
    return this.enqueue(async () => {
      const source = await this.libraryPath(sourcePath);
      if (samePath(source.path, this.maps)) throw new Error('不能删除导图库根目录。');
      if (typeof trash !== 'function') throw new Error('无法移入回收站。');
      const affected = file => typeof file === 'string' && !!file && (source.kind === 'folder' ? within(source.path, file) : samePath(source.path, file));
      const activeRemoved = affected(this.current?.path);
      await this.loadOrder();

      // Keep the session intact until Windows confirms that the item reached the recycle bin.
      await trash(source.path);
      let notice = await this.maintainOrder(this.removeFromOrder(source), '已移入回收站，但列表顺序未能保存。');
      const positionNotice = '已移入回收站，但位置记录未能保存，请重新打开导图或继续编辑后保存。';
      this.state.recent = this.state.recent.filter(item => !affected(item.path));
      if (affected(this.state.current)) this.state.current = null;
      try {
        let recoveryContent, recovery;
        try {
          recoveryContent = await fs.readFile(this.recoveryPath, 'utf8');
          recovery = JSON.parse(recoveryContent);
        } catch {}
        if (recovery && affected(recovery.path)) {
          // Persist the exact discarded journal so failed cleanup cannot revive a deleted map.
          // A subsequent, different recovery snapshot must still be recoverable.
          this.state.discardedRecoveryHash = recoveryHash(recoveryContent);
          await this.clearRecovery();
        }
      } catch { notice = positionNotice; }
      // Establish a valid in-memory session before metadata IO, even if recording it fails.
      try {
        if (activeRemoved || this.current) {
          const session = activeRemoved ? await this.openEmpty() : await this.rememberSession();
          if (session.notice) notice = `已移入回收站。${session.notice}`;
        }
        else await atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
      } catch { notice = positionNotice; }
      const library = await this.readLibrary();
      return { library, ...(activeRemoved ? { session: this.snapshot() } : {}), ...(notice ? { notice } : {}) };
    });
  }

  async relocate(source, destination, title) {
    const sameLocation = samePath(source.path, destination);
    if (source.path === destination && title === undefined) return { library: await this.readLibrary() };
    if (!sameLocation) {
      try { await fs.lstat(destination); throw new Error('这里已有同名文件或文件夹。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await this.loadOrder();
    const identity = await this.entryIdentity(source);
    let renamedDoc, renamedContent;
    if (title !== undefined) {
      const stat = await fs.stat(source.path);
      if (stat.size <= MAX_DOCUMENT_BYTES) {
        const raw = await fs.readFile(source.path, 'utf8');
        if (this.current && samePath(this.current.path, source.path) && raw !== this.current.diskContent) throw new Error('文件在其他地方被修改了。请重新打开后再重命名。');
        try { renamedDoc = validateDocument(JSON.parse(raw)); } catch { /* Invalid files retain their original bytes when renamed. */ }
        if (renamedDoc) {
          renamedDoc.title = title;
          renamedContent = JSON.stringify(renamedDoc, null, 2);
          await atomicWrite(path.join(this.home, '.mindmap', 'backups', `${renamedDoc.id}.mindmap`), raw);
        }
      }
    }
    // Hard-link creation refuses an existing destination atomically, so moving a map never overwrites it.
    if (sameLocation) {
      if (source.path !== destination) await fs.rename(source.path, destination);
    } else if (source.kind === 'map') {
      try { await fs.link(source.path, destination); } catch (error) { if (error.code === 'EEXIST') throw new Error('这里已有同名文件或文件夹。'); throw error; }
      try { await fs.unlink(source.path); } catch (error) { await fs.unlink(destination).catch(() => {}); throw error; }
    } else await fs.rename(source.path, destination);
    if (renamedDoc) {
      try { await atomicWrite(destination, renamedContent); }
      catch (error) {
        // If updating the title fails, put the untouched map back before reporting the error.
        if (!sameLocation) { await fs.link(destination, source.path); await fs.unlink(destination); }
        throw error;
      }
    }
    const remap = file => typeof file === 'string' && within(source.path, file) ? path.join(destination, path.relative(source.path, file)) : file;
    const activeMoved = this.current && (remap(this.current.path) !== this.current.path || (renamedDoc && samePath(this.current.path, source.path)));
    if (activeMoved) {
      this.current.path = remap(this.current.path); this.current.token = randomUUID();
      if (renamedDoc) { this.current.doc = renamedDoc; this.current.diskContent = renamedContent; }
    }
    this.state.current = remap(this.state.current);
    this.state.recent = this.state.recent.map(item => ({ ...item, path: remap(item.path), ...(renamedDoc && samePath(item.path, source.path) ? { title } : {}) }));
    let notice;
    try {
      let recovery;
      try { recovery = JSON.parse(await fs.readFile(this.recoveryPath, 'utf8')); } catch {}
      if (recovery && remap(recovery.path) !== recovery.path) {
        if (renamedDoc && samePath(recovery.path, source.path) && recovery.doc) recovery.doc.title = title;
        recovery.path = remap(recovery.path);
        await atomicWrite(this.recoveryPath, JSON.stringify(recovery));
      }
      if (this.current) await this.remember(); else await atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // The filesystem move has committed. Return its new token so the renderer can keep saving.
      notice = '操作已完成，但位置记录未能保存，请重新打开这张导图。';
    }
    const orderNotice = await this.maintainOrder(this.remapOrder(source, destination, identity), '操作已完成，但排序未能保存，请重试。');
    notice ??= orderNotice;
    return { library: await this.readLibrary(), ...(activeMoved ? { session: this.snapshot() } : {}), ...(notice ? { notice } : {}) };
  }
}
