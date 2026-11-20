import { WorkflowDocument, WorkflowNode } from './workflow-document';

/** What the canvas draws a node as: its type, and for a task its variant (workflow-editor.md §3, §9). */
export type Kind = 'start' | 'task' | 'automatic' | 'subworkflow' | 'gateway' | 'end';

/** The pt-BR names of the node kinds, which start each element's accessible name (§10.1). */
export const KIND_LABEL: Readonly<Record<Kind, string>> = {
  start: 'Início',
  task: 'Etapa',
  automatic: 'Etapa automática',
  subworkflow: 'Subprocesso',
  gateway: 'Condicional',
  end: 'Fim',
};

export function kindOf(node: WorkflowNode): Kind {
  if (node.type === 'task') {
    return node.taskKind === 'automation' ? 'automatic' : node.taskKind === 'subprocess' ? 'subworkflow' : 'task';
  }
  return node.type;
}

/** A node's label, or a placeholder when it has none yet. */
export function labelOf(node: WorkflowNode): string {
  return node.label || '(sem rótulo)';
}

/** What the status line says is selected (§10.2): one element by its label and kind, or how many. */
export function describeSelection(document: WorkflowDocument, ids: ReadonlySet<string>): string {
  if (ids.size === 0) {
    return '';
  }
  if (ids.size > 1) {
    return `${ids.size} elementos selecionados`;
  }
  const [id] = ids;
  const node = document.nodes.find((candidate) => candidate.id === id);
  if (node) {
    return `Selecionado: ${labelOf(node)} (${KIND_LABEL[kindOf(node)]})`;
  }
  const lane = document.lanes.find((candidate) => candidate.id === id);
  if (lane) {
    return `Selecionado: ${lane.title} (Área)`;
  }
  const flow = document.flows.find((candidate) => candidate.id === id);
  if (flow) {
    const label = (end: string) => {
      const node = document.nodes.find((candidate) => candidate.id === end);
      return node ? labelOf(node) : end;
    };
    return `Selecionado: fluxo de ${label(flow.source)} para ${label(flow.target)}`;
  }
  return '';
}
