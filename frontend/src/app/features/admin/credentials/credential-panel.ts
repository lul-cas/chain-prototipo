import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { PasswordField } from '../../../ui/form-field/password-field';
import { addressText } from '../destinations/destination-rules';
import { Destination, DestinationsApi } from '../destinations/destinations-api';
import { usageOf } from '../in-use';
import { InUseData, InUseDialog } from '../in-use-dialog';
import { secretInUse } from './secret-in-use';
import { valueProblem, valueWarnings } from './secret-value';
import { SecretsApi, VersionedSecret } from './secrets-api';

export interface CredentialPanelData {
  /** The credential to edit, or null for a new one. */
  readonly secret: VersionedSecret | null;
  /** The destinations for the checklist, with their addresses. */
  readonly destinations: readonly Destination[];
}

export type CredentialResult = { readonly saved: VersionedSecret } | { readonly uncertain: string };

type Field = 'name' | 'description' | 'destinations' | 'value';

/** The API's codes at their fields, in pt-BR (automation-ui.md §4.7). */
const MESSAGES: Readonly<Record<string, readonly [Field, string]>> = {
  invalid_name: ['name', 'Use até 64 caracteres: letras minúsculas sem acento, dígitos, _, . ou -, começando por letra ou dígito.'],
  secret_name_taken: ['name', 'Já existe uma credencial com este nome.'],
  description_too_long: ['description', 'A descrição pode ter no máximo 500 caracteres.'],
  invalid_description: ['description', 'A descrição tem caracteres que não podem ser guardados.'],
  value_required: ['value', 'Informe o valor.'],
  value_too_long: ['value', 'O valor pode ter no máximo 8.192 bytes.'],
  invalid_value: ['value', 'O valor tem caracteres que não podem ser guardados.'],
};
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';
const UNAVAILABLE =
  'O servidor não tem uma chave de criptografia ativa, então credenciais não podem ser criadas nem trocadas agora. Fale com quem opera o Chain.';

/**
 * Nova credencial, or a credential's description and destinations (automation-ui.md §4.2, §4.3), in the side panel. The
 * value goes only in the one request that creates the credential, and is read from its field when it is sent; it is never
 * pre-filled, stored elsewhere or shown in a message, and it goes with the panel (§4.6).
 */
@Component({
  selector: 'chain-credential-panel',
  imports: [Alert, Button, DialogLayout, FormField, Input, PasswordField],
  template: `
    <chain-dialog [title]="editing ? 'Credencial ' + name() : 'Nova credencial'">
      <form id="chain-credential-form" class="chain-credential" (submit)="save($event)">
        @if (!editing) {
          <chain-form-field label="Nome" required hint="As regras do nome de um destino. Não pode ser trocado depois." [error]="error('name')">
            <input chainInput class="chain-mono" type="text" [value]="name()" (input)="name.set(text($event))" />
          </chain-form-field>
        }
        <chain-form-field label="Descrição" hint="Os Modeladores a veem: diga para que a credencial serve." [error]="error('description')">
          <textarea chainInput rows="2" [value]="description()" (input)="description.set(text($event))"></textarea>
        </chain-form-field>
        <fieldset class="chain-credential__destinations">
          <legend>Destinos permitidos</legend>
          @for (destination of destinations(); track destination.name) {
            <label class="chain-credential__check">
              <input type="checkbox" [checked]="allowed().includes(destination.name)" (change)="toggle(destination.name, $event)" />
              <span><code>{{ destination.name }}</code> <span class="chain-credential__muted">{{ address(destination) }}</span></span>
            </label>
          } @empty {
            <p class="chain-credential__muted">Nenhum destino cadastrado.</p>
          }
          @if (allowed().length === 0) {
            <p class="chain-credential__warning">Nenhum destino: ainda não pode ser usada.</p>
          }
          @if (removed()) {
            <p class="chain-credential__warning">Automações publicadas que usam esta credencial com esse destino falham na próxima chamada.</p>
          }
          @if (error('destinations'); as message) {
            <p class="chain-credential__error">{{ message }}</p>
          }
        </fieldset>
        @if (!editing) {
          <chain-form-field label="Valor" required [error]="error('value')">
            <chain-password-field toggleLabel="Mostrar valor">
              <input #value chainInput type="password" autocomplete="off" spellcheck="false" autocapitalize="off" (input)="typed($event)" />
            </chain-password-field>
          </chain-form-field>
          @for (warning of warnings(); track warning) {
            <p class="chain-credential__warning">{{ warning }}</p>
          }
        }
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-credential__inline">
              {{ current.text }}
              @if (current.action === 'reload') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="reload()">Recarregar</button>
              }
              @if (current.action === 'retry') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="retry()">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-credential-form" [loading]="saving()">Salvar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-credential {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-credential__destinations {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-1);
      margin: 0;
      padding: 0;
      border: 0;
    }

    .chain-credential__destinations legend {
      margin-block-end: var(--chain-space-1);
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-credential__check,
    .chain-credential__inline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }

    .chain-credential__muted,
    .chain-credential__warning,
    .chain-credential__error {
      margin: 0;
      font-size: var(--chain-font-size-sm);
    }

    .chain-credential__muted {
      color: var(--color-text-muted);
    }

    .chain-credential__warning {
      color: var(--color-status-warning-text);
    }

    .chain-credential__error {
      color: var(--color-text-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CredentialPanel {
  protected readonly ref = inject<DialogRef<CredentialResult>>(DialogRef);
  private readonly data = inject<CredentialPanelData>(DIALOG_DATA);
  private readonly api = inject(SecretsApi);
  private readonly destinationsApi = inject(DestinationsApi);
  private readonly dialogs = inject(DialogService);
  private readonly valueInput = viewChild<ElementRef<HTMLInputElement>>('value');

  protected readonly editing = this.data.secret !== null;
  protected readonly name = signal(this.data.secret?.name ?? '');
  protected readonly description = signal(this.data.secret?.description ?? '');
  protected readonly allowed = signal<readonly string[]>(this.data.secret?.allowedDestinations ?? []);
  protected readonly destinations = signal<readonly Destination[]>(this.data.destinations);
  /** The warnings of the value as it is typed (§4.2); the value itself stays in its field. */
  protected readonly warnings = signal<readonly string[]>([]);
  private readonly valueError = signal<string | null>(null);
  private readonly saved = signal<readonly string[]>(this.data.secret?.allowedDestinations ?? []);
  private readonly etag = signal(this.data.secret?.etag ?? '');
  protected readonly removed = computed(() => this.editing && this.saved().some((name) => !this.allowed().includes(name)));

  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private readonly serverErrors = signal<readonly (readonly [Field, string])[]>([]);
  private pending: (() => void) | null = null;

  protected error(field: Field): string | null {
    const server = this.serverErrors().find(([candidate]) => candidate === field);
    if (server) {
      return server[1];
    }
    if (field === 'name' && !this.editing && this.name() !== '' && !NAME.test(this.name())) {
      return MESSAGES['invalid_name'][1];
    }
    if (field === 'description' && this.description().length > 500) {
      return MESSAGES['description_too_long'][1];
    }
    return field === 'value' ? this.valueError() : null;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected typed(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.warnings.set(valueWarnings(value));
    this.valueError.set(null);
  }

  protected address(destination: Destination): string {
    return addressText(destination);
  }

  protected toggle(name: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.allowed.update((allowed) => (on ? [...allowed, name] : allowed.filter((candidate) => candidate !== name)));
  }

  protected save(event?: Event, force = false): void {
    event?.preventDefault();
    this.serverErrors.set([]);
    const description = this.description().trim() === '' ? null : this.description();
    const allowed = [...this.allowed()];
    if (this.editing) {
      const name = this.name();
      const etag = this.etag();
      this.send(() => this.api.update(name, etag, description, allowed, force), false);
      return;
    }
    const value = this.valueInput()?.nativeElement.value ?? '';
    const problem = valueProblem(value);
    this.valueError.set(problem);
    if (problem !== null || !NAME.test(this.name())) {
      if (!NAME.test(this.name())) {
        this.serverErrors.set([MESSAGES['invalid_name']]);
      }
      return;
    }
    const name = this.name();
    this.send(() => this.api.create(name, description, value, allowed), false);
  }

  protected retry(): void {
    this.pending?.();
  }

  /** Recarregar after a 412: the current description and destinations replace what was typed. */
  protected reload(): void {
    this.api.get(this.name()).subscribe({
      next: (secret) => {
        this.description.set(secret.description ?? '');
        this.allowed.set(secret.allowedDestinations);
        this.saved.set(secret.allowedDestinations);
        this.etag.set(secret.etag);
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  private send(request: () => Observable<VersionedSecret>, retried: boolean): void {
    this.saving.set(true);
    this.alert.set(null);
    this.pending = null;
    request().subscribe({
      next: (saved) => {
        this.clearValue();
        this.ref.close({ saved });
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const problem = isApiProblem(error) ? error : null;
        if (problem?.code === 'secrets_unavailable') {
          // A 503 the API answered itself: definitive, not a lost answer (§4.7).
          this.alert.set({ text: UNAVAILABLE });
        } else if (problem && offersRetry(problem)) {
          // The value stays in its field, so the admin can retry (§4.6).
          this.pending = () => this.send(request, true);
          this.alert.set({ text: 'Não foi possível confirmar o envio.', action: 'retry' });
        } else if (retried && (problem?.status === 412 || problem?.code === 'secret_name_taken')) {
          this.clearValue();
          this.ref.close({ uncertain: problem.code === 'secret_name_taken' ? `${UNCONFIRMED} Se foi a sua tentativa anterior, ela já criou o item.` : UNCONFIRMED });
        } else if (problem?.code === 'validation_failed') {
          this.serverErrors.set(errorCodes(problem).flatMap((code) => (MESSAGES[code] ? [MESSAGES[code]] : [])));
        } else if (problem?.code === 'secret_name_taken') {
          this.serverErrors.set([MESSAGES['secret_name_taken']]);
        } else if (problem?.code === 'unknown_destination') {
          const names = errorCodes(problem);
          this.serverErrors.set([['destinations', names.map((name) => `O destino ${name} não existe mais.`).join(' ')]]);
          this.allowed.update((allowed) => allowed.filter((name) => !names.includes(name)));
          this.destinationsApi.list().subscribe((destinations) => this.destinations.set(destinations));
        } else if (problem?.code === 'secret_in_use') {
          this.dialogs
            .open<boolean, InUseData>(InUseDialog, { data: secretInUse(this.name(), usageOf(problem), 'save') })
            .closed.subscribe((force) => force && this.save(undefined, true));
        } else if (problem?.status === 412) {
          this.alert.set({ text: 'Esta credencial foi alterada depois que você a abriu.', action: 'reload' });
        } else {
          this.alert.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  private clearValue(): void {
    const input = this.valueInput()?.nativeElement;
    if (input) {
      input.value = '';
    }
  }
}
