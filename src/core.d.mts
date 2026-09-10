import type { MindDocument, MindNode } from './types';
export const NODE_STYLE: Readonly<{
  fontSize: number; lineHeight: number; borderWidth: number; paddingX: number; paddingY: number;
  contentGap: number; minWidth: number; rootMinWidth: number; maxAutoWidth: number; maxWidth: number;
  insetX: number; insetY: number;
}>;
export function clone<T>(value: T): T;
export function uid(): string;
export function createDocument(title?: string): MindDocument;
export function welcomeDocument(): MindDocument;
export function validateDocument(value: unknown): MindDocument;
export function parentOf(doc: MindDocument, id: string): string | null;
export function descendants(doc: MindDocument, id: string): string[];
export function copyBranch(doc: MindDocument, id: string): MindDocument;
export function pasteBranch(doc: MindDocument, targetId: string, branch: MindDocument): { doc: MindDocument; selectedId: string };
export function addNode(doc: MindDocument, selectedId: string, kind?: 'child' | 'sibling', text?: string): { doc: MindDocument; selectedId: string };
export function deleteNode(doc: MindDocument, id: string): { doc: MindDocument; selectedId: string };
export function deleteNodeOnly(doc: MindDocument, id: string): { doc: MindDocument; selectedId: string };
export function moveNode(doc: MindDocument, id: string, targetId: string, position?: 'inside' | 'before' | 'after'): MindDocument;
export function reorderNode(doc: MindDocument, id: string, direction: number): MindDocument;
export function visibleNodes(doc: MindDocument): (MindNode & { depth: number })[];
export function escapeMermaid(text: string): string;
export function toMermaid(doc: MindDocument, fenced?: boolean): string;
export interface Box { id: string; depth: number; width: number; height: number; textHeight: number; lines: string[]; images?: { id: string; width: number; height: number }[]; span: number; x: number; y: number }
export function layoutTree(doc: MindDocument, measure?: (text: string) => number): { boxes: Record<string, Box>; width: number; height: number };
