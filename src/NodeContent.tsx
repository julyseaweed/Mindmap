import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { Box } from './core.mjs';
import { NODE_STYLE } from './core.mjs';
import type { MindNode, NodeImage } from './types';

interface NodeContentProps {
  node: MindNode;
  box: Box;
  editingSegment: number | null;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange(segment: number, text: string): void;
  onFinishEdit(): void;
  onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, segment: number): void;
  renderImage(image: NodeImage, index: number): ReactNode;
}

// The left side of a picture edits the text before it; the right side edits the text after it.
export function textSegmentAtPoint(node: HTMLElement, clientX: number, clientY: number) {
  let segment = 0;
  for (const block of node.querySelectorAll<HTMLElement>('.node-content > [data-content-kind]')) {
    const bounds = block.getBoundingClientRect();
    const index = Number(block.dataset.textSegment ?? block.dataset.imageSegment);
    if (bounds.height <= 0) continue;
    if (clientY < bounds.top) return index;
    segment = block.dataset.contentKind === 'image' ? index + 1 : index;
    if (clientY <= bounds.bottom) {
      const picture = block.querySelector<HTMLElement>('.node-image');
      if (picture && clientX < picture.getBoundingClientRect().left) return index;
      return segment;
    }
  }
  return segment;
}

export default function NodeContent({ node, box, editingSegment, editorRef, onTextChange, onFinishEdit, onEditorKeyDown, renderImage }: NodeContentProps) {
  let hasContent = false;
  return <div className="node-content">{box.content.map(block => {
    const marginTop = block.height > 0 && hasContent ? NODE_STYLE.contentGap : 0;
    if (block.height > 0) hasContent = true;
    if (block.kind === 'image') {
      const index = node.images!.findIndex(image => image.id === block.id);
      return <div key={block.id} className="node-image-block" data-content-kind="image" data-image-segment={index} style={{ height: block.height, marginTop }}>
        {renderImage(node.images![index], index)}
      </div>;
    }
    if (editingSegment === block.index) return <textarea key={`text-${block.index}`} ref={editorRef} aria-label="编辑节点" className="node-editor" data-content-kind="text" data-text-segment={block.index}
      spellCheck={false} maxLength={8000} value={block.text} style={{ height: Math.max(NODE_STYLE.lineHeight, block.height), marginTop }}
      onPointerDown={event => event.stopPropagation()} onChange={event => onTextChange(block.index, event.target.value)} onBlur={onFinishEdit}
      onKeyDown={event => onEditorKeyDown(event, block.index)}/>;
    return <span key={`text-${block.index}`} className="node-text" data-content-kind="text" data-text-segment={block.index} style={{ height: block.height, marginTop }}>
      {block.lines.map((line, index) => <span key={index}>{line}</span>)}
    </span>;
  })}</div>;
}
