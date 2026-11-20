import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { ToastService } from '../../../ui/toast/toast.service';

/** "Visualizar JSON" (workflow-editor.md §4): the draft as formatted JSON, with a copy button; the dialog closes as any other. */
@Component({
  selector: 'chain-draft-json-dialog',
  imports: [Button, DialogLayout],
  template: `
    <chain-dialog title="JSON do rascunho">
      <pre class="chain-draft-json" data-testid="draft-json" tabindex="0" aria-label="JSON do rascunho">{{ json }}</pre>
      <div chainDialogActions>
        <button chainButton type="button" (click)="copy()">Copiar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-draft-json {
      max-block-size: 60vh;
      margin: 0;
      padding: var(--chain-space-3);
      overflow: auto;
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-md);
      background: var(--color-bg-subtle);
      font-family: var(--chain-font-mono);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DraftJsonDialog {
  protected readonly json = inject<string>(DIALOG_DATA);
  private readonly toasts = inject(ToastService);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.json);
      this.toasts.show({ tone: 'success', message: 'JSON copiado.' });
    } catch {
      this.toasts.show({ tone: 'warning', message: 'Não foi possível copiar. Selecione o texto e copie.' });
    }
  }
}
