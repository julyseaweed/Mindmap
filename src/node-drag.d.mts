import type { Box } from './core.mjs';
import type { MindDocument } from './types';

export interface NodeDrop { id: string; position: 'inside' | 'before' | 'after' }
export function resolveNodeDrop(doc: MindDocument, boxes: Record<string, Box>, sourceId: string, point: { x: number; y: number }): NodeDrop | null;
