import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import './sidebar.css';

interface ResizableSidebarProps {
  children: ReactNode;
  name: string;
  preferredWidth: number;
  onWidthChange(width: number): void;
  onResizeStart?(): void;
}

type ResizeGesture = { pointerId: number; startX: number; startWidth: number; width: number; cursor: string; userSelect: string };
const minimumWidth = 200;
const defaultWidth = 248;
const clamp = (width: number, maximum: number) => Math.round(Math.max(minimumWidth, Math.min(maximum, width)));

export default function ResizableSidebar({ children, name, preferredWidth, onWidthChange, onResizeStart }: ResizableSidebarProps) {
  const panel = useRef<HTMLDivElement>(null);
  const separator = useRef<HTMLDivElement>(null);
  const gesture = useRef<ResizeGesture | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const maximum = Math.max(minimumWidth, Math.min(600, workspaceWidth - 320));
  const width = clamp(draft ?? preferredWidth, maximum);

  const releaseGesture = useCallback(() => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    document.documentElement.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
    const handle = separator.current;
    if (handle?.hasPointerCapture(active.pointerId)) handle.releasePointerCapture(active.pointerId);
    return active;
  }, []);

  const cancelResize = useCallback(() => {
    releaseGesture();
    setDraft(null);
  }, [releaseGesture]);

  useLayoutEffect(() => {
    const workspace = panel.current?.parentElement;
    const measure = () => setWorkspaceWidth(workspace?.getBoundingClientRect().width ?? window.innerWidth);
    measure();
    const observer = new ResizeObserver(measure);
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      event.preventDefault(); event.stopPropagation(); cancelResize();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancelResize);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancelResize);
      releaseGesture();
    };
  }, [cancelResize, releaseGesture]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    onResizeStart?.();
    releaseGesture();
    gesture.current = {
      pointerId: event.pointerId, startX: event.clientX, startWidth: width, width,
      cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect,
    };
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDraft(width);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    active.width = clamp(active.startWidth + event.clientX - active.startX, maximum);
    setDraft(active.width);
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const active = releaseGesture();
    if (active && active.width !== active.startWidth) onWidthChange(clamp(active.width, maximum));
    setDraft(null);
  };

  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? minimumWidth : event.key === 'End' ? maximum : null;
    if (next === null) return;
    event.preventDefault();
    onResizeStart?.();
    cancelResize();
    onWidthChange(clamp(next, maximum));
  };

  return <div ref={panel} className={`resizable-sidebar ${draft === null ? '' : 'is-resizing'}`} style={{ width }}>
    {children}
    <div ref={separator} className="sidebar-resizer" role="separator" tabIndex={0} aria-label={`调整${name}宽度`} aria-orientation="vertical" aria-valuemin={minimumWidth} aria-valuemax={Math.round(maximum)} aria-valuenow={width}
      onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize}
      onPointerCancel={event => { event.stopPropagation(); if (gesture.current?.pointerId === event.pointerId) cancelResize(); }}
      onLostPointerCapture={event => { event.stopPropagation(); if (gesture.current?.pointerId === event.pointerId) cancelResize(); }}
      onKeyDown={keyResize} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onResizeStart?.(); cancelResize(); onWidthChange(defaultWidth); }}/>
  </div>;
}
