import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LibrarySnapshot, LibraryEntry } from './types';
import './library.css';

interface LibraryPanelProps {
  snapshot: LibrarySnapshot | null;
  currentPath: string;
  selectedPath: string;
  selectedFolder: string;
  busy: boolean;
  onSelectEntry(entry: LibraryEntry): void;
  onClearSelection(): void;
  onOpen(path: string): void;
  onNew(): void;
  onRefresh(): void;
  onClose(): void;
  onCreateFolder(name: string, parentPath: string): Promise<void>;
  onRename(path: string, name: string): Promise<void>;
  onMove(path: string, targetFolder: string): Promise<void>;
  onArrange(sourcePath: string, targetPath: string, position: 'before' | 'after' | 'inside'): Promise<void>;
  onDelete(path: string): Promise<void>;
}

type LibraryDialog = { kind: 'create'; parentPath: string } | { kind: 'rename' | 'move'; entry: LibraryEntry };
type FolderOption = { path: string; label: string };
type LibraryDrop = { path: string; position: 'before' | 'after' | 'inside' };
const pathKey = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase();
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
const withinPath = (child: string, parent: string) => samePath(child, parent) || pathKey(child).startsWith(pathKey(parent) + '/');

function ActionButton({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled: boolean; onClick(): void }) {
  return <button type="button" className="library-icon-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon size={16} strokeWidth={1.5}/></button>;
}

export default function LibraryPanel({ snapshot, currentPath, selectedPath, selectedFolder, busy, onSelectEntry, onClearSelection, onOpen, onNew, onRefresh, onClose, onCreateFolder, onRename, onMove, onArrange, onDelete }: LibraryPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ entry: LibraryEntry; top: number; left: number } | null>(null);
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dragPath, setDragPath] = useState('');
  const [dropTarget, setDropTarget] = useState<LibraryDrop | null>(null);
  const dragSource = useRef<LibraryEntry | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollVelocity = useRef(0);
  const ignoreClickUntil = useRef(0);
  const modal = useRef<HTMLFormElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const autoExpandedFor = useRef('');
  const titleId = useId();
  const fieldId = useId();
  const errorId = useId();
  const locked = busy || submitting;
  const folderOptions = useMemo(() => {
    if (!snapshot) return [];
    const all: FolderOption[] = [{ path: snapshot.root, label: '顶层' }];
    const walk = (entries: LibraryEntry[], prefix: string) => {
      for (const entry of entries) if (entry.kind === 'folder') {
        const label = prefix ? `${prefix} / ${entry.name}` : entry.name;
        all.push({ path: entry.path, label });
        walk(entry.children ?? [], label);
      }
    };
    walk(snapshot.entries, '');
    return all;
  }, [snapshot]);
  const destinations = useMemo(() => folderOptions.filter(option => dialog?.kind !== 'move' || dialog.entry.kind !== 'folder' || !withinPath(option.path, dialog.entry.path)), [folderOptions, dialog]);

  const stopScrolling = useCallback(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    scrollVelocity.current = 0;
  }, []);

  const clearDrag = useCallback(() => {
    if (dragSource.current) ignoreClickUntil.current = Date.now() + 250;
    dragSource.current = null;
    setDragPath('');
    setDropTarget(null);
    stopScrolling();
  }, [stopScrolling]);

  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && dragSource.current) {
        event.preventDefault(); event.stopPropagation(); clearDrag();
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => { window.removeEventListener('keydown', cancel, true); stopScrolling(); };
  }, [clearDrag, stopScrolling]);

  useEffect(() => { if (locked) clearDrag(); }, [locked, clearDrag]);

  const autoScroll = (clientY: number) => {
    const container = scroll.current;
    if (!container || !dragSource.current) return;
    const bounds = container.getBoundingClientRect();
    const edge = 38;
    scrollVelocity.current = clientY < bounds.top + edge ? -Math.min(10, (bounds.top + edge - clientY) / 4)
      : clientY > bounds.bottom - edge ? Math.min(10, (clientY - bounds.bottom + edge) / 4) : 0;
    if (!scrollVelocity.current) { stopScrolling(); return; }
    if (scrollFrame.current !== null) return;
    const step = () => {
      if (!dragSource.current || !scroll.current || !scrollVelocity.current) { stopScrolling(); return; }
      scroll.current.scrollTop += scrollVelocity.current;
      scrollFrame.current = requestAnimationFrame(step);
    };
    scrollFrame.current = requestAnimationFrame(step);
  };

  const rowDrop = (event: DragEvent<HTMLDivElement>, entry: LibraryEntry): LibraryDrop => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / bounds.height;
    return { path: entry.path, position: entry.kind === 'folder' && ratio >= .25 && ratio <= .75 ? 'inside' : ratio < .5 ? 'before' : 'after' };
  };

  const validDrop = (source: LibraryEntry, target: LibraryDrop) => !samePath(source.path, target.path) && !(source.kind === 'folder' && withinPath(target.path, source.path));

  const dragOver = (event: DragEvent<HTMLDivElement>, target: LibraryDrop) => {
    event.stopPropagation();
    const source = dragSource.current;
    if (!source || locked) return;
    autoScroll(event.clientY);
    if (!validDrop(source, target)) { event.dataTransfer.dropEffect = 'none'; setDropTarget(null); return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(previous => previous?.path === target.path && previous.position === target.position ? previous : target);
  };

  const remapExpanded = (sourcePath: string, targetPath: string) => {
    const source = pathKey(sourcePath), target = pathKey(targetPath);
    setExpanded(previous => new Set([...previous].map(folder => folder === source || folder.startsWith(source + '/') ? target + folder.slice(source.length) : folder)));
  };

  const dropEntry = async (event: DragEvent<HTMLDivElement>, target: LibraryDrop) => {
    event.preventDefault(); event.stopPropagation();
    const source = dragSource.current;
    clearDrag();
    if (!source || locked || !validDrop(source, target)) return;
    setSubmitting(true);
    try {
      await onArrange(source.path, target.path, target.position);
      if (source.kind === 'folder') {
        const parent = target.position === 'inside' ? target.path : target.path.replaceAll('\\', '/').replace(/\/[^/]+$/, '');
        remapExpanded(source.path, `${parent}/${source.name}`);
      }
    } catch { /* The app displays the storage error while preserving the source file. */ }
    finally { setSubmitting(false); }
  };

  useEffect(() => {
    if (!snapshot) return;
    const target = JSON.stringify([pathKey(snapshot.root), pathKey(selectedPath)]);
    if (autoExpandedFor.current === target) return;
    autoExpandedFor.current = target;
    // Reveal only the selection's ancestors; the selected folder keeps its own toggle state.
    setExpanded(previous => {
      const next = new Set(previous);
      for (const option of folderOptions) if (!samePath(selectedPath, option.path) && withinPath(selectedPath, option.path)) next.add(pathKey(option.path));
      return next;
    });
  }, [snapshot?.root, selectedPath, folderOptions]);

  useEffect(() => {
    if (dialog?.kind === 'move') select.current?.focus();
    else if (dialog) {
      input.current?.focus();
      const value = input.current?.value ?? '';
      input.current?.setSelectionRange(0, dialog.kind === 'rename' && dialog.entry.kind === 'map' ? value.replace(/\.mindmap$/i, '').length : value.length);
    }
  }, [dialog]);

  useEffect(() => { menuElement.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menu]);

  const dismiss = () => {
    if (locked) return;
    setMenu(null);
    setDialog(null);
    setError('');
    returnFocus.current?.focus();
  };

  const showDialog = (next: LibraryDialog) => {
    if (locked) return;
    if (!menu) returnFocus.current = document.activeElement as HTMLElement | null;
    setMenu(null);
    setDialog(next);
    setError('');
    setName(next.kind === 'rename' ? next.entry.name : '');
    const options = folderOptions.filter(option => next.kind !== 'move' || next.entry.kind !== 'folder' || !withinPath(option.path, next.entry.path));
    setDestination(options.find(option => samePath(option.path, selectedFolder))?.path ?? options[0]?.path ?? '');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || locked || (dialog.kind === 'move' ? !destination : !name.trim())) return;
    setSubmitting(true);
    setError('');
    try {
      if (dialog.kind === 'create') await onCreateFolder(name.trim(), dialog.parentPath);
      else if (dialog.kind === 'rename') await onRename(dialog.entry.path, name.trim());
      else await onMove(dialog.entry.path, destination);
      if (dialog.kind !== 'create' && dialog.entry.kind === 'folder') {
        const target = dialog.kind === 'move'
          ? `${destination}/${dialog.entry.name}`
          : `${dialog.entry.path.replaceAll('\\', '/').replace(/\/[^/]+$/, '')}/${name.trim()}`;
        remapExpanded(dialog.entry.path, target);
      }
      setDialog(null);
      returnFocus.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败，请重试。');
    } finally { setSubmitting(false); }
  };

  const deleteEntry = async (entry: LibraryEntry) => {
    if (locked) return;
    setMenu(null);
    setSubmitting(true);
    try { await onDelete(entry.path); }
    catch { /* The app displays the storage error without dismissing the active map. */ }
    finally { setSubmitting(false); }
  };

  const modalKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
    if (event.key === 'Tab') {
      const controls = Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? []);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };

  const renderEntries = (entries: LibraryEntry[], depth: number): ReactNode => entries.map(entry => {
    const folder = entry.kind === 'folder';
    const open = expanded.has(pathKey(entry.path));
    const selected = samePath(entry.path, selectedPath);
    const current = !folder && samePath(entry.path, currentPath);
    const label = folder ? entry.name : entry.title || entry.name.replace(/\.mindmap$/i, '');
    const Icon = folder ? open ? FolderOpen : Folder : FileText;
    return <li className={`library-item ${dropTarget?.path === entry.path && dropTarget.position === 'after' ? 'has-drop-after' : ''}`} key={entry.path}>
      <div className={`library-row ${selected ? 'is-selected' : ''} ${current ? 'is-current' : ''} ${samePath(dragPath, entry.path) ? 'is-dragging' : ''}`} data-library-path={entry.path} data-drop-position={dropTarget?.path === entry.path ? dropTarget.position : undefined} draggable={!locked} style={{ paddingLeft: 8 + Math.min(depth, 12) * 14 }} onDragStart={event => {
        if (locked || (event.target as Element).closest('.library-more')) { event.preventDefault(); return; }
        event.stopPropagation();
        dragSource.current = entry;
        setDragPath(entry.path);
        setMenu(null);
        onSelectEntry(entry);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-mindmap-library', entry.path);
      }} onDragOver={event => dragOver(event, rowDrop(event, entry))} onDrop={event => { void dropEntry(event, rowDrop(event, entry)); }} onDragEnd={clearDrag} onClickCapture={event => {
        if (Date.now() < ignoreClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
      }} onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        if (locked) return;
        onSelectEntry(entry);
        returnFocus.current = event.currentTarget.querySelector<HTMLButtonElement>('.library-entry');
        setMenu({ entry, top: Math.max(8, Math.min(event.clientY, window.innerHeight - 126)), left: Math.max(8, Math.min(event.clientX, window.innerWidth - 140)) });
      }}>
        <button type="button" className="library-entry" title={entry.name} aria-current={current ? 'page' : undefined} aria-expanded={folder ? open : undefined} disabled={locked || (!folder && entry.invalid)} onClick={() => {
          onSelectEntry(entry);
          setMenu(null);
          if (folder) {
            setExpanded(previous => { const next = new Set(previous); if (next.has(pathKey(entry.path))) next.delete(pathKey(entry.path)); else next.add(pathKey(entry.path)); return next; });
          } else onOpen(entry.path);
        }}>
          {folder ? open ? <ChevronDown size={12}/> : <ChevronRight size={12}/> : <span className="library-chevron-space"/>}
          <Icon size={15} strokeWidth={1.5}/><span>{label}</span>
        </button>
        <button type="button" className="library-icon-button library-more" title={`更多操作：${label}`} aria-label={`更多操作：${label}`} aria-haspopup="menu" aria-expanded={menu?.entry.path === entry.path} disabled={locked} onClick={event => {
          onSelectEntry(entry);
          const rect = event.currentTarget.getBoundingClientRect();
          returnFocus.current = event.currentTarget;
          setMenu(menu?.entry.path === entry.path ? null : { entry, top: Math.min(rect.bottom + 4, window.innerHeight - 126), left: Math.max(8, Math.min(rect.right - 132, window.innerWidth - 140)) });
        }}><MoreHorizontal size={15} strokeWidth={1.5}/></button>
      </div>
      {folder && open && <ul className="library-children">{renderEntries(entry.children ?? [], depth + 1)}</ul>}
    </li>;
  });

  return <aside className="library-panel" aria-label="导图库" onKeyDown={event => {
    const fileShortcut = (event.ctrlKey || event.metaKey) && ['n', 'o', 's'].includes(event.key.toLowerCase());
    if (!fileShortcut) event.stopPropagation();
  }}>
    <header className="library-header"><span>导图库</span><div className="library-actions">
      <ActionButton icon={FilePlus2} label="新建导图" disabled={locked || !snapshot} onClick={onNew}/>
      <ActionButton icon={FolderPlus} label="新建文件夹" disabled={locked || !snapshot} onClick={() => { if (snapshot) showDialog({ kind: 'create', parentPath: selectedFolder || snapshot.root }); }}/>
      <ActionButton icon={RefreshCw} label="刷新导图库" disabled={locked} onClick={onRefresh}/>
      <ActionButton icon={X} label="关闭导图库" disabled={locked} onClick={onClose}/>
    </div></header>
    <div ref={scroll} className="library-scroll" data-drop-position={snapshot && dropTarget?.path === snapshot.root ? 'inside' : undefined} onDragOver={event => {
      if (snapshot && !(event.target as Element).closest('.library-row')) dragOver(event, { path: snapshot.root, position: 'inside' });
    }} onDrop={event => {
      if (snapshot && !(event.target as Element).closest('.library-row')) void dropEntry(event, { path: snapshot.root, position: 'inside' });
    }} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropTarget(null); stopScrolling(); }
    }} onClick={event => {
      if (locked || Date.now() < ignoreClickUntil.current || (event.target as Element).closest('.library-row')) return;
      setMenu(null);
      onClearSelection();
    }}>
      {snapshot && <>
        <ul className="library-tree" aria-label="导图文件">{renderEntries(snapshot.entries, 0)}</ul>
        {!snapshot.entries.length && <p className="library-empty">暂无导图</p>}
      </>}
    </div>
    {menu && createPortal(<div className="library-menu-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismiss(); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(menuElement.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = buttons.findIndex(button => button === document.activeElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      if (event.key === 'Tab') { event.preventDefault(); dismiss(); }
    }}><div ref={menuElement} className="library-row-menu" role="menu" aria-label={`${menu.entry.name}操作`} style={{ top: menu.top, left: menu.left }}>
      <button type="button" role="menuitem" disabled={locked} onClick={() => showDialog({ kind: 'rename', entry: menu.entry })}>重命名</button>
      <button type="button" role="menuitem" disabled={locked} onClick={() => showDialog({ kind: 'move', entry: menu.entry })}>移动到…</button>
      <button type="button" role="menuitem" disabled={locked} title="移入回收站" onClick={() => void deleteEntry(menu.entry)}>删除</button>
    </div></div>, document.body)}
    {dialog && createPortal(<div className="library-dialog-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismiss(); }} onKeyDown={modalKeyDown}>
      <form ref={modal} className="library-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={locked} onSubmit={submit}>
        <div className="library-dialog-heading"><h2 id={titleId}>{dialog.kind === 'create' ? '新建文件夹' : dialog.kind === 'rename' ? '重命名' : '移动到'}</h2><ActionButton icon={X} label="关闭" disabled={locked} onClick={dismiss}/></div>
        {dialog.kind === 'move' ? <div className="library-field"><label htmlFor={fieldId}>文件夹</label><select id={fieldId} ref={select} value={destination} disabled={locked} onChange={event => setDestination(event.target.value)} aria-describedby={error ? errorId : undefined}>{destinations.map(option => <option key={option.path} value={option.path}>{option.label}</option>)}</select></div>
          : <div className="library-field"><label htmlFor={fieldId}>{dialog.kind === 'rename' && dialog.entry.kind === 'map' ? '文件名' : '文件夹名称'}</label><input id={fieldId} ref={input} value={name} onChange={event => setName(event.target.value)} disabled={locked} required maxLength={200} autoComplete="off" spellCheck={false} aria-describedby={error ? errorId : undefined}/></div>}
        {error && <p className="library-form-error" id={errorId} role="alert">{error}</p>}
        <div className="library-dialog-actions"><button type="button" className="library-cancel" disabled={locked} onClick={dismiss}>取消</button><button type="submit" className="library-confirm" disabled={locked || (dialog.kind === 'move' ? !destination : !name.trim())}>{submitting ? '处理中…' : dialog.kind === 'create' ? '创建' : dialog.kind === 'rename' ? '保存' : '移动'}</button></div>
      </form>
    </div>, document.body)}
  </aside>;
}
