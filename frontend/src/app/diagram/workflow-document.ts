/**
 * The workflow document of workflow-definition.md §1 (`schemaVersion: 1`), as the editor reads it. Fields the editor does not
 * know are kept as they are, so a saved draft never loses them.
 */

/** Where an element sits on the canvas, in canvas units (workflow-definition.md §1, "Layout"). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How a flow is routed: horizontal first (`HV`) or vertical first (`VH`), with the bend's position. */
export interface FlowLayout {
  readonly mode?: 'HV' | 'VH';
  readonly bendX?: number;
  readonly bendY?: number;
}

export type NodeType = 'start' | 'task' | 'gateway' | 'end';
export type TaskKind = 'human' | 'automation' | 'subprocess';

export interface WorkflowLane {
  readonly id: string;
  readonly title: string;
  readonly group?: { readonly kind: 'requesters' } | { readonly kind: 'group'; readonly groupId: string };
  readonly layout?: Box;
  readonly [field: string]: unknown;
}

export interface WorkflowNode {
  readonly id: string;
  readonly type: NodeType;
  readonly label: string;
  readonly laneId?: string;
  readonly taskKind?: TaskKind;
  readonly decisionMode?: 'human' | 'automatic';
  readonly layout?: Box;
  readonly [field: string]: unknown;
}

export interface WorkflowFlow {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly branch?: 'true' | 'false';
  readonly layout?: FlowLayout;
  readonly [field: string]: unknown;
}

export interface WorkflowDocument {
  readonly schemaVersion: number;
  readonly lanes: readonly WorkflowLane[];
  readonly nodes: readonly WorkflowNode[];
  readonly flows: readonly WorkflowFlow[];
  readonly [field: string]: unknown;
}

/** A process as the list shows it (workflow-definition.md §5.5). */
export function readDocument(value: unknown): WorkflowDocument {
  const document = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const list = <T>(field: string): T[] => (Array.isArray(document[field]) ? (document[field] as T[]) : []);
  return {
    ...document,
    schemaVersion: typeof document['schemaVersion'] === 'number' ? document['schemaVersion'] : 1,
    lanes: list<WorkflowLane>('lanes'),
    nodes: list<WorkflowNode>('nodes'),
    flows: list<WorkflowFlow>('flows'),
  };
}
