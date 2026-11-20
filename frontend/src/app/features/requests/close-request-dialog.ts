import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Button } from '../../ui/button/button';
import { DialogLayout } from '../../ui/dialog/dialog-layout';
import { FormField } from '../../ui/form-field/form-field';
import { Input } from '../../ui/form-field/input';

/** Asks the justification that closing a request requires (FR-034); closes with it, or with nothing when the user goes back. */
@Component({
  selector: 'chain-close-request-dialog',
  imports: [Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog title="Encerrar solicitação?">
      <p>As tarefas abertas serão canceladas, e a linha do tempo registra a justificativa.</p>
      <chain-form-field label="Justificativa" required [error]="error()">
        <textarea chainInput maxlength="1000" [value]="text()" (input)="update($event)"></textarea>
      </chain-form-field>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Voltar</button>
        <button chainButton variant="danger" type="button" (click)="confirm()">Encerrar</button>
      </div>
    </chain-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CloseRequestDialog {
  protected readonly ref = inject<DialogRef<string>>(DialogRef);
  protected readonly text = signal('');
  protected readonly error = signal<string | null>(null);

  protected update(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
    this.error.set(null);
  }

  protected confirm(): void {
    const justification = this.text().trim();
    if (!justification) {
      this.error.set('Escreva uma justificativa.');
      return;
    }
    this.ref.close(justification);
  }
}
