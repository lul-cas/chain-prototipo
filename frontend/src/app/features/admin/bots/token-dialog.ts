import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { BOT_FIELD_TEXTS, tokenLabelProblem } from './bot-rules';
import { BotsApi, CreatedToken } from './bots-api';

export interface TokenDialogData {
  readonly botId: string;
}

/**
 * *Novo token* (admin-ui.md §6.2): asks for a label, then closes with the new token and its value, which the page shows once.
 * A lost answer is not retried: a retry would make a second token, and the first one's value would be lost. The page reads
 * the bot again instead, so the admin sees whether it was made and can revoke it.
 */
@Component({
  selector: 'chain-token-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog title="Novo token">
      <form id="chain-token-form" class="chain-token-form" novalidate (submit)="save($event)">
        <chain-form-field label="Rótulo" required hint="Diz onde o token é usado, como “produção”." [error]="error()">
          <input chainInput type="text" autocomplete="off" [value]="label()" (input)="setLabel($event)" />
        </chain-form-field>
        @if (alert(); as text) {
          <chain-alert tone="danger">{{ text }}</chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-token-form" [loading]="saving()">Criar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-token-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TokenDialog {
  protected readonly ref = inject<DialogRef<CreatedToken | 'unconfirmed'>>(DialogRef);
  private readonly data = inject<TokenDialogData>(DIALOG_DATA);
  private readonly api = inject(BotsApi);

  protected readonly label = signal('');
  protected readonly saving = signal(false);
  protected readonly alert = signal<string | null>(null);
  private readonly submitted = signal(false);
  private readonly serverCode = signal<string | null>(null);

  protected error(): string | null {
    const local = tokenLabelProblem(this.label());
    const code = this.serverCode() ?? (local && (this.label() !== '' || this.submitted()) ? local : null);
    return code ? BOT_FIELD_TEXTS[code] : null;
  }

  protected setLabel(event: Event): void {
    this.label.set((event.target as HTMLInputElement).value);
    this.serverCode.set(null);
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (tokenLabelProblem(this.label()) !== null) {
      return;
    }
    this.saving.set(true);
    this.alert.set(null);
    this.api.createToken(this.data.botId, this.label().trim()).subscribe({
      next: (created) => this.ref.close(created),
      error: (error: unknown) => {
        this.saving.set(false);
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.ref.close('unconfirmed');
        } else if (problem?.code === 'validation_failed') {
          this.serverCode.set('invalid_label');
        } else {
          this.alert.set(messageFor(problem?.code ?? 'unexpected'));
        }
      },
    });
  }
}
