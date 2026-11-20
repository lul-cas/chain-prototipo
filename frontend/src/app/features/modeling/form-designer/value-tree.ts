import { DesignerComponent, DesignerDocument, dataPathOf } from './form-edits';
import { pathsIn } from './value-types';

export { FUNCTIONS, inferType, pathsIn, type FunctionSpec } from './value-types';

/**
 * The labels of the computed fields a computed field reads that come after it (§12.6). Computed fields run in document order,
 * so it would read them before they are computed (forms.md F2).
 */
export function laterComputedReads(document: DesignerDocument, id: string): string[] {
  const order = inOrder(document.components);
  const index = order.findIndex((component) => component.id === id);
  const reads = new Set(pathsIn(order[index]?.expression).map((path) => path.join('.')));
  return order
    .slice(index + 1)
    .filter((component) => component.type === 'computed' && reads.has(dataPathOf(document, component.id)!.join('.')))
    .map((component) => component.label ?? component.key ?? 'calculado');
}

function inOrder(components: readonly DesignerComponent[]): DesignerComponent[] {
  return components.flatMap((component) => [component, ...inOrder(component.components ?? [])]);
}

/**
 * The sensitive keys a computed field reads while its own top-level key isn't sensitive (ADR-0016 §6 rule 2): a workflow
 * that pins the form can't publish it (WF209). A key is sensitive when its top-level field is marked (sensitive-data.md §1).
 */
export function unmarkedSensitiveReads(document: DesignerDocument, id: string): string[] {
  const sensitive = new Set(document.components.flatMap((component) => (component.sensitive && component.key ? [component.key] : [])));
  const path = dataPathOf(document, id);
  const component = inOrder(document.components).find((candidate) => candidate.id === id);
  if (!path || component?.type !== 'computed' || sensitive.has(path[0])) {
    return [];
  }
  return [...new Set(pathsIn(component.expression).flatMap((read) => (sensitive.has(read[0]) ? [read[0]] : [])))];
}
