import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { nameOf } from './form-draft-editor';
import { DesignerComponent, DesignerDocument, Place, locate } from './form-edits';

export interface MoveDialogData {
  readonly document: DesignerDocument;
  /** The component being moved. */
  readonly id: string;
}

interface Destination {
  readonly parent: string | null;
  readonly label: string;
  /** How many components it would hold before the moved one goes in. */
  readonly size: number;
}

const CONTAINERS = new Set(['group', 'dynamicList']);

/**
 * Mover para… (form-designer.md §7.2): a container, *Formulário* or a group or list by its label, and a position in it. The
 * component and the groups inside it are not offered, since a group can't go inside itself. Closes with the place.
 */
@Component({
  selector: 'chain-move-dialog',
  imports: [Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog [title]="'Mover ' + name">
      <form id="chain-move-form" class="chain-move-form" (submit)="move($event)">
        <chain-form-field label="Para">
          <select chainInput [value]="choice()" (change)="choose($event)">
            @for (destination of destinations; track $index) {
              <option [value]="$index">{{ destination.label }}</option>
            }
          </select>
        </chain-form-field>
        <chain-form-field label="Posição">
          <select chainInput [value]="position()" (change)="position.set(number($event))">
            @for (n of positions(); track n) {
              <option [value]="n">{{ n === positions().length ? n + ' (no fim)' : n }}</option>
            }
          </select>
        </chain-form-field>
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-move-form">Mover</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-move-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveDialog {
  protected readonly ref = inject<DialogRef<Place>>(DialogRef);
  private readonly data = inject<MoveDialogData>(DIALOG_DATA);

  private readonly moved = locate(this.data.document, this.data.id)!;
  protected readonly name = nameOf(this.moved.component);
  protected readonly destinations = destinationsFor(this.data.document, this.moved.component);
  protected readonly choice = signal(Math.max(0, this.destinations.findIndex((destination) => destination.parent === this.moved.parent)));
  protected readonly positions = computed(() => Array.from({ length: this.destinations[this.choice()].size + 1 }, (_, i) => i + 1));
  protected readonly position = signal(this.positions().length);

  protected choose(event: Event): void {
    this.choice.set(this.number(event));
    this.position.set(this.positions().length);
  }

  protected number(event: Event): number {
    return Number((event.target as HTMLSelectElement).value);
  }

  protected move(event: Event): void {
    event.preventDefault();
    this.ref.close({ parent: this.destinations[this.choice()].parent, index: this.position() - 1 });
  }
}

/** *Formulário*, then every group and list in document order, indented by level, except the moved one and its insides. */
function destinationsFor(document: DesignerDocument, moved: DesignerComponent): Destination[] {
  const size = (children: readonly DesignerComponent[]) => children.filter((child) => child.id !== moved.id).length;
  const destinations: Destination[] = [{ parent: null, label: 'Formulário', size: size(document.components) }];
  const walk = (components: readonly DesignerComponent[], level: number) => {
    for (const component of components) {
      if (component.id === moved.id || !CONTAINERS.has(component.type)) {
        continue;
      }
      destinations.push({ parent: component.id, label: `${'— '.repeat(level)}${nameOf(component)}`, size: size(component.components ?? []) });
      walk(component.components ?? [], level + 1);
    }
  };
  walk(document.components, 1);
  return destinations;
}
