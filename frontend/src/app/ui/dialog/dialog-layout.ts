import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideX } from '@lucide/angular';

/**
 * The frame of every Chain dialog: title, close button, body and an actions row.
 * Use it as the root of a component opened with DialogService.open().
 * Put the buttons in an element marked `chainDialogActions`. The header and the actions are plain elements, not `header` and
 * `footer`, which would add a banner and a contentinfo landmark to the page (card #263); the title names the dialog.
 */
@Component({
  selector: 'chain-dialog',
  imports: [LucideX],
  template: `
    <div class="chain-dialog__header">
      <h2 class="chain-dialog__title" [id]="ref.id + '-title'">{{ title() }}</h2>
      <button type="button" class="chain-dialog__close" (click)="ref.close()">
        <svg lucideX aria-hidden="true"></svg>
        <span class="chain-visually-hidden">Fechar</span>
      </button>
    </div>
    <div class="chain-dialog__body" [id]="ref.id + '-body'"><ng-content /></div>
    <div class="chain-dialog__actions"><ng-content select="[chainDialogActions]" /></div>
  `,
  styleUrl: './dialog-layout.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DialogLayout {
  readonly title = input.required<string>();
  protected readonly ref = inject(DialogRef);
}
