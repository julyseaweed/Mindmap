const { app, BrowserWindow, ipcMain, dialog, clipboard, ClipboardItem, nativeImage, shell, session, protocol, net, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createImageClipboard } = require('./clipboard.cjs');

const home = process.env.INKMAP_HOME || (app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'local-data'));
fs.mkdirSync(path.join(home, '.mindmap', 'runtime'), { recursive: true });
app.setPath('userData', path.join(home, '.mindmap', 'runtime'));
app.setPath('logs', path.join(home, '.mindmap', 'logs'));
app.setName("Mindmap");
const appearancePath = path.join(home, '.mindmap', 'appearance.json');
let theme = 'light';
try { if (JSON.parse(fs.readFileSync(appearancePath, 'utf8')).theme === 'dark') theme = 'dark'; } catch {}
const themeColors = mode => mode === 'dark'
  ? { background: '#191919', titlebar: '#202020', symbol: '#e5e2db' }
  : { background: '#ffffff', titlebar: '#ffffff', symbol: '#171717' };
nativeTheme.themeSource = theme;
protocol.registerSchemesAsPrivileged([{ scheme: 'inkmap', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, store, canClose = false, rendererReady = false, libraryWatcher, libraryTimer;
const stopLibraryWatcher = () => { clearTimeout(libraryTimer); libraryWatcher?.close(); libraryWatcher = undefined; };
const watchLibrary = () => {
  if (libraryWatcher) return;
  libraryWatcher = fs.watch(store.maps, { recursive: true }, (_, filename) => {
    if (filename && filename.toString().split(/[\\/]/).some(part => part.toLowerCase() === '.mindmap')) return;
    clearTimeout(libraryTimer);
    libraryTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send('library:changed'); }, 150);
  });
  libraryWatcher.on('error', error => { console.error('Library watcher:', error.message); stopLibraryWatcher(); });
};
const initialFile = process.argv.find(arg => arg.toLowerCase().endsWith('.mindmap'));
const isDev = process.env.INKMAP_DEV === '1';

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_, argv) => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
    const file = argv.find(arg => arg.toLowerCase().endsWith('.mindmap'));
    if (file) window.webContents.send('document:open-request', file);
  });
  app.whenReady().then(async () => {
    const { LocalStore, atomicWrite, safeFilename } = await import('./storage.mjs');
    const { validateDocument } = await import('../src/core.mjs');
    const imageClipboard = createImageClipboard({ clipboard, ClipboardItem, nativeImage, validateDocument });
    store = new LocalStore(home);
    const assets = path.join(app.getAppPath(), 'dist');
    protocol.handle('inkmap', request => {
      const url = new URL(request.url);
      if (url.host !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(assets, relative);
      if (!file.startsWith(assets + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith('inkmap://app/') || details.url.startsWith(pathToFileURL(assets + path.sep).toString()) || (isDev && /^(http|ws):\/\/127\.0\.0\.1:5178\//.test(details.url));
      callback({ cancel: !allowed });
    });
    const handle = (name, callback) => ipcMain.handle(name, (event, ...args) => {
      const url = event.senderFrame?.url || '';
      if (event.sender !== window.webContents || !(url.startsWith('inkmap://app/') || (isDev && url.startsWith('http://127.0.0.1:5178/')))) throw new Error('请求来源无效。');
      return callback(...args);
    });
    let appearanceQueue = Promise.resolve();
    let pdfExportBusy = false, pdfExportJob = Promise.resolve(null), closeRequested = false;
    handle('appearance:get-theme', () => appearanceQueue.catch(() => {}).then(() => theme));
    handle('appearance:set-theme', mode => {
      if (mode !== 'light' && mode !== 'dark') throw new Error('无效的显示模式。');
      const change = appearanceQueue.catch(() => {}).then(async () => {
        if (theme === mode) return theme;
        await atomicWrite(appearancePath, JSON.stringify({ theme: mode }, null, 2));
        theme = mode;
        nativeTheme.themeSource = theme;
        const colors = themeColors(theme);
        if (window && !window.isDestroyed()) {
          window.setBackgroundColor(colors.background);
          window.setTitleBarOverlay({ color: colors.titlebar, symbolColor: colors.symbol, height: 52 });
        }
        return theme;
      });
      appearanceQueue = change;
      return change;
    });
    let bootPromise;
    handle('document:boot', () => {
      if (!bootPromise) bootPromise = (async () => {
        let result = await store.boot();
        if (initialFile) { try { result = await store.open(initialFile); } catch { result.notice = '无法打开传入的文件，请从文件菜单重试。'; } }
        watchLibrary();
        rendererReady = true;
        return result;
      })();
      return bootPromise.then(result => ({ ...store.snapshot(), notice: result.notice }));
    });
    handle('document:save', (doc, token) => store.save(doc, token));
    handle('document:new', folderPath => store.create(undefined, folderPath));
    handle('document:recent', () => store.state.recent);
    handle('library:list', () => store.library());
    handle('library:create-folder', (name, parentPath) => store.createFolder(name, parentPath));
    handle('library:move', (sourcePath, targetFolderPath) => store.moveLibraryItem(sourcePath, targetFolderPath));
    handle('library:rename', (sourcePath, name) => store.renameLibraryItem(sourcePath, name));
    handle('library:delete', sourcePath => store.deleteLibraryItem(sourcePath, file => shell.trashItem(file)));
    handle('library:arrange', (sourcePath, targetPath, position) => store.arrangeLibraryItem(sourcePath, targetPath, position));
    handle('document:open', async file => {
      if (file !== undefined && typeof file !== 'string') throw new Error('文件路径无效。');
      if (file && store.containsLibraryPath(file)) await store.libraryPath(file, 'map');
      else if (file && !store.state.recent.some(item => item.path === file) && file !== initialFile) {
        // Paths received from a second launch are accepted only after the native picker confirms them.
        const result = await dialog.showOpenDialog(window, { defaultPath: file, properties: ['openFile'], filters: [{ name: "Mindmap", extensions: ['mindmap'] }] });
        if (result.canceled) return null;
        file = result.filePaths[0];
      }
      if (!file) {
        const result = await dialog.showOpenDialog(window, { defaultPath: store.maps, properties: ['openFile'], filters: [{ name: "Mindmap", extensions: ['mindmap'] }] });
        if (result.canceled) return null;
        file = result.filePaths[0];
      }
      return store.open(file);
    });
    handle('document:save-as', async (doc, token) => {
      const defaultPath = await store.uniquePath(`${doc.title} 副本`);
      const result = await dialog.showSaveDialog(window, { title: '保存导图副本', defaultPath, filters: [{ name: "Mindmap", extensions: ['mindmap'] }] });
      if (result.canceled || !result.filePath) return null;
      const file = result.filePath.toLowerCase().endsWith('.mindmap') ? result.filePath : result.filePath + '.mindmap';
      return store.saveAs(doc, token, file);
    });
    handle('document:export', async (text, title) => {
      if (typeof text !== 'string' || text.length > 30_000_000 || typeof title !== 'string') throw new Error('导出内容无效。');
      const result = await dialog.showSaveDialog(window, { title: '导出为 Markdown', defaultPath: path.join(store.maps, safeFilename(title) + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (result.canceled || !result.filePath) return null;
      const file = result.filePath.toLowerCase().endsWith('.md') ? result.filePath : result.filePath + '.md';
      await atomicWrite(file, text);
      return file;
    });
    handle('document:export-pdf', options => {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('PDF 导出参数无效。');
      const { width, height, title } = options;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 96 || height < 96 || width > 17280 || height > 17280 || typeof title !== 'string' || title.length > 200) throw new Error('PDF 导出尺寸或名称无效。');
      if (closeRequested) throw new Error('窗口正在关闭。');
      if (pdfExportBusy) throw new Error('PDF 正在导出，请稍候。');
      pdfExportBusy = true;
      pdfExportJob = (async () => {
        const result = await dialog.showSaveDialog(window, {
          title: '导出为 PDF',
          defaultPath: path.join(store.maps, safeFilename(title) + '.pdf'),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (result.canceled || !result.filePath) return null;
        const file = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : result.filePath + '.pdf';
        const content = await window.webContents.printToPDF({
          printBackground: true,
          displayHeaderFooter: false,
          preferCSSPageSize: true,
          // printToPDF custom page sizes use inches; the renderer supplies CSS pixels.
          pageSize: { width: width / 96, height: height / 96 },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          scale: 1,
        });
        await atomicWrite(file, content);
        return file;
      })().finally(() => { pdfExportBusy = false; });
      return pdfExportJob;
    });
    handle('clipboard:copy', text => { if (typeof text !== 'string' || text.length > 30_000_000) throw new Error('内容过长。'); return clipboard.writeText(text); });
    handle('clipboard:copy-image', image => imageClipboard.copyImage(image));
    handle('clipboard:paste-image', availableWidth => imageClipboard.pasteImage(availableWidth));
    handle('clipboard:copy-branch', branch => imageClipboard.copyBranch(branch));
    handle('clipboard:paste-branch', () => imageClipboard.pasteBranch());
    handle('clipboard:paste-text', () => imageClipboard.pasteText());
    handle('document:reveal', () => { if (store.current?.path) shell.showItemInFolder(store.current.path); else return shell.openPath(store.maps); });
    ipcMain.on('window:close-ready', event => {
      if (event.sender === window.webContents) {
        closeRequested = true;
        void pdfExportJob.catch(() => {}).then(() => appearanceQueue.catch(() => {})).then(() => {
          if (!window.isDestroyed()) { canClose = true; window.close(); }
        });
      }
    });
    window = new BrowserWindow({
      show: false,
      width: 1260, height: 820, minWidth: 560, minHeight: 420, backgroundColor: themeColors(theme).background,
      title: "Mindmap", autoHideMenuBar: true,
      icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
      titleBarStyle: 'hidden', titleBarOverlay: { color: themeColors(theme).titlebar, symbolColor: themeColors(theme).symbol, height: 52 },
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, additionalArguments: [`--inkmap-theme=${theme}`] },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!canClose && rendererReady && !window.webContents.isCrashed()) { event.preventDefault(); window.webContents.send('window:closing'); } });
    window.on('closed', stopLibraryWatcher);
    await window.loadURL(isDev ? 'http://127.0.0.1:5178/' : 'inkmap://app/index.html');
    if (process.env.INKMAP_TEST !== '1') window.show();
  }).catch(error => { console.error(error); if (!process.env.INKMAP_TEST) dialog.showErrorBox("Mindmap 启动失败", `${error.message}\n\n请确认应用文件夹可以写入。`); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopLibraryWatcher);
