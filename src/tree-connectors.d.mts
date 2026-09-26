interface Point { x: number; y: number }
export function treeConnector(start: Point, end: Point, rootBranch?: boolean): {
  path: string;
  curves: { start: Point; c1: Point; c2: Point; end: Point }[];
};
