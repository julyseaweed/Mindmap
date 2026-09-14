import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronRight, Copy, Scissors, ClipboardPaste, FilePlus2, FolderOpen, ListTree, Maximize, Minus, MoreHorizontal, PanelLeft, Plus, Redo2, Save, Search, Undo2, X, Download, Folder, CornerDownRight, Trash2, ChevronsUpDown, Keyboard, ExternalLink, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Box } from './core.mjs';
import { NODE_STYLE, addNode, clone, copyBranch as extractBranch, pasteBranch as insertBranch, deleteNode, deleteNodeOnly, descendants, layoutTree, moveNode, parentOf, reorderNode, toMermaid, validateDocument, visibleNodes } from './core.mjs';
import type { LibraryEntry, LibraryMutation, LibrarySnapshot, MindDocument, NodeImage, Session, Theme, View } from './types';
import { applyTheme } from './theme';
import { preparePdfExport } from './pdf-export';
import { readClipboardImage } from './clipboard-image';
import NodeImageView from './NodeImageView';
import NodeResizeHandle from './NodeResizeHandle';
import LibraryPanel from './LibraryPanel';
import ResizableSidebar from './ResizableSidebar';
import { resolveNodeDrop } from './node-drag.mjs';
import type { NodeDrop } from './node-drag.mjs';
import appIcon from '../assets/icon.png';

type Edit = { id: string; base: MindDocument; fresh: boolean };
type Snapshot = { doc: MindDocument; selected: string };
type NodeDrag = { id: string; pointerId: number; x: number; y: number; active: boolean; view: View; doc: MindDocument; boxes: Record<string, Box> };
type MediaPreview = { kind: 'column'; depth: number; width: number } | { kind: 'image'; nodeId: string; imageId: string; width: number; height: number };
const api = window.inkmap;
const titleFromText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200) || '未命名导图';
const libraryPathKey = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
const findLibraryEntry = (entries: LibraryEntry[], path: string): LibraryEntry | undefined => {
  for (const entry of entries) {
    if (libraryPathKey(entry.path) === libraryPathKey(path)) return entry;
    const found = entry.children && findLibraryEntry(entry.children, path);
    if (found) return found;
  }
};
const libraryParent = (entries: LibraryEntry[], path: string, parent: string): string | undefined => {
  for (const entry of entries) {
    if (libraryPathKey(entry.path) === libraryPathKey(path)) return parent;
    const found = entry.children && libraryParent(entry.children, path, entry.path);
    if (found) return found;
  }
};
const shortcuts = [
  ['Tab', '添加子节点'], ['Enter', '添加同级节点'], ['F2 / 双击', '编辑节点'],
  ['Shift + Enter', '节点内换行'], ['Ctrl + Enter', '完成编辑'], ['Esc', '取消本次编辑'],
  ['↑ ↓ ← →', '切换节点'], ['Alt + ↑ / ↓', '调整同级顺序'], ['Space', '折叠 / 展开分支'],
  ['Delete', '删除节点及分支'], ['Ctrl + Z', '撤销'], ['Ctrl + Shift + Z', '重做'],
  ['Ctrl + C / X', '复制 / 剪切选中的节点或图片'], ['Ctrl + V', '粘贴节点、文字或图片'],
  ['Ctrl + N', '新建导图'], ['Ctrl + O', '打开导图'], ['Ctrl + S', '立即保存'],
  ['Ctrl + Shift + S', '另存为'], ['Ctrl + Shift + C', '复制到 Obsidian'], ['Ctrl + F', '查找节点'],
  ['Ctrl + 0', '适应画布'], ['Ctrl + 滚轮', '缩放画布'], ['拖动空白处', '平移画布'],
];

function IconButton({ icon: Icon, label, onClick, disabled, active, className = '' }: { icon: LucideIcon; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon size={17} strokeWidth={1.5} /></button>;
}

function Logo() {
  return <img className="app-icon" src={appIcon} width="32" height="32" alt="" draggable={false}/>;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [themeBusy, setThemeBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [doc, setDoc] = useState<MindDocument | null>(null);
  const docRef = useRef<MindDocument | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [selected, setSelected] = useState('root');
  const [selectedImage, setSelectedImage] = useState<{ nodeId: string; imageId: string } | null>(null);
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const mediaGesture = useRef(false);
  const mediaInitialWidth = useRef(0);
  const pasteQueue = useRef(Promise.resolve());
  const selectedRef = useRef('root');
  const [edit, setEdit] = useState<Edit | null>(null);
  const editRef = useRef<Edit | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState<View>({ x: 80, y: 100, scale: 1 });
  const viewRef = useRef(view);
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 650 });
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [fatal, setFatal] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const errorSource = useRef<'save' | 'other' | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedSave = useRef<{ token: string; message: string } | null>(null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [historyCount, setHistoryCount] = useState({ past: 0, future: 0 });
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [outline, setOutline] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(() => localStorage.getItem('mindmap.libraryOpen') !== 'false');
  const [libraryWidth, setLibraryWidth] = useState(248);
  const [outlineWidth, setOutlineWidth] = useState(248);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [selectedLibraryPath, setSelectedLibraryPath] = useState('');
  const selectedLibraryPathRef = useRef('');
  const selectDraftOnSave = useRef(false);
  const selectedFolder = library ? (findLibraryEntry(library.entries, selectedLibraryPath)?.kind === 'folder' ? selectedLibraryPath : libraryParent(library.entries, selectedLibraryPath, library.root) ?? library.root) : '';
  const libraryRequest = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const contextElement = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const drag = useRef<NodeDrag | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const ignoreDragClick = useRef(false);
  const [drop, setDrop] = useState<NodeDrop | null>(null);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; view: View } | null>(null);
  const needsFit = useRef(true);
  const needsReveal = useRef(false);
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null);
  const measure = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${NODE_STYLE.fontSize}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-node').trim()}`;
    return (text: string) => context.measureText(text).width;
  }, []);
  const displayedDoc = useMemo(() => {
    if (!doc || !mediaPreview) return doc;
    if (mediaPreview.kind === 'column') return { ...doc, columnWidths: { ...doc.columnWidths, [mediaPreview.depth]: mediaPreview.width } };
    const node = doc.nodes[mediaPreview.nodeId];
    if (!node) return doc;
    return { ...doc, nodes: { ...doc.nodes, [node.id]: { ...node, images: node.images?.map(image => image.id === mediaPreview.imageId ? { ...image, width: mediaPreview.width, height: mediaPreview.height } : image) } } };
  }, [doc, mediaPreview]);
  const layout = useMemo(() => {
    if (!displayedDoc) return null;
    const editingNode = edit && displayedDoc.nodes[edit.id];
    const source = editingNode && !editingNode.text && editingNode.images?.length
      ? { ...displayedDoc, nodes: { ...displayedDoc.nodes, [editingNode.id]: { ...editingNode, text: ' ' } } }
      : displayedDoc;
    return layoutTree(source, measure);
  }, [displayedDoc, edit, measure]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const visible = useMemo(() => displayedDoc ? visibleNodes(displayedDoc) : [], [displayedDoc]);
  const draggedNodes = useMemo(() => new Set(dragId && doc?.nodes[dragId] ? descendants(doc, dragId) : []), [dragId, doc]);
  const matches = useMemo(() => doc && query.trim() ? Object.values(doc.nodes).filter(node => node.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [], [doc, query]);

  const clearError = useCallback((source?: 'save' | 'other') => {
    if (source && errorSource.current !== source) return;
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = null;
    errorSource.current = null;
    setErrorMessage('');
  }, []);

  const showError = useCallback((text: string, source: 'save' | 'other' = 'other') => {
    setErrorMessage(text);
    errorSource.current = source;
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => clearError(), 8500);
  }, [clearError]);

  const toggleTheme = async () => {
    if (themeBusy) return;
    setThemeBusy(true);
    try {
      const next = theme === 'light' ? 'dark' : 'light';
      const applied = api ? await api.setTheme(next) : next;
      applyTheme(applied);
      setTheme(applied);
    } catch {
      showError('显示模式未能保存，请重试。');
    } finally { setThemeBusy(false); }
  };

  const selectLibraryPath = useCallback((path: string) => {
    selectDraftOnSave.current = false;
    selectedLibraryPathRef.current = path;
    setSelectedLibraryPath(path);
  }, []);

  const acceptLibrary = useCallback((snapshot: LibrarySnapshot) => {
    setLibrary(snapshot);
    const selection = selectedLibraryPathRef.current;
    // Keep a missing working file's selection until save can recover its path.
    if (selection && !findLibraryEntry(snapshot.entries, selection) && libraryPathKey(selection) !== libraryPathKey(sessionRef.current?.path ?? '')) selectLibraryPath('');
  }, [selectLibraryPath]);

  const refreshLibrary = useCallback(async () => {
    if (!api) return;
    const request = ++libraryRequest.current;
    try {
      const snapshot = await api.library();
      if (request === libraryRequest.current && !busyRef.current) acceptLibrary(snapshot);
    } catch (error) { showError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
  }, [acceptLibrary, showError]);

  useEffect(() => {
    localStorage.setItem('mindmap.libraryOpen', String(libraryOpen));
    if (!libraryOpen || !api || !session) return;
    void refreshLibrary();
    const refresh = () => { void refreshLibrary(); };
    const unsubscribe = api.onLibraryChange(refresh);
    window.addEventListener('focus', refresh);
    return () => { unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [libraryOpen, !!session, refreshLibrary]);

  const updateView = useCallback((next: View | ((old: View) => View)) => {
    const value = typeof next === 'function' ? next(viewRef.current) : next;
    viewRef.current = value;
    setView(value);
  }, []);

  const select = useCallback((id: string, reveal = true) => {
    setSelectedImage(null);
    selectedRef.current = id;
    setSelected(id);
    needsReveal.current = reveal;
  }, []);

  const flush = useCallback(async (explicit = true) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!api || !docRef.current || !sessionRef.current || revision.current === savedRevision.current) return;
    const version = revision.current;
    const token = sessionRef.current.token;
    if (explicit || !failedSave.current) setSaveState('saving');
    try {
      const saved = await api.save(docRef.current, token);
      if (sessionRef.current?.token === token) {
        if (saved.path !== sessionRef.current.path) {
          const previousPath = sessionRef.current.path;
          sessionRef.current = { ...sessionRef.current, path: saved.path };
          setSession(sessionRef.current);
          if (selectDraftOnSave.current || (previousPath && libraryPathKey(selectedLibraryPathRef.current) === libraryPathKey(previousPath))) selectLibraryPath(saved.path);
          void refreshLibrary();
        }
        savedRevision.current = Math.max(savedRevision.current, version);
        failedSave.current = null;
        clearError('save');
        setSaveState(savedRevision.current === revision.current ? 'saved' : 'saving');
      }
    } catch (error) {
      if (sessionRef.current?.token === token) {
        const message = String((error as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, '');
        const previous = failedSave.current;
        failedSave.current = { token, message };
        setSaveState('error');
        if (explicit || previous?.token !== token || previous.message !== message) showError(message, 'save');
      }
      throw error;
    }
  }, [showError, clearError, selectLibraryPath, refreshLibrary]);

  const markChanged = useCallback((next: MindDocument) => {
    docRef.current = next;
    setDoc(next);
    revision.current++;
    setSaveState(failedSave.current ? 'error' : 'saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Even after a write conflict, each edit must reach the recovery snapshot.
    saveTimer.current = setTimeout(() => { void flush(false).catch(() => {}); }, 300);
  }, [flush]);

  const syncHistory = () => setHistoryCount({ past: history.current.past.length, future: history.current.future.length });
  const pushHistory = (snapshot: Snapshot) => {
    history.current.past.push(snapshot);
    if (history.current.past.length > 100) history.current.past.shift();
    history.current.future = [];
    syncHistory();
  };

  const rememberAnchor = () => {
    const box = layoutRef.current?.boxes[selectedRef.current];
    if (box) anchor.current = { id: box.id, x: box.x, y: box.y };
  };

  const apply = (next: MindDocument, id = selectedRef.current) => {
    if (!docRef.current || next === docRef.current) return;
    pushHistory({ doc: docRef.current, selected: selectedRef.current });
    rememberAnchor();
    markChanged(next);
    select(id);
  };

  const finishEdit = () => {
    const current = editRef.current;
    if (!current || !docRef.current) return;
    if (!current.fresh && current.base.nodes[current.id]?.text !== docRef.current.nodes[current.id]?.text) pushHistory({ doc: current.base, selected: current.id });
    editRef.current = null;
    setEdit(null);
  };

  const cancelNodeDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    setDragId(null); setDragOffset({ x: 0, y: 0 }); setDrop(null);
    if (active && canvas.current?.hasPointerCapture(active.pointerId)) canvas.current.releasePointerCapture(active.pointerId);
  }, []);

  const beginNodeDrag = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || busyRef.current || mediaGesture.current || !docRef.current || !layoutRef.current) return;
    event.stopPropagation();
    cancelNodeDrag(); ignoreDragClick.current = false;
    finishEdit(); select(id, false); setMenu(false); setContext(null);
    drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, view: { ...viewRef.current }, doc: docRef.current, boxes: layoutRef.current.boxes };
  };

  const beginMediaResize = (nodeId: string, imageId?: string) => {
    finishEdit();
    select(nodeId, false);
    if (imageId) setSelectedImage({ nodeId, imageId });
    setMenu(false); setContext(null);
    mediaInitialWidth.current = layoutRef.current?.boxes[nodeId]?.width ?? 0;
    mediaGesture.current = true;
  };
  const previewMediaResize = (preview: MediaPreview) => { rememberAnchor(); setMediaPreview(preview); };
  const cancelMediaResize = () => { rememberAnchor(); setMediaPreview(null); mediaGesture.current = false; };
  const commitColumnWidth = (nodeId: string, depth: number, width: number) => {
    const current = docRef.current;
    if (current?.nodes[nodeId] && width !== mediaInitialWidth.current && current.columnWidths?.[depth] !== width) {
      apply({ ...current, columnWidths: { ...current.columnWidths, [depth]: width } }, nodeId);
      select(nodeId, false);
    }
    setMediaPreview(null); mediaGesture.current = false;
  };
  const commitImageSize = (nodeId: string, imageId: string, size: { width: number; height: number }) => {
    const current = docRef.current, node = current?.nodes[nodeId];
    const previous = node?.images?.find(image => image.id === imageId);
    if (current && node && previous && (previous.width !== size.width || previous.height !== size.height)) {
      apply({ ...current, nodes: { ...current.nodes, [nodeId]: { ...node, images: node.images!.map(image => image.id === imageId ? { ...image, ...size } : image) } } }, nodeId);
      select(nodeId, false);
      setSelectedImage({ nodeId, imageId });
    }
    setMediaPreview(null); mediaGesture.current = false;
  };
  const removeImage = (nodeId: string, imageId: string) => {
    if (drag.current?.active) return;
    const current = docRef.current, node = current?.nodes[nodeId];
    if (!current || !node?.images?.some(image => image.id === imageId) || busyRef.current) return;
    finishEdit();
    const nextNode = { ...node };
    nextNode.images = node.images.filter(image => image.id !== imageId);
    if (!nextNode.images.length) delete nextNode.images;
    apply({ ...current, nodes: { ...current.nodes, [nodeId]: nextNode } }, nodeId);
  };

  const copyImage = (nodeId: string, imageId: string, cut = false) => {
    const image = docRef.current?.nodes[nodeId]?.images?.find(image => image.id === imageId);
    const token = sessionRef.current?.token;
    if (!api || !image || !token || busyRef.current || mediaGesture.current || drag.current?.active) return;
    finishEdit();
    pasteQueue.current = pasteQueue.current.then(async () => {
      if (cut && (sessionRef.current?.token !== token || !docRef.current?.nodes[nodeId]?.images?.some(image => image.id === imageId))) return;
      await api.copyImage(image);
      // Remove only after the system clipboard has accepted the image.
      const current = docRef.current, node = current?.nodes[nodeId];
      if (!cut || !current || !node?.images || sessionRef.current?.token !== token) return;
      if (!node.images.some(image => image.id === imageId)) return;
      finishEdit();
      const nextNode: typeof node = { ...node, images: node.images.filter(image => image.id !== imageId) };
      if (!nextNode.images!.length) delete nextNode.images;
      apply({ ...current, nodes: { ...current.nodes, [nodeId]: nextNode } }, nodeId);
      requestAnimationFrame(() => {
        if (sessionRef.current?.token === token && selectedRef.current === nodeId && document.activeElement === document.body) canvas.current?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.focus({ preventScroll: true });
      });
    }).catch(error => showError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')));
  };

  const copyNodes = (nodeId = selectedRef.current, cut = false) => {
    const token = sessionRef.current?.token;
    if (!api || !docRef.current?.nodes[nodeId] || !token || busyRef.current || mediaGesture.current || drag.current?.active || (cut && nodeId === docRef.current.rootId)) return;
    finishEdit(); setContext(null);
    pasteQueue.current = pasteQueue.current.then(async () => {
      const before = docRef.current;
      if (!before?.nodes[nodeId] || sessionRef.current?.token !== token) return;
      const branch = extractBranch(before, nodeId);
      await api.copyBranch(branch);
      const current = docRef.current;
      if (!cut || !current?.nodes[nodeId] || sessionRef.current?.token !== token) return;
      const unchanged = Object.entries(branch.nodes).every(([id, source]) => {
        const target = current.nodes[id];
        return target && source.text === target.text && source.collapsed === target.collapsed && source.children.join(',') === target.children.join(',')
          && (source.images?.length ?? 0) === (target.images?.length ?? 0)
          && (source.images ?? []).every((image, index) => {
            const other = target.images![index];
            return image.id === other.id && image.dataUrl === other.dataUrl && image.width === other.width && image.height === other.height;
          });
      });
      if (!unchanged) throw new Error('节点内容刚刚发生了变化，已保留原节点。请重新剪切。');
      finishEdit();
      const result = deleteNode(current, nodeId);
      apply(result.doc, result.selectedId);
      requestAnimationFrame(() => {
        if (sessionRef.current?.token === token && selectedRef.current === result.selectedId) canvas.current?.querySelector<HTMLElement>(`[data-node-id="${result.selectedId}"]`)?.focus({ preventScroll: true });
      });
    }).catch(error => showError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')));
  };

  const pasteContent = (nodeId = selectedRef.current, files: File[] = [], imageOnly = false) => {
    const token = sessionRef.current?.token;
    if (!docRef.current?.nodes[nodeId] || !token || busyRef.current || mediaGesture.current || drag.current?.active) return;
    const availableWidth = (layoutRef.current?.boxes[nodeId]?.width ?? NODE_STYLE.maxAutoWidth) - NODE_STYLE.insetX;
    finishEdit(); setContext(null);
    pasteQueue.current = pasteQueue.current.then(async () => {
      const branch = api && !imageOnly && !files.length ? await api.pasteBranch() : null;
      if (branch) {
        const current = docRef.current;
        if (!current?.nodes[nodeId] || sessionRef.current?.token !== token) return;
        const result = insertBranch(current, nodeId, branch);
        finishEdit(); apply(result.doc, result.selectedId);
        requestAnimationFrame(() => {
          if (sessionRef.current?.token === token && selectedRef.current === result.selectedId) canvas.current?.querySelector<HTMLElement>(`[data-node-id="${result.selectedId}"]`)?.focus({ preventScroll: true });
        });
        return;
      }
      const images: NodeImage[] = [];
      // Native clipboard access also preserves the size of pictures copied in the app.
      const native = api && files.length <= 1 ? await api.pasteImage(availableWidth) : null;
      if (native) images.push({ ...native, id: 'i' + crypto.randomUUID().replaceAll('-', '') });
      else for (const file of files) images.push(await readClipboardImage(file, availableWidth));
      if (!images.length) {
        const text = api && !imageOnly ? await api.pasteText() : '';
        const current = docRef.current;
        if (!text.trim() || !current?.nodes[nodeId] || sessionRef.current?.token !== token) return;
        if (text.length > 8000) throw new Error('文字过长，请分段粘贴到不同节点。');
        const result = addNode(current, nodeId, 'child', text.replace(/\r\n?/g, '\n'));
        finishEdit(); apply(result.doc, result.selectedId);
        requestAnimationFrame(() => {
          if (sessionRef.current?.token === token && selectedRef.current === result.selectedId) canvas.current?.querySelector<HTMLElement>(`[data-node-id="${result.selectedId}"]`)?.focus({ preventScroll: true });
        });
        return;
      }
      const current = docRef.current, node = current?.nodes[nodeId];
      if (!current || !node || sessionRef.current?.token !== token) return;
      const existing = Object.values(current.nodes).flatMap(node => node.images ?? []);
      if ((node.images?.length ?? 0) + images.length > 32 || existing.length + images.length > 256 || [...existing, ...images].reduce((total, image) => total + image.dataUrl.length, 0) > 48 * 1024 * 1024) throw new Error('这张导图的图片已较多，请减少图片或另建一张导图。');
      const next = validateDocument({ ...current, nodes: { ...current.nodes, [nodeId]: { ...node, images: [...(node.images ?? []), ...images] } } });
      finishEdit();
      apply(next, nodeId);
      const imageId = images[images.length - 1].id;
      setSelectedImage({ nodeId, imageId });
      requestAnimationFrame(() => {
        if (sessionRef.current?.token === token && selectedRef.current === nodeId && !editRef.current) canvas.current?.querySelector<HTMLElement>(`[data-image-id="${imageId}"]`)?.focus({ preventScroll: true });
      });
    }).catch(error => showError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '')));
  };

  const startEdit = (id = selectedRef.current, fresh = false) => {
    if (!docRef.current || busyRef.current) return;
    finishEdit();
    select(id);
    const editing = { id, base: clone(docRef.current), fresh };
    editRef.current = editing;
    setEdit(editing);
  };

  const add = (kind: 'child' | 'sibling') => {
    if (!docRef.current || busyRef.current) return;
    finishEdit();
    try {
      const result = addNode(docRef.current, selectedRef.current, kind);
      apply(result.doc, result.selectedId);
      startEdit(result.selectedId, true);
    } catch { showError('导图已达到容量或层级上限，请新建一张导图继续记录。'); }
  };

  const remove = (keepChildren = false) => {
    if (!docRef.current || selectedRef.current === docRef.current.rootId || busyRef.current || mediaGesture.current || drag.current?.active) return;
    finishEdit();
    const result = (keepChildren ? deleteNodeOnly : deleteNode)(docRef.current, selectedRef.current);
    apply(result.doc, result.selectedId);
    setContext(null);
  };

  const toggle = (id = selectedRef.current) => {
    if (!docRef.current?.nodes[id].children.length) return;
    finishEdit();
    const next = clone(docRef.current);
    next.nodes[id].collapsed = !next.nodes[id].collapsed;
    apply(next, id);
  };

  const undo = (redo = false) => {
    if (busyRef.current) return;
    finishEdit();
    const token = sessionRef.current?.token;
    pasteQueue.current = pasteQueue.current.then(() => {
      if (!docRef.current || sessionRef.current?.token !== token) return;
      finishEdit();
      const from = redo ? history.current.future : history.current.past;
      const to = redo ? history.current.past : history.current.future;
      const snapshot = from.pop();
      if (!snapshot) return;
      to.push({ doc: docRef.current, selected: selectedRef.current });
      rememberAnchor();
      markChanged(snapshot.doc);
      select(snapshot.selected);
      syncHistory();
    });
  };

  const fit = useCallback(() => {
    const graph = layoutRef.current;
    const rect = canvas.current?.getBoundingClientRect();
    if (!graph || !rect) return;
    const scale = Math.max(0.05, Math.min(1, (rect.width - 130) / graph.width, (rect.height - 170) / graph.height));
    updateView({ scale, x: (rect.width - graph.width * scale) / 2, y: (rect.height - graph.height * scale) / 2 - 8 });
  }, [updateView]);

  const zoom = (factor: number, point?: { x: number; y: number }) => {
    if (drag.current?.active || mediaGesture.current) return;
    const current = viewRef.current;
    const scale = Math.max(0.05, Math.min(2.5, current.scale * factor));
    const rect = canvas.current?.getBoundingClientRect();
    const x = point?.x ?? (rect?.width ?? 800) / 2;
    const y = point?.y ?? (rect?.height ?? 600) / 2;
    updateView({ scale, x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale });
  };

  const loadSession = useCallback((next: Session) => {
    cancelNodeDrag();
    clearError();
    failedSave.current = null;
    setMediaPreview(null); setSelectedImage(null); mediaGesture.current = false;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    sessionRef.current = next;
    docRef.current = next.doc;
    const nextDoc = next.doc;
    const root = nextDoc?.nodes[nextDoc.rootId];
    const editing = nextDoc && nextDoc.title === '未命名导图' && Object.keys(nextDoc.nodes).length === 1 && root?.text === '' && !root.images?.length
      ? { id: nextDoc.rootId, base: clone(nextDoc), fresh: false } : null;
    editRef.current = editing;
    setSession(next);
    selectLibraryPath(next.path);
    selectDraftOnSave.current = !!nextDoc && !next.path;
    setDoc(next.doc);
    setEdit(editing);
    setSaveState('saved');
    setMenu(false);
    setContext(null);
    setRenaming(false);
    setQuery('');
    setSearchOpen(false);
    history.current = { past: [], future: [] };
    setHistoryCount({ past: 0, future: 0 });
    revision.current = 0;
    savedRevision.current = 0;
    anchor.current = null;
    needsFit.current = !!nextDoc;
    pan.current = null; setPanning(false);
    select(nextDoc?.rootId ?? '', false);
    if (nextDoc && root && nextDoc.title === '未命名导图' && root.text !== '中心主题') {
      const title = titleFromText(root.text);
      if (title !== nextDoc.title) markChanged({ ...nextDoc, title });
    }
    if (next.notice) showError(next.notice);
  }, [showError, clearError, select, markChanged, selectLibraryPath, cancelNodeDrag]);

  const fileAction = async (action: 'new' | 'open' | 'save-as', path?: string) => {
    if (!api || !sessionRef.current || busyRef.current || (action === 'save-as' && !docRef.current)) return;
    finishEdit();
    if (action === 'save-as' && saveTimer.current) clearTimeout(saveTimer.current);
    busyRef.current = true;
    setBusy(true);
    setMenu(false);
    let savingSource = action !== 'save-as';
    try {
      await pasteQueue.current;
      if (action === 'save-as') {
        await api.saveAs(docRef.current!, sessionRef.current.token);
      } else {
        await flush();
        savingSource = false;
        const next = action === 'new' ? await api.newDocument(path) : await api.open(path);
        if (next) loadSession(next);
      }
    } catch (error) {
      if (!savingSource) showError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    }
    finally {
      // A copy (including a cancelled picker) never becomes the working document.
      // Resume the source save that was deferred while the native picker was open.
      if (action === 'save-as') await flush().catch(() => {});
      busyRef.current = false; setBusy(false);
      void refreshLibrary();
      if (revision.current !== savedRevision.current && !failedSave.current) saveTimer.current = setTimeout(() => { void flush(false).catch(() => {}); }, 300);
    }
  };

  const changeLibrary = async (action: () => Promise<LibraryMutation>, options: { relocation?: { source: string; destination: string }; reloadSession?: boolean } = {}) => {
    if (!api || busyRef.current) throw new Error('请稍候再试。');
    finishEdit();
    busyRef.current = true; setBusy(true);
    let savingSource = true;
    try {
      await pasteQueue.current;
      await flush();
      savingSource = false;
      const previousSelection = selectedLibraryPathRef.current;
      const result = await action();
      ++libraryRequest.current;
      if (result.session) {
        if (options.reloadSession || result.session.doc?.id !== docRef.current?.id || result.session.doc?.title !== docRef.current?.title) loadSession(result.session);
        else { sessionRef.current = result.session; setSession(result.session); }
      }
      const { relocation } = options;
      let candidate = previousSelection;
      if (relocation) {
        const sourceKey = libraryPathKey(relocation.source);
        const selectedKey = libraryPathKey(previousSelection);
        const relocated = selectedKey === sourceKey || selectedKey.startsWith(sourceKey + '/');
        if (relocated) candidate = relocation.destination + previousSelection.slice(relocation.source.length);
      }
      selectLibraryPath(findLibraryEntry(result.library.entries, candidate)?.path ?? '');
      acceptLibrary(result.library);
      if (result.notice) showError(result.notice);
      return result.library;
    } catch (error) {
      const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
      if (!savingSource) showError(message);
      throw new Error(message);
    } finally { busyRef.current = false; setBusy(false); }
  };

  const createLibraryFolder = async (name: string, parentPath: string) => {
    const snapshot = await changeLibrary(async () => ({ library: await api!.createFolder(name, parentPath) }));
    const entries = parentPath === snapshot.root ? snapshot.entries : findLibraryEntry(snapshot.entries, parentPath)?.children ?? [];
    const folder = entries.find(entry => entry.kind === 'folder' && entry.name === name.trim());
    if (folder) selectLibraryPath(folder.path);
  };

  const renameLibraryItem = async (path: string, name: string) => {
    if (!library) return;
    const entry = findLibraryEntry(library.entries, path);
    const parent = libraryParent(library.entries, path, library.root);
    if (!entry || !parent) return;
    const filename = entry.kind === 'map' ? name.replace(/\.mindmap$/i, '').trim() + '.mindmap' : name.trim();
    await changeLibrary(() => api!.renameLibraryItem(path, name), { relocation: { source: path, destination: parent + '/' + filename } });
  };

  const moveLibraryItem = async (path: string, folder: string) => {
    const entry = library && findLibraryEntry(library.entries, path);
    if (!entry) return;
    await changeLibrary(() => api!.moveLibraryItem(path, folder), { relocation: { source: path, destination: folder + '/' + entry.name } });
  };

  const arrangeLibraryItem = async (path: string, target: string, position: 'before' | 'after' | 'inside') => {
    if (!library) return;
    const entry = findLibraryEntry(library.entries, path);
    const folder = position === 'inside' ? target : libraryParent(library.entries, target, library.root);
    if (!entry || !folder) return;
    await changeLibrary(() => api!.arrangeLibraryItem(path, target, position), { relocation: { source: path, destination: folder + '/' + entry.name } });
  };

  const exportText = async (destination: 'clipboard' | 'markdown') => {
    if (!api || !docRef.current || busyRef.current || mediaGesture.current || drag.current?.active) return;
    finishEdit(); setMenu(false); setContext(null);
    busyRef.current = true; setBusy(true);
    try {
      await pasteQueue.current;
      const current = docRef.current;
      const text = toMermaid(current);
      if (destination === 'clipboard') await api.copy(text);
      else await api.exportMarkdown(text, current.title);
    } catch (error) {
      showError(destination === 'clipboard' ? '复制失败，请使用文件菜单中的「导出为 Markdown」。' : (error as Error).message);
    } finally { busyRef.current = false; setBusy(false); void refreshLibrary(); }
  };
  const copy = () => exportText('clipboard');
  const exportFile = () => exportText('markdown');

  const exportPdf = async () => {
    if (!api || !docRef.current || busyRef.current || mediaGesture.current || drag.current?.active) return;
    busyRef.current = true;
    let prepared: ReturnType<typeof preparePdfExport> | undefined;
    try {
      flushSync(() => { finishEdit(); setMenu(false); setContext(null); setBusy(true); });
      await pasteQueue.current;
      flushSync(() => { setDoc(docRef.current); });
      await document.fonts.ready;
      await Promise.all(Array.from(canvas.current?.querySelectorAll<HTMLImageElement>('.node-image img') ?? []).map(image => image.decode()));
      const world = canvas.current?.querySelector<HTMLElement>('.world');
      const currentLayout = layoutRef.current;
      if (!world || !currentLayout) throw new Error('暂时无法读取导图，请重试。');
      prepared = preparePdfExport(world, currentLayout, docRef.current.title);
      await Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>('#pdf-export img')).map(image => image.decode()));
      await api.exportPdf({ width: prepared.width, height: prepared.height, title: docRef.current.title });
    } catch (error) {
      showError('导出 PDF 失败：' + (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      prepared?.dispose();
      busyRef.current = false;
      setBusy(false);
      void refreshLibrary();
    }
  };

  const goToMatch = (id: string) => {
    finishEdit();
    if (!docRef.current) return;
    const next = clone(docRef.current);
    let parent = parentOf(next, id), changed = false;
    while (parent) { if (next.nodes[parent].collapsed) { next.nodes[parent].collapsed = false; changed = true; } parent = parentOf(next, parent); }
    if (changed) apply(next, id); else select(id);
  };

  const commitName = () => {
    if (!renaming || !docRef.current) return;
    const title = name.trim().slice(0, 200) || '未命名导图';
    if (title !== docRef.current.title) apply({ ...docRef.current, title });
    setRenaming(false);
  };

  useEffect(() => {
    if (!api) { setFatal('请从应用文件夹打开 Mindmap.exe。'); return; }
    let cancelled = false;
    api.boot().then(value => { if (!cancelled) loadSession(value); }).catch(error => { if (!cancelled) setFatal(error.message); });
    return () => { cancelled = true; };
  }, [loadSession]);

  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
      needsReveal.current = true;
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [!!session]);

  useLayoutEffect(() => {
    if (!layout) return;
    if (needsFit.current) { fit(); needsFit.current = false; }
    else {
      let next = { ...viewRef.current };
      if (anchor.current) {
        const box = layout.boxes[anchor.current.id];
        if (box) { next.x += (anchor.current.x - box.x) * next.scale; next.y += (anchor.current.y - box.y) * next.scale; }
        anchor.current = null;
      }
      if (needsReveal.current) {
        const box = layout.boxes[selectedRef.current];
        if (box) {
          const left = box.x * next.scale + next.x, top = box.y * next.scale + next.y;
          const right = left + box.width * next.scale, bottom = top + box.height * next.scale;
          if (left < 48) next.x += 48 - left;
          else if (right > size.width - 64) next.x -= right - size.width + 64;
          if (top < 50) next.y += 50 - top;
          else if (bottom > size.height - 120) next.y -= bottom - size.height + 120;
        }
        needsReveal.current = false;
      }
      updateView(next);
    }
  }, [layout, selected, size, fit, updateView]);

  useLayoutEffect(() => { if (edit && editor.current) { editor.current.focus(); editor.current.select(); } }, [edit]);
  useLayoutEffect(() => { if (renaming) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renaming]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.search-panel, .popover, .outline-panel')) return;
      event.preventDefault();
      if (!docRef.current || drag.current?.active || mediaGesture.current) return;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.005), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      else updateView(v => ({ ...v, x: v.x - (event.shiftKey ? event.deltaY : event.deltaX), y: v.y - (event.shiftKey ? 0 : event.deltaY) }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [!!session, updateView]);

  useEffect(() => {
    const close = api?.onClose(() => {
      cancelNodeDrag();
      commitName();
      finishEdit();
      busyRef.current = true; setBusy(true);
      void pasteQueue.current.then(() => flush()).then(() => api.confirmClose()).catch(() => {
        busyRef.current = false; setBusy(false);
        showError('关闭前保存失败。请先重试保存，或用「另存为」保留内容。', 'save');
      });
    });
    const open = api?.onOpen(path => { void fileAction('open', path); });
    return () => { close?.(); open?.(); };
  });

  useLayoutEffect(() => {
    if (!context || !contextElement.current) return;
    const bounds = contextElement.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(context.x, window.innerWidth - bounds.width - 8));
    const y = Math.max(8, Math.min(context.y, window.innerHeight - bounds.height - 8));
    if (x !== context.x || y !== context.y) setContext({ x, y });
  }, [context]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement;
      if (busyRef.current || mediaGesture.current || drag.current?.active) { event.preventDefault(); return; }
      if (!docRef.current || !sessionRef.current) return;
      if (target.closest?.('input, [contenteditable="true"], .library-panel, .outline-panel, .popover, .library-dialog, .help-modal, .search-panel') || (target.tagName === 'TEXTAREA' && !target.classList.contains('node-editor'))) return;
      if (target !== document.body && target !== document.documentElement && !target.closest?.('.canvas')) return;
      const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      event.preventDefault();
      pasteContent(selectedRef.current, files, true);
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || busyRef.current || mediaGesture.current || drag.current?.active) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const input = (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]');
      if (modifier && key === 's') { event.preventDefault(); if (event.shiftKey) void fileAction('save-as'); else { finishEdit(); void pasteQueue.current.then(() => flush()).catch(() => {}); } return; }
      if (modifier && key === 'o') { event.preventDefault(); void fileAction('open'); return; }
      if (modifier && key === 'n') { event.preventDefault(); void fileAction('new'); return; }
      if (modifier && event.shiftKey && key === 'c') { event.preventDefault(); void copy(); return; }
      if (input) return;
      const mediaTarget = (event.target as HTMLElement).closest('.canvas, .node-image-menu, .outline-panel, .context-menu') || event.target === document.body || event.target === document.documentElement;
      if (modifier && !event.shiftKey && mediaTarget && !help && !renaming) {
        if (key === 'c' || key === 'x') {
          event.preventDefault();
          if (selectedImage) copyImage(selectedImage.nodeId, selectedImage.imageId, key === 'x');
          else copyNodes(selectedRef.current, key === 'x');
          return;
        }
        if (key === 'v') { event.preventDefault(); pasteContent(selectedRef.current, [], !!selectedImage); return; }
      }
      if (selectedImage && (key === 'delete' || key === 'backspace')) { event.preventDefault(); removeImage(selectedImage.nodeId, selectedImage.imageId); return; }
      if (selectedImage && key === 'escape') { setSelectedImage(null); return; }
      if (help) { if (key === 'escape') setHelp(false); return; }
      if (key === 'escape') { setMenu(false); setContext(null); setSearchOpen(false); return; }
      if (!docRef.current) return;
      if (modifier && key === 'f') { event.preventDefault(); setSearchOpen(true); return; }
      if (modifier && key === '0') { event.preventDefault(); fit(); return; }
      if (modifier && (key === '=' || key === '+' || key === '-')) { event.preventDefault(); zoom(key === '-' ? 0.85 : 1.18); return; }
      if (modifier && (key === 'z' || key === 'y')) { event.preventDefault(); undo(key === 'y' || event.shiftKey); return; }
      if (key === 'tab') { event.preventDefault(); add('child'); return; }
      if (key === 'enter') { event.preventDefault(); add('sibling'); return; }
      if (key === 'f2') { event.preventDefault(); startEdit(); return; }
      if (key === 'delete' || key === 'backspace') { event.preventDefault(); remove(); return; }
      if (key === ' ') { event.preventDefault(); toggle(); return; }
      if (key === '?') { event.preventDefault(); setHelp(true); return; }
      if (key.startsWith('arrow')) {
        event.preventDefault();
        const id = selectedRef.current, current = docRef.current;
        if (event.altKey && ['arrowup', 'arrowdown'].includes(key)) { apply(reorderNode(current, id, key === 'arrowup' ? -1 : 1)); return; }
        if (key === 'arrowleft') { const parent = parentOf(current, id); if (parent) select(parent); }
        if (key === 'arrowright') { if (current.nodes[id].collapsed) toggle(); else if (current.nodes[id].children[0]) select(current.nodes[id].children[0]); }
        if (key === 'arrowup' || key === 'arrowdown') {
          const boxes = Object.values(layoutRef.current?.boxes ?? {}).filter(box => box.depth === layoutRef.current?.boxes[id]?.depth).sort((a, b) => a.y - b.y);
          const index = boxes.findIndex(box => box.id === id);
          const next = boxes[index + (key === 'arrowup' ? -1 : 1)];
          if (next) select(next.id);
        }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  useEffect(() => {
    const dropAt = (event: PointerEvent, current: NodeDrag) => {
      const bounds = canvas.current?.getBoundingClientRect();
      if (!bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null;
      return resolveNodeDrop(current.doc, current.boxes, current.id, {
        x: (event.clientX - bounds.left - current.view.x) / current.view.scale,
        y: (event.clientY - bounds.top - current.view.y) / current.view.scale,
      });
    };
    const move = (event: PointerEvent) => {
      if (pan.current) {
        updateView({ ...pan.current.view, x: pan.current.view.x + event.clientX - pan.current.x, y: pan.current.view.y + event.clientY - pan.current.y });
        return;
      }
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.doc !== docRef.current || busyRef.current) { cancelNodeDrag(); return; }
      if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
      event.preventDefault();
      if (!current.active) {
        current.active = true;
        setDragId(current.id);
        try { canvas.current?.setPointerCapture(current.pointerId); } catch { cancelNodeDrag(); return; }
      }
      setDragOffset({ x: (event.clientX - current.x) / current.view.scale, y: (event.clientY - current.y) / current.view.scale });
      const target = dropAt(event, current);
      setDrop(target);
    };
    const up = (event: PointerEvent) => {
      const current = drag.current;
      if (current && current.pointerId !== event.pointerId) return;
      if (current?.active) {
        ignoreDragClick.current = true;
        const target = dropAt(event, current);
        if (current.doc === docRef.current && !busyRef.current) {
          if (current.id === current.doc.rootId) {
            updateView({ ...current.view, x: current.view.x + event.clientX - current.x, y: current.view.y + event.clientY - current.y });
          } else if (target) {
            try {
              apply(moveNode(current.doc, current.id, target.id, target.position), current.id);
              // Keep the camera still when dropping; the normal edit anchor would
              // otherwise pull the branch back to its original screen position.
              anchor.current = null; select(current.id, false);
            }
            catch { showError('无法移动到这里：层级过深。'); }
          }
        }
      }
      cancelNodeDrag(); pan.current = null; setPanning(false);
    };
    const cancel = () => { cancelNodeDrag(); pan.current = null; setPanning(false); };
    const cancelPointer = (event: PointerEvent) => { if (!drag.current || drag.current.pointerId === event.pointerId) cancel(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault(); event.stopPropagation(); ignoreDragClick.current = true; cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('lostpointercapture', cancelPointer);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('lostpointercapture', cancelPointer);
      window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); window.removeEventListener('keydown', escape, true);
    };
  });

  if (fatal) return <main className="fatal"><Logo/><h1>暂时无法打开应用</h1><p>{fatal}</p><button className="primary-button" onClick={() => location.reload()}>重新打开</button></main>;
  if (!session) return <main className="loading"><Logo/><span>Mindmap</span></main>;
  const currentNode = doc?.nodes[selected];
  const currentBox = layout?.boxes[selected];

  return <div className={`app ${busy ? 'busy' : ''}`} data-save-state={saveState} onKeyDownCapture={event => {
    if (busyRef.current || mediaGesture.current || drag.current?.active) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <header className="titlebar">
      <div className="brand"><Logo/><span>Mindmap</span></div>
      <button type="button" className="icon-button theme-toggle" aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'} title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'} disabled={themeBusy}
        onPointerDown={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()} onClick={() => void toggleTheme()}>
        {theme === 'light' ? <Moon size={17} strokeWidth={1.5}/> : <Sun size={17} strokeWidth={1.5}/>}
      </button>
    </header>
    <header className="toolbar">
      <div className="file-section">
        <IconButton icon={PanelLeft} label="导图库" active={libraryOpen} onClick={() => { finishEdit(); setLibraryOpen(!libraryOpen); if (!libraryOpen) setOutline(false); }}/>
        <button className={`file-button ${menu ? 'active' : ''}`} aria-label="文件菜单" title="文件菜单" onClick={() => { finishEdit(); setMenu(!menu); setContext(null); }}><FolderOpen size={18} strokeWidth={1.5}/><ChevronDown size={12}/></button>
        {doc && <><span className="divider"/>
        <div className="document-heading">
          {renaming ? <input ref={renameRef} className="title-input" aria-label="导图名称" maxLength={200} value={name} onChange={e => setName(e.target.value)} onBlur={commitName} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setRenaming(false); }}/>
            : <button className="document-title" title="点击修改导图名称" onClick={() => { finishEdit(); setName(doc.title); setRenaming(true); }}>{doc.title}</button>}
          {saveState === 'error' && <button className="save-error" role="alert" onClick={() => void flush().catch(() => {})}>保存失败 · 点击重试</button>}
        </div></>}
      </div>
      <div className="toolbar-actions">
        <div className="history-buttons"><IconButton icon={Undo2} label="撤销 (Ctrl + Z)" disabled={!historyCount.past && !edit} onClick={() => undo()}/><IconButton icon={Redo2} label="重做 (Ctrl + Shift + Z)" disabled={!historyCount.future} onClick={() => undo(true)}/></div>
        <span className="divider optional"/>
        <IconButton icon={ListTree} label="显示大纲" active={outline} disabled={!doc && !outline} onClick={() => { finishEdit(); setOutline(!outline); if (!outline) setLibraryOpen(false); }}/>
        <IconButton icon={Search} label="查找节点 (Ctrl + F)" active={searchOpen} disabled={!doc} onClick={() => { finishEdit(); setSearchOpen(!searchOpen); }} className="optional"/>
        <button className="primary-button copy-button" disabled={!doc} onClick={() => void copy()} title="复制 Mermaid 代码块 (Ctrl + Shift + C)"><Copy size={15} strokeWidth={1.5}/><span>复制到 Obsidian</span><span className="compact-copy">复制</span></button>
      </div>
    </header>

    {errorMessage && <div className="app-error" role="alert"><span>{errorMessage}</span><button aria-label="关闭提示" onClick={() => clearError()}><X size={14}/></button></div>}
    <div className="workspace">
      {libraryOpen && <ResizableSidebar name="导图库" preferredWidth={libraryWidth} onWidthChange={setLibraryWidth} onResizeStart={finishEdit}>
        <LibraryPanel snapshot={library} currentPath={session.path} selectedPath={selectedLibraryPath} selectedFolder={selectedFolder} busy={busy}
        onSelectEntry={entry => selectLibraryPath(entry.path)} onClearSelection={() => selectLibraryPath('')}
        onOpen={path => { void fileAction('open', path); }} onNew={() => void fileAction('new', selectedFolder || undefined)}
        onRefresh={() => void refreshLibrary()} onClose={() => setLibraryOpen(false)} onCreateFolder={createLibraryFolder}
        onRename={renameLibraryItem} onMove={moveLibraryItem} onArrange={arrangeLibraryItem}
        onDelete={async path => { await changeLibrary(() => api!.deleteLibraryItem(path), { reloadSession: true }); }}/>
      </ResizableSidebar>}
      {outline && <ResizableSidebar name="大纲" preferredWidth={outlineWidth} onWidthChange={setOutlineWidth} onResizeStart={finishEdit}>
        <aside className="outline-panel">
        <div className="panel-heading"><span>大纲</span><IconButton icon={X} label="关闭大纲" onClick={() => setOutline(false)}/></div>
        <div className="outline-list" role="tree" aria-label="导图大纲">{visible.map(node => <div key={node.id} className={`outline-row ${node.id === selected ? 'selected' : ''}`} style={{ paddingLeft: 8 + Math.min(node.depth, 12) * 14 }}>
          {node.children.length ? <button className="outline-toggle" aria-label={`${node.collapsed ? '展开' : '折叠'} ${node.text}`} onClick={() => toggle(node.id)}>{node.collapsed ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button> : <span className="outline-dot"/>}
          <button role="treeitem" aria-selected={node.id === selected} aria-level={node.depth + 1} aria-expanded={node.children.length ? !node.collapsed : undefined} onClick={() => { finishEdit(); select(node.id); }} onDoubleClick={() => startEdit(node.id)}>{node.text || '空白节点'}</button>
        </div>)}</div>
        </aside>
      </ResizableSidebar>}

      <main ref={canvas} className={`canvas ${panning ? 'panning' : ''} ${dragId ? 'dragging' : ''}`} data-drag-node={dragId ?? undefined} aria-label="思维导图画布"
        onClickCapture={e => { if (ignoreDragClick.current) { e.preventDefault(); e.stopPropagation(); ignoreDragClick.current = false; } }}
        onContextMenu={e => { e.preventDefault(); }} onPointerDown={e => {
        if (!docRef.current) return;
        if (e.button !== 0 && e.button !== 1) return;
        if ((e.target as HTMLElement).closest('button, textarea, input, .mind-node, .popover, .search-panel, .selection-toolbar')) return;
        ignoreDragClick.current = false; finishEdit(); setSelectedImage(null); setMenu(false); setContext(null);
        pan.current = { x: e.clientX, y: e.clientY, view: { ...viewRef.current } }; setPanning(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}>
        {doc && layout && <div className="world" role="tree" aria-label="导图节点" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="connections" width={layout.width + 40} height={layout.height + 40} aria-hidden="true">
            <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="var(--node-ink)" strokeWidth="1" strokeLinejoin="round"/></marker></defs>
            {visible.flatMap(node => node.collapsed ? [] : node.children.map(id => {
              const from = layout.boxes[node.id], to = layout.boxes[id];
              const fromOffset = draggedNodes.has(node.id) ? dragOffset : { x: 0, y: 0 };
              const toOffset = draggedNodes.has(id) ? dragOffset : { x: 0, y: 0 };
              const destinationParent = id === dragId && drop ? (drop.position === 'inside' ? drop.id : parentOf(doc, drop.id)) : null;
              const previewParent = destinationParent ? layout.boxes[destinationParent] : null;
              const x1 = previewParent ? previewParent.x + previewParent.width : from.x + from.width + fromOffset.x;
              const y1 = previewParent ? previewParent.y + previewParent.height / 2 : from.y + from.height / 2 + fromOffset.y;
              const x2 = to.x - 2 + toOffset.x, y2 = to.y + to.height / 2 + toOffset.y;
              const bend = Math.max(35, (x2 - x1) * 0.54);
              return <path key={id} data-edge-to={id} data-preview-parent={destinationParent ?? undefined} opacity={draggedNodes.has(id) ? .7 : 1} strokeDasharray={id === dragId ? '4 4' : undefined} d={`M${x1} ${y1} C${x1 + bend} ${y1},${x2 - bend} ${y2},${x2} ${y2}`} fill="none" stroke="var(--node-ink)" strokeWidth="1" markerEnd="url(#arrow)"/>;
            }))}
          </svg>
          {visible.map(node => {
            const box = layout.boxes[node.id];
            const isEditing = edit?.id === node.id;
            const offset = draggedNodes.has(node.id) ? dragOffset : { x: 0, y: 0 };
            return <div key={node.id} data-node-id={node.id} role="treeitem" aria-label={node.text || '空白节点'} aria-selected={selected === node.id} aria-level={node.depth + 1} aria-expanded={node.children.length ? !node.collapsed : undefined} tabIndex={-1}
              className={`mind-node ${selected === node.id ? 'selected' : ''} ${isEditing ? 'editing' : ''} ${node.id === doc.rootId ? 'root-node' : ''} ${draggedNodes.has(node.id) ? 'drag-source' : ''} ${drop?.id === node.id ? 'drop-' + drop.position : ''}`}
              style={{ left: box.x + offset.x, top: box.y + offset.y, width: box.width, height: box.height }}
              onDoubleClick={e => { if ((e.target as HTMLElement).closest('button, .node-image, .node-resize-handle')) return; startEdit(node.id); }}
              onPointerDown={e => {
                if (e.button !== 0 || (e.target as HTMLElement).closest('textarea, button, .node-image, .node-resize-handle') || busyRef.current) return;
                beginNodeDrag(node.id, e);
              }}
              onDragStart={e => e.preventDefault()}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); finishEdit(); select(node.id, false); setMenu(false); setContext({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - 245)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 345)) }); }}>
              <div className="node-content">
              {isEditing ? <textarea ref={editor} aria-label="编辑节点" className="node-editor" spellCheck={false} maxLength={8000} value={node.text} style={{ height: Math.max(NODE_STYLE.lineHeight, box.textHeight) }} onPointerDown={e => e.stopPropagation()} onChange={e => {
                const previous = docRef.current!;
                const next = clone(previous);
                next.nodes[node.id].text = e.target.value;
                if (node.id === previous.rootId && (previous.title === '未命名导图' || previous.title === titleFromText(previous.nodes[node.id].text))) {
                  next.title = titleFromText(e.target.value);
                }
                rememberAnchor(); markChanged(next);
              }} onBlur={finishEdit} onKeyDown={e => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if ((e.key === 'Delete' || e.key === 'Backspace') && !e.currentTarget.value && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault(); e.stopPropagation();
                  if (!e.repeat && node.id !== docRef.current?.rootId) remove();
                  return;
                }
                if (e.key === 'Tab') { e.preventDefault(); add('child'); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (e.ctrlKey || e.metaKey) finishEdit(); else add('sibling'); }
                if (e.key === 'Escape') {
                  e.preventDefault(); const editing = editRef.current; editRef.current = null; setEdit(null);
                  if (editing && docRef.current) {
                    const next = clone(docRef.current); next.nodes[node.id].text = editing.base.nodes[node.id].text;
                    if (node.id === next.rootId) next.title = editing.base.title;
                    rememberAnchor(); markChanged(next);
                  }
                }
              }}/> : (box.textHeight > 0 && <span className="node-text">{box.lines.map((line, index) => <span key={index}>{line}</span>)}</span>)}
              {node.images?.map(image => <NodeImageView key={image.id} image={image} scale={view.scale} selected={selectedImage?.nodeId === node.id && selectedImage.imageId === image.id}
                onNodePointerDown={e => beginNodeDrag(node.id, e)}
                onSelect={() => { finishEdit(); select(node.id, false); setSelectedImage({ nodeId: node.id, imageId: image.id }); setContext(null); setMenu(false); }}
                onDeselect={() => { setSelectedImage(null); canvas.current?.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)?.focus({ preventScroll: true }); }} onRemove={() => removeImage(node.id, image.id)}
                onCopy={() => copyImage(node.id, image.id)} onCut={() => copyImage(node.id, image.id, true)} onPaste={() => pasteContent(node.id, [], true)}
                onResizeStart={() => beginMediaResize(node.id, image.id)} onResizePreview={size => previewMediaResize({ kind: 'image', nodeId: node.id, imageId: image.id, ...size })}
                onResizeCommit={size => commitImageSize(node.id, image.id, size)} onResizeCancel={cancelMediaResize}/>) }
              </div>
              {selected === node.id && !isEditing && <NodeResizeHandle width={box.width} minWidth={Math.max(box.depth === 0 ? NODE_STYLE.rootMinWidth : NODE_STYLE.minWidth, ...visible.filter(item => item.depth === box.depth).flatMap(item => (item.images ?? []).map(image => image.width + NODE_STYLE.insetX)))} maxWidth={NODE_STYLE.maxWidth} scale={view.scale}
                onStart={() => beginMediaResize(node.id)} onPreview={width => previewMediaResize({ kind: 'column', depth: box.depth, width })}
                onCommit={width => commitColumnWidth(node.id, box.depth, width)} onCancel={cancelMediaResize}/>}
              {!!node.children.length && !isEditing && <button className={`collapse-button ${node.collapsed ? 'collapsed' : ''}`} aria-label={`${node.collapsed ? '展开' : '折叠'}分支：${node.text}`} title={node.collapsed ? `展开 ${descendants(doc, node.id).length - 1} 个节点` : '折叠分支 (Space)'} onClick={e => { e.stopPropagation(); toggle(node.id); }}>{node.collapsed ? <span>{descendants(doc, node.id).length - 1}</span> : <Minus size={10}/>}</button>}
            </div>;
          })}
        </div>}

        {doc && searchOpen && <section className="search-panel" aria-label="查找节点">
          <div className="search-input-wrap"><Search size={16}/><input autoFocus aria-label="搜索内容" placeholder="查找你的想法…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setSearchOpen(false); if (e.key === 'Enter' && matches[0]) goToMatch(matches[0].id); }}/><IconButton icon={X} label="关闭查找" onClick={() => setSearchOpen(false)}/></div>
          {query.trim() && <div className="search-results"><div className="search-caption">{matches.length ? `${matches.length} 个匹配节点` : '没有找到匹配节点'}</div>{matches.slice(0, 60).map(node => <button key={node.id} onClick={() => goToMatch(node.id)}>{node.text}<ArrowRight size={14}/></button>)}</div>}
        </section>}

        {doc && <div className="canvas-bottom">
          <div className="zoom-controls"><IconButton icon={Minus} label="缩小" onClick={() => zoom(0.85)}/><button className="zoom-value" title="恢复 100%" onClick={() => zoom(1 / view.scale)}>{Math.round(view.scale * 100)}%</button><IconButton icon={Plus} label="放大" onClick={() => zoom(1.18)}/><span className="divider"/><IconButton icon={Maximize} label="适应画布 (Ctrl + 0)" onClick={fit}/></div>
        </div>}

        {currentNode && currentBox && <div className="selection-toolbar" onPointerDown={e => e.preventDefault()}>
          <button onClick={() => add('child')} title="添加子节点"><CornerDownRight size={15}/><span>子节点</span><kbd>Tab</kbd></button>
          <span className="divider"/>
          <button onClick={() => add('sibling')} title="添加同级节点"><Plus size={15}/><span>同级</span><kbd>Enter</kbd></button>
          <span className="divider"/>
          <IconButton icon={ChevronsUpDown} label="折叠 / 展开 (Space)" disabled={!currentNode.children.length} onClick={() => toggle()}/>
          <IconButton icon={MoreHorizontal} label="更多节点操作" onClick={() => { const rect = canvas.current!.getBoundingClientRect(); setContext({ x: Math.min(rect.left + rect.width / 2, window.innerWidth - 245), y: rect.bottom - 365 }); }}/>
        </div>}
      </main>
    </div>

    {(menu || context) && <div className="popover-dismiss" onPointerDown={() => { setMenu(false); setContext(null); }}/ >}
    {menu && <div className="popover file-menu">
      <div className="menu-label">文件</div>
      <button onClick={() => void fileAction('new')}><FilePlus2 size={16}/><span>新建导图</span><kbd>Ctrl + N</kbd></button>
      <button onClick={() => void fileAction('open')}><FolderOpen size={16}/><span>打开导图…</span><kbd>Ctrl + O</kbd></button>
      <button disabled={!doc} onClick={() => void fileAction('save-as')}><Save size={16}/><span>另存为…</span><kbd>Ctrl + Shift + S</kbd></button>
      <div className="menu-separator"/>
      <button disabled={!doc} onClick={() => void exportFile()}><Download size={16}/><span>导出为 Markdown</span></button>
      <button disabled={!doc} onClick={() => void exportPdf()}><Download size={16}/><span>导出为 PDF</span></button>
      <button onClick={() => { setMenu(false); void api?.reveal(); }}><Folder size={16}/><span>在文件夹中显示</span><ExternalLink size={12}/></button>
      <button onClick={() => { setMenu(false); finishEdit(); setHelp(true); }}><Keyboard size={16}/><span>快捷键</span></button>
    </div>}
    {context && doc && <div ref={contextElement} className="popover context-menu" style={{ left: context.x, top: context.y }}>
      <button onClick={() => { setContext(null); startEdit(); }}><MoreHorizontal size={16}/><span>编辑节点</span><kbd>F2</kbd></button>
      <button onClick={() => copyNodes()}><Copy size={16}/><span>复制节点</span><kbd>Ctrl + C</kbd></button>
      <button disabled={selected === doc.rootId} onClick={() => copyNodes(selected, true)}><Scissors size={16}/><span>剪切节点</span><kbd>Ctrl + X</kbd></button>
      <button onClick={() => pasteContent()}><ClipboardPaste size={16}/><span>粘贴</span><kbd>Ctrl + V</kbd></button>
      <button onClick={() => { setContext(null); add('child'); }}><CornerDownRight size={16}/><span>添加子节点</span><kbd>Tab</kbd></button>
      <button onClick={() => { setContext(null); add('sibling'); }}><Plus size={16}/><span>添加同级节点</span><kbd>Enter</kbd></button>
      <button disabled={!currentNode?.children.length} onClick={() => { setContext(null); toggle(); }}><ChevronsUpDown size={16}/><span>{currentNode?.collapsed ? '展开分支' : '折叠分支'}</span><kbd>Space</kbd></button>
      <div className="menu-separator"/>
      <button disabled={selected === doc.rootId} onClick={() => { apply(reorderNode(docRef.current!, selected, -1)); setContext(null); }}><ArrowUp size={16}/><span>上移</span><kbd>Alt + ↑</kbd></button>
      <button disabled={selected === doc.rootId} onClick={() => { apply(reorderNode(docRef.current!, selected, 1)); setContext(null); }}><ArrowDown size={16}/><span>下移</span><kbd>Alt + ↓</kbd></button>
      <div className="menu-separator"/>
      <button disabled={selected === doc.rootId} onClick={() => remove(true)}><Trash2 size={16}/><span>删除单个节点</span></button>
      <button disabled={selected === doc.rootId} onClick={() => remove()}><Trash2 size={16}/><span>删除节点及分支</span><kbd>Del</kbd></button>
    </div>}

    {help && <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setHelp(false); }}><section className="help-modal" role="dialog" aria-modal="true" aria-label="快捷键" onKeyDown={e => {
      if (e.key === 'Escape') setHelp(false);
      if (e.key === 'Tab') { e.preventDefault(); (e.currentTarget.querySelector('button') as HTMLButtonElement)?.focus(); }
    }}><div className="help-heading"><div><span className="eyebrow">KEEP YOUR THOUGHTS FLOWING</span><h2>让思路，跟得上手指。</h2></div><IconButton icon={X} label="关闭快捷键" onClick={() => setHelp(false)}/></div>
      <p className="help-intro">选中节点后直接操作。编辑中按 Enter 继续写同级，Ctrl + Enter 完成。</p>
      <div className="shortcut-grid">{shortcuts.map(([key, description]) => <div key={key}><span>{description}</span><kbd>{key}</kbd></div>)}</div>
      <div className="help-footer"><span>鼠标拖动节点中部可改变归属，上下边缘可调整顺序。</span><button autoFocus className="primary-button" onClick={() => setHelp(false)}>开始记录</button></div>
    </section></div>}
  </div>;
}
