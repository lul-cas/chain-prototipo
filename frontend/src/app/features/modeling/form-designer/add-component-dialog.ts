import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { PaletteType } from './form-edits';
import { FormPalettePanel } from './form-palette-panel';

/** Adicionar componente (form-designer.md §5): the palette in a dialog on narrow screens. Closes with the chosen type. */
@Component({
  selector: 'chain-add-component-dialog',
  imports: [DialogLayout, FormPalettePanel],
  template: `
    <chain-dialog title="Adicionar componente">
      <chain-form-palette (add)="ref.close($event)" />
    </chain-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddComponentDialog {
  protected readonly ref = inject<DialogRef<PaletteType>>(DialogRef);
}
