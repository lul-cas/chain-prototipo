import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  forwardRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { render, toRows, valueText } from '../editor/conditions';
import { FormDraftEditor, nameOf } from './form-draft-editor';
import { DesignerComponent, DesignerDocument, locate } from './form-edits';
import { TYPE_NAME } from './form-palette';

/** Fields typed into or picked from draw an inert box, with the placeholder, as the form shows them (§7.1). */
const CONTROLS = new Set(['text', 'textarea', 'number', 'select', 'date', 'time', 'datetime', 'file', 'computed']);
const CONTAINERS = new Set(['group', 'dynamicList']);

/**
 * The form column (form-designer.md §7.1, §7.2): the draft as a tree of inert cards that look like the form. It is one tab
 * stop; the arrows, Home and End move the focus in document order, into and out of groups and lists, and the selection
 * follows it. Alt and the arrows move the selection, Delete removes it, Ctrl or ⌘+Z undoes, Esc clears the selection, and
 * Enter or a double click asks for its properties. The keyboard is built here, not with `@angular/aria`'s tree, because the
 * designer moves the focus from code, after an addition or a move (§4.4).
 */
@Component({
  selector: 'chain-form-tree',
  imports: [forwardRef(() => FormTreeItem)],
  template: `
    @if (document().components.length > 0) {
      <ul class="chain-form-tree" role="tree" aria-label="Formulário" tabindex="-1" (keydown)="keydown($event)">
        @for (component of document().components; track component.id; let i = $index) {
          <li
            chainFormTreeItem
            [component]="component"
            [path]="childPath(null, component, i)"
            [level]="1"
            [posinset]="i + 1"
            [setsize]="document().components.length"
          ></li>
        }
      </ul>
    } @else {
      <p class="chain-form-tree__empty">O formulário está vazio. Adicione um componente pela paleta.</p>
    }
  `,
  styleUrl: './form-tree.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormTree {
  protected readonly editor = inject(FormDraftEditor);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The paths of the components with a problem (forms.md F1). */
  readonly problems = input<ReadonlySet<string>>(new Set());
  /** Enter or a double click on a component: its id, for the properties panel (§5). */
  readonly properties = output<string>();

  protected readonly document = this.editor.document;
  private readonly lastFocused = signal<string | null>(null);
  /** The one tab stop: the selection, else the component focused last, else the first. */
  readonly tabStop = computed(() => {
    const ids = inOrder(this.document()).map((component) => component.id);
    return [this.editor.selection(), this.lastFocused()].find((id) => id !== null && ids.includes(id)) ?? ids[0] ?? null;
  });

  /** Moves the focus to a component once it is drawn: after an addition, a move, or when its problem is chosen. */
  focus(id: string): void {
    this.lastFocused.set(id);
    afterNextRender(() => this.element(id)?.focus(), { injector: this.injector });
  }

  /** A click selects a component and focuses it. */
  choose(id: string): void {
    this.editor.select(id);
    this.go(id);
  }

  childPath(parentPath: string | null, component: DesignerComponent, index: number): string {
    const own = component.key ?? `components[${index}]`;
    return parentPath === null ? own : `${parentPath}.${own}`;
  }

  protected keydown(event: KeyboardEvent): void {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset['id'];
    const at = id === undefined ? null : locate(this.document(), id);
    if (!at) {
      return;
    }
    const order = inOrder(this.document());
    const index = order.findIndex((component) => component.id === at.component.id);
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      this.editor.select(at.component.id);
      if (key === 'ArrowUp') {
        this.editor.moveUp();
      } else {
        this.editor.moveDown();
      }
      this.focus(at.component.id);
    } else if (command && key === 'z') {
      if (event.shiftKey) {
        this.editor.redo();
      } else {
        this.editor.undo();
      }
      this.refocus();
    } else if (command && key === 'y') {
      this.editor.redo();
      this.refocus();
    } else if (command || event.altKey) {
      return;
    } else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      const target = { ArrowDown: order[index + 1], ArrowUp: order[index - 1], Home: order[0], End: order[order.length - 1] }[key];
      if (target) {
        this.choose(target.id);
      }
    } else if (key === 'ArrowRight') {
      const first = at.component.components?.[0];
      if (first) {
        this.choose(first.id);
      }
    } else if (key === 'ArrowLeft') {
      if (at.parent !== null) {
        this.choose(at.parent);
      }
    } else if (key === 'Delete' || key === 'Backspace') {
      this.editor.select(at.component.id);
      this.editor.remove();
      this.refocus();
    } else if (key === 'Escape') {
      this.editor.select(null);
    } else if (key === 'Enter') {
      this.properties.emit(at.component.id);
    } else {
      return;
    }
    event.preventDefault();
  }

  private go(id: string): void {
    this.lastFocused.set(id);
    this.element(id)?.focus();
  }

  /** After an undo, a redo or a removal: the focus goes to the selection, else to the tab stop. */
  private refocus(): void {
    const id = this.editor.selection() ?? this.tabStop();
    if (id !== null) {
      this.focus(id);
    }
  }

  private element(id: string): HTMLElement | undefined {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role="treeitem"]')).find((item) => item.dataset['id'] === id);
  }
}

/** One component of the tree: an inert card, and for a group or list, its children (§7.1). */
@Component({
  selector: 'li[chainFormTreeItem]',
  imports: [forwardRef(() => FormTreeItem)],
  host: {
    role: 'treeitem',
    class: 'chain-tree-item',
    '[attr.aria-level]': 'level()',
    '[attr.aria-posinset]': 'posinset()',
    '[attr.aria-setsize]': 'setsize()',
    '[attr.aria-selected]': 'selected()',
    '[attr.aria-expanded]': 'container() ? true : null',
    '[attr.aria-label]': 'name()',
    '[attr.data-id]': 'component().id',
    '[attr.data-path]': 'path()',
    '[tabIndex]': 'tree.tabStop() === component().id ? 0 : -1',
    '(click)': 'click($event)',
    '(dblclick)': 'doubleClick($event)',
  },
  template: `
    @let c = component();
    <div class="chain-draft-card" [class.chain-draft-card--problem]="problem()">
      @switch (c.type) {
        @case ('heading') {
          <p class="chain-draft-card__heading">{{ c.text }}</p>
        }
        @case ('paragraph') {
          <p class="chain-draft-card__text">{{ c.text }}</p>
        }
        @case ('separator') {
          <hr class="chain-draft-card__separator" />
        }
        @default {
          <div class="chain-draft-card__head">
            <span class="chain-draft-card__label">{{ c.label || '(sem rótulo)' }}</span>
            @if (c.validate?.required) {
              <span class="chain-draft-card__required">obrigatório</span>
            }
          </div>
          @if (control()) {
            <div class="chain-draft-card__control" [class.chain-draft-card__control--tall]="c.type === 'textarea'">{{ c.placeholder }}</div>
          }
          @if (c.options?.length) {
            <ul class="chain-draft-card__options" [class.chain-draft-card__options--many]="c.type === 'checklist'">
              @for (option of c.options; track $index) {
                <li>{{ option.label }}</li>
              }
            </ul>
          }
          <div class="chain-draft-card__meta">
            <span>{{ typeName() }}</span>
            @if (c.key) {
              <code class="chain-draft-card__key">{{ c.key }}</code>
            }
            @for (badge of badges(); track badge) {
              <span class="chain-draft-card__badge">{{ badge }}</span>
            }
          </div>
          @if (condition(); as text) {
            <p class="chain-draft-card__condition">Mostra quando: {{ text }}</p>
          }
          @if (expression(); as text) {
            <p class="chain-draft-card__condition">Calcula: {{ text }}</p>
          }
        }
      }
    </div>
    @if (container()) {
      <ul class="chain-draft-card__children" role="group">
        @for (child of c.components ?? []; track child.id; let i = $index) {
          <li
            chainFormTreeItem
            [component]="child"
            [path]="tree.childPath(path(), child, i)"
            [level]="level() + 1"
            [posinset]="i + 1"
            [setsize]="c.components!.length"
          ></li>
        } @empty {
          <li class="chain-draft-card__empty" role="none">Adicione componentes aqui</li>
        }
      </ul>
    }
  `,
  styleUrl: './form-tree.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormTreeItem {
  protected readonly tree = inject(FormTree);
  private readonly editor = inject(FormDraftEditor);

  readonly component = input.required<DesignerComponent>();
  /** The path problems use for this component (forms.md F1): a key path, or `components[i]`. */
  readonly path = input.required<string>();
  readonly level = input.required<number>();
  readonly posinset = input.required<number>();
  readonly setsize = input.required<number>();

  protected readonly selected = computed(() => this.editor.selection() === this.component().id);
  protected readonly container = computed(() => CONTAINERS.has(this.component().type));
  protected readonly control = computed(() => CONTROLS.has(this.component().type));
  protected readonly problem = computed(() => this.tree.problems().has(this.path()));
  protected readonly typeName = computed(() => (Object.hasOwn(TYPE_NAME, this.component().type) ? TYPE_NAME[this.component().type] : this.component().type));
  protected readonly badges = computed(() => {
    const c = this.component();
    return [
      c.visibleWhen !== undefined ? 'condicional' : null,
      c.requiredWhen !== undefined ? 'obrigatório quando…' : null,
      c.readOnly ? 'somente leitura' : null,
      c.type === 'computed' ? 'calculado' : null,
      c.sensitive ? 'sensível' : null,
    ].filter((badge): badge is string => badge !== null);
  });
  protected readonly condition = computed(() => (this.component().visibleWhen !== undefined ? render(toRows(this.component().visibleWhen)) : null));
  protected readonly expression = computed(() => (this.component().type === 'computed' && this.component().expression !== undefined ? valueText(this.component().expression) : null));
  /** The tree item's name: what it is, its key, and whether it is required or has a problem. Its card is a drawing. */
  protected readonly name = computed(() => {
    const c = this.component();
    return [
      nameOf(c),
      this.typeName().toLocaleLowerCase('pt-BR'),
      c.key ? `chave ${c.key}` : null,
      c.validate?.required ? 'obrigatório' : null,
      this.problem() ? 'com problema' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
  });

  protected click(event: MouseEvent): void {
    event.stopPropagation();
    this.tree.choose(this.component().id);
  }

  protected doubleClick(event: MouseEvent): void {
    event.stopPropagation();
    this.tree.properties.emit(this.component().id);
  }
}

/** Every component in document order: the order of the arrows. */
function inOrder(document: DesignerDocument): DesignerComponent[] {
  const walk = (components: readonly DesignerComponent[]): DesignerComponent[] =>
    components.flatMap((component) => [component, ...walk(component.components ?? [])]);
  return walk(document.components);
}
