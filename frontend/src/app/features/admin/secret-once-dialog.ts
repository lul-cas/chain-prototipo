import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Button } from '../../ui/button/button';
import { DialogLayout } from '../../ui/dialog/dialog-layout';

export interface SecretOnceData {
  readonly title: string;
  /** The value's label, such as *Senha temporária*. */
  readonly label: string;
  readonly value: string;
  /** Why it shows only now, and what to do with it. */
  readonly note: string;
}

/**
 * A value the server gives once, such as a temporary password (admin-ui.md §4.3) or a bot's token (§6.2). It starts on
 * **Copiar**; when the clipboard refuses, the value is left selected for the keyboard (§9). Closing doesn't ask: the value
 * can be made again. The value lives only in this dialog, which the page doesn't keep.
 */
@Component({
  selector: 'chain-secret-once-dialog',
  imports: [Button, DialogLayout],
  template: `
    <chain-dialog [title]="data.title">
      <div class="chain-secret-once">
        <label class="chain-secret-once__label" [for]="fieldId">{{ data.label }}</label>
        <input #field class="chain-input chain-mono" type="text" readonly [id]="fieldId" [value]="data.value" />
        <p class="chain-secret-once__note">{{ data.note }}</p>
      </div>
      <div chainDialogActions>
        <span class="chain-secret-once__status" role="status">{{ status() }}</span>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Concluir</button>
        <button chainButton type="button" cdkFocusInitial (click)="copy()">Copiar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-secret-once {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-2);
    }

    .chain-secret-once__label {
      font-weight: var(--chain-font-weight-semibold);
    }

    .chain-secret-once__note {
      margin: 0;
    }

    .chain-secret-once__status {
      margin-inline-end: auto;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecretOnceDialog {
  protected readonly data = inject<SecretOnceData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  protected readonly fieldId = `${this.ref.id}-value`;
  protected readonly status = signal('');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.data.value);
      this.status.set('Copiado.');
    } catch {
      const field = this.field().nativeElement;
      field.focus();
      field.select();
      this.status.set('Não foi possível copiar. O valor está selecionado: copie com o teclado.');
    }
  }
}
