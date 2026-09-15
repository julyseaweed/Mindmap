import type { MindRelationship } from './types';
import type { Box } from './core.mjs';
export interface Point { x: number; y: number }
export interface RelationshipControls { control1: Point; control2: Point }
export interface RelationshipBounds { x: number; y: number; width: number; height: number }
export interface RelationshipRoutingContext {
  nodes?: Record<string, { children: string[]; collapsed?: boolean }>;
  relationships?: MindRelationship[];
}
export interface RelationshipGeometry extends RelationshipControls {
  path: string; start: Point; end: Point; c1: Point; c2: Point;
  label: RelationshipBounds & { lines: string[] };
  bounds: RelationshipBounds;
}
export function relationshipGeometry(relationship: MindRelationship, boxes: Record<string, Box>, measure?: (text: string) => number, context?: RelationshipRoutingContext): RelationshipGeometry | null;
export function relationshipBounds(layout: { boxes: Record<string, Box>; width: number; height: number }, relationships: MindRelationship[], measure?: (text: string) => number, context?: RelationshipRoutingContext): RelationshipBounds;
