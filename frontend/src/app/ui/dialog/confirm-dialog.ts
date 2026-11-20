import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Button } from '../button/button';
import { DialogLayout } from './dialog-layout';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** "danger" for destructive or irreversible actions. */
  readonly tone?: 'primary' | 'danger';
}

/** Yes/no question. Focus starts on the cancel button, the least destructive choice. */
@Component({
  selector: 'chain-confirm-dialog',
  imports: [DialogLayout, Button],
  template: `
    <chain-dialog [title]="options.title">
      <p>{{ options.message }}</p>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" cdkFocusInitial (click)="ref.close(false)">
          {{ options.cancelLabel ?? 'Cancelar' }}
        </button>
        <button chainButton type="button" [variant]="options.tone === 'danger' ? 'danger' : 'primary'" (click)="ref.close(true)">
          {{ options.confirmLabel }}
        </button>
      </div>
    </chain-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly options = inject<ConfirmOptions>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
}
