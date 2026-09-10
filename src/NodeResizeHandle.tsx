import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import './node-media.css';

const globalShortcutKeys = new Set(['z', 'y', 's', 'n', 'o', 'f', '0', '+', '=', '-', 'c', 'x', 'v']);
export const isMediaGlobalShortcut = (event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'key'>) => (event.ctrlKey || event.metaKey) && globalShortcutKeys.has(event.key.toLowerCase());

interface PointerResizeOptions {
  cursor: string;
  onStart(): void;
  onPreviewDelta(dx: number, dy: number): void;
  onCommit(): void;
  onCancel(): void;
}

interface PointerGesture {
  id: number;
  element: HTMLDivElement;
  x: number;
  y: number;
  cursor: string;
  userSelect: string;
}

export function usePointerResize(options: PointerResizeOptions) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const gesture = useRef<PointerGesture | null>(null);
  const [resizing, setResizing] = useState(false);

  const release = useCallback(() => {
    const active = gesture.current;
    if (!active) return false;
    gesture.current = null;
    document.documentElement.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    return true;
  }, []);

  const cancel = useCallback(() => {
    if (!release()) return;
    setResizing(false);
    callbacks.current.onCancel();
  }, [release]);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      if (release()) callbacks.current.onCancel();
    };
  }, [cancel, release]);

  return {
    resizing,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      event.preventDefault();
      cancel();
      gesture.current = { id: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect };
      document.documentElement.style.cursor = callbacks.current.cursor;
      document.body.style.userSelect = 'none';
      setResizing(true);
      callbacks.current.onStart();
      event.currentTarget.focus({ preventScroll: true });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const active = gesture.current;
      if (!active || active.id !== event.pointerId) return;
      event.preventDefault();
      callbacks.current.onPreviewDelta(event.clientX - active.x, event.clientY - active.y);
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (gesture.current?.id !== event.pointerId) return;
      event.preventDefault();
      release(); setResizing(false); callbacks.current.onCommit();
    },
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (gesture.current?.id === event.pointerId) cancel();
    },
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (gesture.current?.id === event.pointerId) cancel();
    },
  };
}

interface NodeResizeHandleProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  scale: number;
  onStart(): void;
  onPreview(width: number): void;
  onCommit(width: number): void;
  onCancel(): void;
}

export default function NodeResizeHandle({ width, minWidth, maxWidth, scale, onStart, onPreview, onCommit, onCancel }: NodeResizeHandleProps) {
  const start = useRef({ width, scale });
  const latest = useRef(width);
  const clamp = (value: number) => Math.round(Math.max(minWidth, Math.min(maxWidth, value)));
  const { resizing, ...resizeEvents } = usePointerResize({
    cursor: 'col-resize',
    onStart: () => { start.current = { width, scale: Math.max(.01, scale) }; latest.current = width; onStart(); },
    onPreviewDelta: dx => { latest.current = clamp(start.current.width + dx / start.current.scale); onPreview(latest.current); },
    onCommit: () => onCommit(latest.current),
    onCancel,
  });

  return <div className={`node-resize-handle ${resizing ? 'is-resizing' : ''}`} role="separator" tabIndex={0} aria-label="调整节点列宽" aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width}
    {...resizeEvents} onClick={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      if (isMediaGlobalShortcut(event)) return;
      event.stopPropagation();
      if (resizing) return;
      const step = event.shiftKey ? 50 : 10;
      const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : null;
      if (next === null) return;
      event.preventDefault(); onStart(); onCommit(clamp(next));
    }}/>
}
