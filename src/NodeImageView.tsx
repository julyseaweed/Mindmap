import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NodeImage } from './types';
import { isMediaGlobalShortcut, usePointerResize } from './NodeResizeHandle';
import './node-media.css';

interface ImageSize { width: number; height: number }
interface NodeImageViewProps {
  image: NodeImage;
  selected: boolean;
  scale: number;
  onSelect(): void;
  onNodePointerDown?(event: PointerEvent<HTMLDivElement>): void;
  onDeselect?(): void;
  onResizeStart(): void;
  onResizePreview(size: ImageSize): void;
  onResizeCommit(size: ImageSize): void;
  onResizeCancel(): void;
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
  onRemove(): void;
}

export default function NodeImageView({ image, selected, scale, onSelect, onNodePointerDown, onDeselect, onResizeStart, onResizePreview, onResizeCommit, onResizeCancel, onCopy, onCut, onPaste, onRemove }: NodeImageViewProps) {
  const element = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ratio = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : image.width / image.height;
  const maximumWidth = Math.min(1200, 12000 * ratio);
  const minimumWidth = Math.min(32, maximumWidth);
  const start = useRef({ width: image.width, scale, ratio });
  const latest = useRef<ImageSize>({ width: image.width, height: image.height });
  const imageSize = (width: number, naturalRatio = ratio): ImageSize => {
    const maximum = Math.min(1200, 12000 * naturalRatio);
    const nextWidth = Math.max(Math.min(32, maximum), Math.min(maximum, width));
    return { width: nextWidth, height: nextWidth / naturalRatio };
  };
  const { resizing, ...resizeEvents } = usePointerResize({
    cursor: 'nwse-resize',
    onStart: () => { start.current = { width: image.width, scale: Math.max(.01, scale), ratio }; latest.current = { width: image.width, height: image.height }; setMenu(null); onResizeStart(); },
    onPreviewDelta: (dx, dy) => {
      const initial = start.current;
      const delta = (dx / initial.scale + dy / initial.scale / initial.ratio) / (1 + 1 / (initial.ratio * initial.ratio));
      latest.current = imageSize(initial.width + delta, initial.ratio);
      onResizePreview(latest.current);
    },
    onCommit: () => onResizeCommit(latest.current),
    onCancel: onResizeCancel,
  });

  useEffect(() => { if (menu) menuElement.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menu]);
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const bounds = menuElement.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8));
    if (x !== menu.x || y !== menu.y) setMenu({ x, y });
  }, [menu]);
  useEffect(() => { if (!selected) setMenu(null); }, [selected]);
  const dismiss = () => { setMenu(null); element.current?.focus({ preventScroll: true }); };
  const perform = (action: () => void) => {
    const imageElement = element.current;
    const node = imageElement?.closest<HTMLElement>('[data-node-id]');
    dismiss();
    action();
    requestAnimationFrame(() => {
      if (!imageElement?.isConnected && node?.isConnected && document.activeElement === document.body) node.focus({ preventScroll: true });
    });
  };
  const remove = () => perform(onRemove);

  return <>
    <div ref={element} className={`node-image ${selected ? 'is-selected' : ''}`} data-image-id={image.id} tabIndex={0} role="group" aria-label="节点图片" style={{ width: image.width, height: image.height }}
      onPointerDown={event => { event.stopPropagation(); onNodePointerDown?.(event); }} onClick={event => { event.stopPropagation(); onSelect(); event.currentTarget.focus({ preventScroll: true }); }} onFocus={event => { if (event.target === event.currentTarget) onSelect(); }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        if (resizing) return;
        onSelect();
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenu({ x: Math.max(8, Math.min(event.clientX || bounds.right, window.innerWidth - 204)), y: Math.max(8, Math.min(event.clientY || bounds.bottom, window.innerHeight - 164)) });
      }} onKeyDown={event => {
        if (isMediaGlobalShortcut(event)) return;
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || resizing) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
        else if (event.key === 'Escape') { event.preventDefault(); setMenu(null); onDeselect?.(); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); }
      }}>
      <img src={image.dataUrl} alt="节点图片" draggable={false}/>
      {selected && <div className={`node-image-resizer ${resizing ? 'is-resizing' : ''}`} role="slider" tabIndex={0} aria-label="调整图片尺寸" aria-valuemin={minimumWidth} aria-valuemax={maximumWidth} aria-valuenow={image.width} aria-valuetext={`${Math.round(image.width)} × ${Math.round(image.height)}`} {...resizeEvents}
        onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (isMediaGlobalShortcut(event)) return;
          const step = event.shiftKey ? 50 : 10;
          const next = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? image.width - step : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? image.width + step : null;
          if (next === null || resizing) return;
          event.preventDefault(); event.stopPropagation(); onResizeStart(); onResizeCommit(imageSize(next));
        }}/ >}
    </div>
    {menu && createPortal(<div className="node-image-menu-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) { event.preventDefault(); dismiss(); } }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); dismiss(); }}>
      <div ref={menuElement} className="node-image-menu" role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
        if (isMediaGlobalShortcut(event)) { dismiss(); return; }
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismiss(); }
        else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const buttons = Array.from(menuElement.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const index = buttons.findIndex(button => button === document.activeElement);
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
        <button type="button" role="menuitem" aria-label="复制图片" aria-keyshortcuts="Control+C Meta+C" onClick={() => perform(onCopy)}><span>复制图片</span><kbd>Ctrl+C</kbd></button>
        <button type="button" role="menuitem" aria-label="剪切图片" aria-keyshortcuts="Control+X Meta+X" onClick={() => perform(onCut)}><span>剪切图片</span><kbd>Ctrl+X</kbd></button>
        <button type="button" role="menuitem" aria-label="粘贴图片" aria-keyshortcuts="Control+V Meta+V" onClick={() => perform(onPaste)}><span>粘贴图片</span><kbd>Ctrl+V</kbd></button>
        <button type="button" role="menuitem" aria-label="删除图片" aria-keyshortcuts="Delete" onClick={remove}><span>删除图片</span><kbd>Delete</kbd></button>
      </div>
    </div>, document.body)}
  </>;
}
