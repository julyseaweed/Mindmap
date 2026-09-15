import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Box } from './core.mjs';
import type { MindRelationship } from './types';
import { relationshipGeometry } from './relationships.mjs';
import type { RelationshipControls, RelationshipRoutingContext } from './relationships.mjs';
import './relationships.css';

interface RelationshipLayerProps {
  relationships: MindRelationship[];
  context?: RelationshipRoutingContext;
  boxes: Record<string, Box>;
  measure(text: string): number;
  selectedId: string | null;
  editingId: string | null;
  scale: number;
  disabled?: boolean;
  onSelect(id: string): void;
  onEdit(id: string): void;
  onTextChange(id: string, text: string): void;
  onFinishEdit(): void;
  onCancelEdit(): void;
  onGestureStart(id: string): void;
  onGestureCommit(id: string, controls: RelationshipControls): void;
  onGestureCancel(): void;
  onRemove(id: string): void;
}

interface Gesture {
  id: string;
  pointerId: number;
  target: SVGElement;
  x: number;
  y: number;
  scale: number;
  mode: '1' | '2' | 'both';
  initial: RelationshipControls;
  latest: RelationshipControls;
  started: boolean;
  cursor: string;
  userSelect: string;
}

export default function RelationshipLayer(props: RelationshipLayerProps) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const markerId = `relationship-arrow-${useId().replaceAll(':', '')}`;
  const gesture = useRef<Gesture | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [preview, setPreview] = useState<{ id: string; controls: RelationshipControls } | null>(null);

  const release = useCallback(() => {
    const active = gesture.current;
    if (!active) return null;
    gesture.current = null;
    document.documentElement.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    return active;
  }, []);

  const cancel = useCallback(() => {
    const active = release();
    if (!active) return;
    setPreview(null);
    if (active.started) callbacks.current.onGestureCancel();
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
      const active = release();
      if (active?.started) callbacks.current.onGestureCancel();
    };
  }, [cancel, release]);

  useEffect(() => {
    const active = gesture.current;
    if (active && (props.disabled || props.selectedId !== active.id || !props.relationships.some(relationship => relationship.id === active.id))) cancel();
  }, [props.disabled, props.selectedId, props.relationships, cancel]);

  useEffect(() => {
    composing.current = false;
    if (!props.editingId || !editor.current) return;
    editor.current.focus({ preventScroll: true });
    editor.current.setSelectionRange(editor.current.value.length, editor.current.value.length);
  }, [props.editingId]);

  const begin = (event: PointerEvent<SVGElement>, relationship: MindRelationship, mode: Gesture['mode']) => {
    event.stopPropagation();
    if (event.button !== 0 || callbacks.current.disabled) return;
    if (callbacks.current.editingId) callbacks.current.onFinishEdit();
    event.preventDefault(); cancel();
    const geometry = relationshipGeometry(relationship, callbacks.current.boxes, callbacks.current.measure, callbacks.current.context);
    if (!geometry) return;
    const controls = { control1: { ...geometry.control1 }, control2: { ...geometry.control2 } };
    gesture.current = {
      id: relationship.id, pointerId: event.pointerId, target: event.currentTarget,
      x: event.clientX, y: event.clientY, scale: Math.max(.01, callbacks.current.scale), mode,
      initial: controls, latest: controls, started: false,
      cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect,
    };
    callbacks.current.onSelect(relationship.id);
    event.currentTarget.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
  };

  const pointerEvents = {
    onPointerMove: (event: PointerEvent<SVGElement>) => {
      event.stopPropagation();
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      if (!active.started) {
        if (Math.hypot(dx, dy) < 3) return;
        active.started = true;
        document.documentElement.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        callbacks.current.onGestureStart(active.id);
      }
      event.preventDefault();
      // Keep generated controls within the persisted document's coordinate limit.
      const bounded = (value: number) => Math.max(-100000, Math.min(100000, value));
      const translate = (point: { x: number; y: number }) => ({ x: bounded(point.x + dx / active.scale), y: bounded(point.y + dy / active.scale) });
      active.latest = {
        control1: active.mode === '2' ? active.initial.control1 : translate(active.initial.control1),
        control2: active.mode === '1' ? active.initial.control2 : translate(active.initial.control2),
      };
      setPreview({ id: active.id, controls: active.latest });
    },
    onPointerUp: (event: PointerEvent<SVGElement>) => {
      event.stopPropagation();
      if (gesture.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      const active = release();
      setPreview(null);
      if (active?.started) callbacks.current.onGestureCommit(active.id, active.latest);
    },
    onPointerCancel: (event: PointerEvent<SVGElement>) => { event.stopPropagation(); if (gesture.current?.pointerId === event.pointerId) cancel(); },
    onLostPointerCapture: (event: PointerEvent<SVGElement>) => { if (gesture.current?.pointerId === event.pointerId) cancel(); },
  };

  const geometries = props.relationships.flatMap(relationship => {
    const geometry = relationshipGeometry(preview?.id === relationship.id ? { ...relationship, ...preview.controls } : relationship, props.boxes, props.measure, props.context);
    return geometry ? [{ relationship, geometry }] : [];
  });

  return <div className={`relationship-layer${props.disabled ? ' is-disabled' : ''}`}>
    <svg className="relationships" width="1" height="1" aria-label="节点联系">
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path className="relationship-arrow" d="M 1 1 L 9 5 L 1 9" fill="none"/>
      </marker></defs>
      {geometries.map(({ relationship, geometry }) => {
        const selected = relationship.id === props.selectedId;
        return <g key={relationship.id} data-relationship-id={relationship.id} className={selected ? 'is-selected' : undefined}>
          <path className="relationship-line" d={geometry.path} markerEnd={`url(#${markerId})`}/>
          <path className="relationship-hit" d={geometry.path} role="button" aria-label={relationship.text ? `联系：${relationship.text}` : '节点联系'} tabIndex={props.disabled ? -1 : 0}
            onPointerDown={event => begin(event, relationship, 'both')} {...pointerEvents}
            onClick={event => event.stopPropagation()}
            onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (!props.disabled) props.onEdit(relationship.id); }}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
            onKeyDown={event => {
              if (props.disabled || event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); props.onEdit(relationship.id); }
              if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); props.onRemove(relationship.id); }
            }}/>
        </g>;
      })}
    </svg>
    {!props.editingId && !props.disabled && <svg className="relationships relationship-controls" width="1" height="1" data-relationship-control="true" aria-label="联系控制点">
      {geometries.filter(({ relationship }) => relationship.id === props.selectedId).map(({ relationship, geometry }) => <g key={relationship.id} data-relationship-id={relationship.id}>
        <path className="relationship-guide" d={`M ${geometry.start.x} ${geometry.start.y} L ${geometry.c1.x} ${geometry.c1.y} M ${geometry.end.x} ${geometry.end.y} L ${geometry.c2.x} ${geometry.c2.y}`}/>
        {(['1', '2'] as const).map(control => {
          const point = control === '1' ? geometry.c1 : geometry.c2;
          return <circle key={control} className="relationship-handle" data-control={control} cx={point.x} cy={point.y} r={4.5 / Math.max(.5, props.scale)} tabIndex={-1}
            onPointerDown={event => begin(event, relationship, control)} {...pointerEvents}
            onClick={event => event.stopPropagation()} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}/>;
        })}
      </g>)}
    </svg>}
    {geometries.map(({ relationship, geometry }) => {
      const editing = props.editingId === relationship.id;
      if (!relationship.text && !editing) return null;
      return <div key={relationship.id} data-relationship-id={relationship.id} className={`relationship-label${editing ? ' is-editing' : ''}`} style={{ left: geometry.label.x, top: geometry.label.y, width: geometry.label.width, height: geometry.label.height }}
        onPointerDown={event => { event.stopPropagation(); if (!props.disabled && !editing) props.onSelect(relationship.id); }}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => { event.stopPropagation(); if (!props.disabled && !editing) props.onEdit(relationship.id); }}>
        {editing ? <textarea ref={editor} className="relationship-editor" aria-label="编辑联系文字" spellCheck={false} maxLength={8000} readOnly={props.disabled} value={relationship.text}
          onChange={event => props.onTextChange(relationship.id, event.target.value)}
          onBlur={() => { if (callbacks.current.editingId === relationship.id) callbacks.current.onFinishEdit(); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && ['s', 'n', 'o'].includes(event.key.toLowerCase())) return;
            event.stopPropagation();
            if (props.disabled) return;
            if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onFinishEdit(); }
            if (event.key === 'Escape') { event.preventDefault(); props.onCancelEdit(); }
          }}/>
          : <span className="relationship-label-text">{geometry.label.lines.map((line, index) => <span key={index}>{line || '\u00a0'}</span>)}</span>}
      </div>;
    })}
  </div>;
}
