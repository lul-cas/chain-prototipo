import { ComponentType, FormComponent, FormDocument } from '../../../forms/model';
import { CatalogEntry } from '../editor/conditions';
import { inferType } from './value-types';

const SOURCE = 'Este formulário';

/** The types form components give their values (workflow-definition.md §6.1); files and display components give none here. */
const TYPES: Readonly<Partial<Record<ComponentType, string>>> = {
  text: 'text',
  textarea: 'text',
  select: 'text',
  radio: 'text',
  number: 'number',
  checkbox: 'boolean',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  checklist: 'list<text>',
  group: 'object',
  dynamicList: 'list<object>',
  computed: 'unknown',
};

/**
 * The data a condition of this form can read (form-designer.md §12.5): its own fields, typed as the workflow catalog types
 * them, with a group's fields under it and a list's row fields under `[]`. A computed field has its expression's type (§12.6).
 * A field is `definite` when it is required.
 */
export function catalogOf(document: FormDocument): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const walk = (components: readonly FormComponent[], prefix: readonly string[]) => {
    for (const component of components) {
      const type = component.type === 'computed' ? inferType(component.expression) : TYPES[component.type];
      if (component.key === undefined || type === undefined) {
        continue;
      }
      const path = [...prefix, component.key];
      entries.push({ path, type, presence: component.validate?.required ? 'definite' : 'optional', sources: [SOURCE] });
      if (component.components) {
        walk(component.components, component.type === 'dynamicList' ? [...path, '[]'] : path);
      }
    }
  };
  walk(document.components, []);
  return entries;
}

/**
 * A condition or value tree with every path that starts with `from` starting with `to` instead (§8.2): a key rename carried
 * into the form's conditions and computed fields. The same tree comes back when nothing changes.
 */
export function renamePaths(tree: unknown, from: readonly string[], to: readonly string[]): unknown {
  if (Array.isArray(tree)) {
    const items = tree.map((item) => renamePaths(item, from, to));
    return items.some((item, i) => item !== tree[i]) ? items : tree;
  }
  if (typeof tree !== 'object' || tree === null) {
    return tree;
  }
  const node = tree as Record<string, unknown>;
  if (node['kind'] === 'path' && Array.isArray(node['path']) && startsWith(node['path'] as string[], from)) {
    return { ...node, path: [...to, ...(node['path'] as string[]).slice(from.length)] };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node)) {
    next[name] = renamePaths(value, from, to);
    changed ||= next[name] !== value;
  }
  return changed ? next : tree;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);
}
