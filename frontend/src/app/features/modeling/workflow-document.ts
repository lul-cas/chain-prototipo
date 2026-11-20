import { WorkflowDocument } from '../../diagram/workflow-document';

// The document model lives in diagram/ (ADR-0010 D9), shared by the editor and the request page (workflow-editor.md §9).
export type { Box, FlowLayout, NodeType, TaskKind, WorkflowDocument, WorkflowFlow, WorkflowLane, WorkflowNode } from '../../diagram/workflow-document';
export { readDocument } from '../../diagram/workflow-document';

export interface ProcessSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly latestVersion: number | null;
  readonly draftUpdatedAt: string;
}

/** A process with its draft, and the `ETag` that guards the next change of it. */
export interface ProcessDraft extends ProcessSummary {
  readonly draft: WorkflowDocument;
  readonly etag: string;
}

/** A problem the server found in a draft, and the element it is about, when there is one. */
export interface DraftProblem {
  readonly code: string;
  readonly message: string;
  readonly elementId: string | null;
}

/** What the editor needs of a draft that may be empty or partial: lists default to empty. */
