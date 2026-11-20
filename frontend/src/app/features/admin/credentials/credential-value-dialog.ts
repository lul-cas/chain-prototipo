import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { PasswordField } from '../../../ui/form-field/password-field';
import { valueProblem, valueWarnings } from './secret-value';
import { SecretsApi, VersionedSecret } from './secrets-api';

export interface ValueDialogData {
  readonly secret: VersionedSecret;
}

/** What it closes with: the credential's new version, or after a retry it could not confirm, what the list should say. */
export type ValueResult = { readonly version: number } | { readonly uncertain: string };

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';

/**
 * Trocar valor (automation-ui.md §4.4): a new value, sent once with `If-Match` to `PUT …/value`. The value is read from its
 * field when sent, kept there only for a retry, and cleared when the dialog closes (§4.6).
 */
@Component({
  selector: 'chain-credential-value-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input, PasswordField],
  template: `
    <chain-dialog [title]="'Trocar o valor de ' + data.secret.name">
      <form id="chain-value-form" class="chain-value-form" (submit)="change($event)">
        <p class="chain-value-form__hint">Cada nova tentativa de chamada usa o valor atual. Não é possível ver nem recuperar o valor anterior.</p>
        <chain-form-field label="Novo valor" required [error]="problem()">
          <chain-password-field toggleLabel="Mostrar valor">
            <input #value chainInput type="password" autocomplete="off" spellcheck="false" autocapitalize="off" (input)="typed($event)" />
          </chain-password-field>
        </chain-form-field>
        @for (warning of warnings(); track warning) {
          <p class="chain-value-form__warning">{{ warning }}</p>
        }
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-value-form__inline">
              {{ current.text }}
              @if (current.action === 'reload') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="reload()">Recarregar</button>
              }
              @if (current.action === 'retry') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="send(true)">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="close()">Cancelar</button>
        <button chainButton type="submit" form="chain-value-form" [loading]="saving()">Trocar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-value-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-value-form__hint,
    .chain-value-form__warning {
      margin: 0;
      font-size: var(--chain-font-size-sm);
    }

    .chain-value-form__hint {
      color: var(--color-text-muted);
    }

    .chain-value-form__warning {
      color: var(--color-status-warning-text);
    }

    .chain-value-form__inline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CredentialValueDialog {
  private readonly ref = inject<DialogRef<ValueResult>>(DialogRef);
  protected readonly data = inject<ValueDialogData>(DIALOG_DATA);
  private readonly api = inject(SecretsApi);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('value');

  protected readonly warnings = signal<readonly string[]>([]);
  protected readonly problem = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private etag = this.data.secret.etag;

  protected typed(event: Event): void {
    this.warnings.set(valueWarnings((event.target as HTMLInputElement).value));
    this.problem.set(null);
  }

  protected change(event: Event): void {
    event.preventDefault();
    this.send(false);
  }

  protected send(retried: boolean): void {
    const value = this.input().nativeElement.value;
    const problem = valueProblem(value);
    this.problem.set(problem);
    if (problem !== null) {
      return;
    }
    this.saving.set(true);
    this.alert.set(null);
    this.api.setValue(this.data.secret.name, this.etag, value).subscribe({
      next: (secret) => this.finish({ version: secret.version }),
      error: (error: unknown) => {
        this.saving.set(false);
        const failure = isApiProblem(error) ? error : null;
        if (failure?.code === 'secrets_unavailable') {
          // A 503 the API answered itself: definitive, not a lost answer (§4.7).
          this.alert.set({ text: 'O servidor não tem uma chave de criptografia ativa, então credenciais não podem ser trocadas agora. Fale com quem opera o Chain.' });
        } else if (failure && offersRetry(failure)) {
          this.alert.set({ text: 'Não foi possível confirmar a troca.', action: 'retry' });
        } else if (retried && failure?.status === 412) {
          this.finish({ uncertain: UNCONFIRMED });
        } else if (failure?.status === 412) {
          this.alert.set({ text: 'Esta credencial foi alterada depois que você a abriu.', action: 'reload' });
        } else {
          this.alert.set({ text: messageFor(failure?.code ?? 'unexpected') });
        }
      },
    });
  }

  /** Recarregar after a 412: takes the credential's current version; the value typed stays for the next try. */
  protected reload(): void {
    this.api.get(this.data.secret.name).subscribe({
      next: (secret) => {
        this.etag = secret.etag;
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  protected close(): void {
    this.finish(undefined);
  }

  private finish(result: ValueResult | undefined): void {
    this.input().nativeElement.value = '';
    this.ref.close(result);
  }
}
