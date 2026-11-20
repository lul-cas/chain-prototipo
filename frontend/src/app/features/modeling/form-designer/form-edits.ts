import { ComponentType, FieldOption, FormComponent, FormDocument } from '../../../forms/model';
import { MAX_COMPONENTS, MAX_DEPTH, count, depth } from './form-checks';
import { renamePaths } from './form-catalog';
import { keyFromLabel, uniqueKey } from './form-keys';

/**
 * A component as the designer edits it (form-designer.md §4.4): the saved component, plus an id that lives in memory only,
 * since FM000 refuses unknown properties. `toDocument` drops both designer properties.
 */
export interface DesignerComponent extends Omit<FormComponent, 'components'> {
  readonly id: string;
  /** True for a new field until its key is edited: its key then follows its label (§8.2). */
  readonly keyFollowsLabel?: boolean;
  /** For each option of a choice field, whether its value still follows its label: new options, until edited (§8.1). */
  readonly optionValuesFollow?: readonly boolean[];
  readonly components?: readonly DesignerComponent[];
}

export interface DesignerDocument {
  readonly schemaVersion: number;
  readonly components: readonly DesignerComponent[];
}

/** Where a component goes: a group's or list's id, or null for the form, and its index there once it is in place. */
export interface Place {
  readonly parent: string | null;
  readonly index: number;
}

/** Where a component is: its container, its index and siblings there, and how many groups and lists hold it. */
export interface Location {
  readonly component: DesignerComponent;
  readonly parent: string | null;
  readonly index: number;
  readonly siblings: readonly DesignerComponent[];
  readonly depth: number;
}

/** What a property change may set; `undefined` removes the property. A container's children change through moves. */
export type ComponentChange = { readonly [K in Exclude<keyof FormComponent, 'components'>]?: FormComponent[K] | undefined } & {
  readonly optionValuesFollow?: readonly boolean[] | undefined;
};

/** The palette's types (§6): a time or a datetime is a date with another subtype. */
export type PaletteType = Exclude<ComponentType, 'time' | 'datetime'>;

const DISPLAY = new Set<ComponentType>(['heading', 'paragraph', 'separator']);
const CONTAINERS = new Set<ComponentType>(['group', 'dynamicList']);
const TWO_OPTIONS: readonly FieldOption[] = [
  { value: 'opcao_1', label: 'Opção 1' },
  { value: 'opcao_2', label: 'Opção 2' },
];

/** What each palette entry starts with (§6). Fields take a key from their label; groups and lists start empty (FM004). */
const DEFAULTS: Readonly<Record<PaletteType, Omit<DesignerComponent, 'id' | 'type' | 'key' | 'keyFollowsLabel'>>> = {
  text: { label: 'Campo de texto' },
  textarea: { label: 'Área de texto' },
  number: { label: 'Número' },
  date: { label: 'Data' },
  computed: { label: 'Campo calculado' },
  file: { label: 'Seletor de arquivo' },
  checkbox: { label: 'Caixa de seleção' },
  checklist: { label: 'Grupo de caixas de seleção', options: TWO_OPTIONS },
  radio: { label: 'Grupo de opções', options: TWO_OPTIONS },
  select: { label: 'Selecionar', options: TWO_OPTIONS },
  heading: { text: 'Título' },
  paragraph: { text: 'Novo parágrafo' },
  separator: {},
  group: { label: 'Grupo', components: [] },
  dynamicList: { label: 'Lista dinâmica', components: [] },
};

/** The saved draft with an id for each component, in document order. */
export function fromDocument(document: FormDocument, newId: () => string): DesignerDocument {
  const convert = (components: readonly FormComponent[]): DesignerComponent[] =>
    components.map(({ components: children, ...component }) => {
      const id = newId();
      return children ? { ...component, id, components: convert(children) } : { ...component, id };
    });
  return { schemaVersion: document.schemaVersion, components: convert(document.components) };
}

/** The document to save: the designer's properties dropped. */
export function toDocument(document: DesignerDocument): FormDocument {
  return { schemaVersion: document.schemaVersion, components: document.components.map(toComponent) };
}

export function locate(document: DesignerDocument, id: string): Location | null {
  const walk = (components: readonly DesignerComponent[], parent: string | null, level: number): Location | null => {
    for (const [index, component] of components.entries()) {
      if (component.id === id) {
        return { component, parent, index, siblings: components, depth: level };
      }
      const found = component.components ? walk(component.components, component.id, level + 1) : null;
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(document.components, null, 0);
}

/** The path a problem names a component by (forms.md F1): its key path, or `components[i]` for a component without a key. */
export function pathOf(document: DesignerDocument, id: string): string | null {
  const walk = (components: readonly DesignerComponent[], prefix: string | null): string | null => {
    for (const [index, component] of components.entries()) {
      const own = component.key ?? `components[${index}]`;
      const path = prefix === null ? own : `${prefix}.${own}`;
      const found = component.id === id ? path : component.components ? walk(component.components, path) : null;
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return walk(document.components, null);
}

/** A new component of a palette type, with a key not used among its siblings (FM002). */
export function created(type: PaletteType, siblings: readonly DesignerComponent[], id: string): DesignerComponent {
  const defaults = DEFAULTS[type];
  if (DISPLAY.has(type)) {
    return { type, ...defaults, id };
  }
  const key = uniqueKey(keyFromLabel(defaults.label ?? ''), keysOf(siblings));
  const follows = defaults.options ? { optionValuesFollow: defaults.options.map(() => true) } : {};
  return { type, key, ...defaults, id, keyFollowsLabel: true, ...follows };
}

/** Where an addition goes (§7.3): inside a selected group or list, at its end; after the selection; or at the form's end. */
export function placeToAdd(document: DesignerDocument, selected: string | null): Place {
  const at = selected === null ? null : locate(document, selected);
  if (!at) {
    return { parent: null, index: document.components.length };
  }
  if (CONTAINERS.has(at.component.type)) {
    return { parent: at.component.id, index: at.component.components?.length ?? 0 };
  }
  return { parent: at.parent, index: at.index + 1 };
}

export function insert(document: DesignerDocument, component: DesignerComponent, place: Place): DesignerDocument {
  return withChildren(document, place.parent, (children) => {
    const index = Math.min(Math.max(place.index, 0), children.length);
    return [...children.slice(0, index), component, ...children.slice(index)];
  });
}

/** Removes a component with its children. */
export function remove(document: DesignerDocument, id: string): DesignerDocument {
  const at = locate(document, id);
  return at ? withChildren(document, at.parent, (children) => children.filter((component) => component.id !== id)) : document;
}

/** Moves a component to a place, given as it will be once the component has left its old one. A group can't enter itself. */
export function move(document: DesignerDocument, id: string, place: Place): DesignerDocument {
  const at = locate(document, id);
  if (!at || (place.parent !== null && (place.parent === id || holds(at.component, place.parent)))) {
    return document;
  }
  return insert(remove(document, id), at.component, place);
}

/** Alt+↑ (§7.2): past the previous sibling, or out of the group or list, just before it. Null at the top of the form. */
export function stepUp(document: DesignerDocument, id: string): Place | null {
  const at = locate(document, id);
  if (!at || (at.index === 0 && at.parent === null)) {
    return null;
  }
  if (at.index > 0) {
    return { parent: at.parent, index: at.index - 1 };
  }
  const container = locate(document, at.parent!)!;
  return { parent: container.parent, index: container.index };
}

/** Alt+↓ (§7.2): past the next sibling, or out of the group or list, just after it. Null at the end of the form. */
export function stepDown(document: DesignerDocument, id: string): Place | null {
  const at = locate(document, id);
  const last = at ? at.index === at.siblings.length - 1 : true;
  if (!at || (last && at.parent === null)) {
    return null;
  }
  if (!last) {
    return { parent: at.parent, index: at.index + 1 };
  }
  const container = locate(document, at.parent!)!;
  return { parent: container.parent, index: container.index + 1 };
}

/**
 * Changes a component's properties. A new field's key follows its label, unique among its siblings, until the key itself is
 * changed (§8.2). A component that was loaded keeps its key.
 */
export function changed(document: DesignerDocument, id: string, change: ComponentChange): DesignerDocument {
  const at = locate(document, id);
  if (!at) {
    return document;
  }
  const next: Record<string, unknown> = { ...at.component, ...change };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) {
      delete next[name];
    }
  }
  if ('key' in change) {
    next['keyFollowsLabel'] = false;
  } else if (change.label !== undefined && at.component.keyFollowsLabel) {
    next['key'] = uniqueKey(keyFromLabel(change.label), keysOf(at.siblings.filter((sibling) => sibling.id !== id)));
  }
  const updated = next as unknown as DesignerComponent;
  const result = withChildren(document, at.parent, (children) => children.map((component) => (component.id === id ? updated : component)));
  const from = at.component.key;
  const to = updated.key;
  if (from === undefined || to === undefined || from === to) {
    return result;
  }
  const prefix = dataPathOf(document, id)!.slice(0, -1);
  return withTrees(result, (tree) => renamePaths(tree, [...prefix, from], [...prefix, to]));
}

/** A field's path in the data its form's conditions read (form-designer.md §12.5): its keys, with `[]` for a list's rows. */
export function dataPathOf(document: DesignerDocument, id: string): string[] | null {
  const walk = (components: readonly DesignerComponent[], prefix: readonly string[]): string[] | null => {
    for (const component of components) {
      const path = [...prefix, component.key ?? ''];
      if (component.id === id) {
        return path;
      }
      const found = component.components ? walk(component.components, component.type === 'dynamicList' ? [...path, '[]'] : path) : null;
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(document.components, []);
}

/** Every component's conditions and expression passed through a change; components that keep theirs stay as they were. */
function withTrees(document: DesignerDocument, change: (tree: unknown) => unknown): DesignerDocument {
  const walk = (components: readonly DesignerComponent[]): readonly DesignerComponent[] => {
    let touched = false;
    const next = components.map((component) => {
      let updated: DesignerComponent = component;
      for (const name of ['visibleWhen', 'requiredWhen', 'expression'] as const) {
        if (component[name] !== undefined) {
          const tree = change(component[name]);
          if (tree !== component[name]) {
            updated = { ...updated, [name]: tree };
          }
        }
      }
      const children = component.components ? walk(component.components) : undefined;
      if (children && children !== component.components) {
        updated = { ...updated, components: children };
      }
      touched ||= updated !== component;
      return updated;
    });
    return touched ? next : components;
  };
  const components = walk(document.components);
  return components === document.components ? document : { ...document, components };
}

/** Why the document breaks a limit of §7.5 (FM006), or null. The editor refuses an addition or a move that would. */
export function limitRefusal(document: DesignerDocument): string | null {
  if (count(document.components) > MAX_COMPONENTS) {
    return `O formulário já tem ${MAX_COMPONENTS} componentes.`;
  }
  if (depth(document.components) > MAX_DEPTH) {
    return `Grupos e listas aninham até ${MAX_DEPTH} níveis.`;
  }
  return null;
}

/** Changes the children of a container (null for the form), keeping every other part of the tree as it was. */
function withChildren(
  document: DesignerDocument,
  parent: string | null,
  change: (children: readonly DesignerComponent[]) => readonly DesignerComponent[],
): DesignerDocument {
  if (parent === null) {
    return { ...document, components: change(document.components) };
  }
  const walk = (components: readonly DesignerComponent[]): readonly DesignerComponent[] => {
    let touched = false;
    const next = components.map((component) => {
      if (component.id === parent) {
        touched = true;
        return { ...component, components: change(component.components ?? []) };
      }
      const children = component.components ? walk(component.components) : undefined;
      if (children && children !== component.components) {
        touched = true;
        return { ...component, components: children };
      }
      return component;
    });
    return touched ? next : components;
  };
  const components = walk(document.components);
  return components === document.components ? document : { ...document, components };
}

function holds(component: DesignerComponent, id: string): boolean {
  return (component.components ?? []).some((child) => child.id === id || holds(child, id));
}

function keysOf(components: readonly DesignerComponent[]): Set<string> {
  return new Set(components.flatMap((component) => (component.key === undefined ? [] : [component.key])));
}

function toComponent(component: DesignerComponent): FormComponent {
  const saved: Record<string, unknown> = { ...component };
  delete saved['id'];
  delete saved['keyFollowsLabel'];
  delete saved['optionValuesFollow'];
  if (component.components) {
    saved['components'] = component.components.map(toComponent);
  }
  return saved as unknown as FormComponent;
}
