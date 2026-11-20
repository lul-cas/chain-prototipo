import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { Destination, DestinationsApi } from '../destinations/destinations-api';
import { usageOf } from '../in-use';
import { InUseData, InUseDialog } from '../in-use-dialog';
import { CredentialPanel, CredentialPanelData, CredentialResult } from './credential-panel';
import { CredentialValueDialog, ValueDialogData, ValueResult } from './credential-value-dialog';
import { secretInUse } from './secret-in-use';
import { Secret, SecretsApi, VersionedSecret } from './secrets-api';

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';

/**
 * Credenciais (automation-ui.md §4, AS2), for admins: what a credential is for, where it may go and how many values it has
 * had, never its value. Created and edited in the side panel; its value changed in a dialog; deleted after asking.
 */
@Component({
  selector: 'chain-credentials-page',
  imports: [Alert, Button, DatePipe],
  template: `
    <section class="chain-admin" aria-labelledby="chain-credentials-title">
      <header class="chain-admin__header">
        <h1 id="chain-credentials-title">Credenciais</h1>
        <button chainButton type="button" (click)="create()">Nova credencial</button>
      </header>
      <p class="chain-admin__lead">
        Chaves, tokens e senhas que as automações enviam. O valor é guardado com criptografia e nunca é mostrado de volta, nem a administradores.
      </p>

      @if (notice(); as text) {
        <chain-alert tone="info">{{ text }}</chain-alert>
      }
      @if (actionError(); as current) {
        <chain-alert tone="danger">
          <span class="chain-admin__inline">
            {{ current.text }}
            @if (current.retry) {
              <button chainButton variant="secondary" size="sm" type="button" (click)="current.retry()">Tentar de novo</button>
            }
          </span>
        </chain-alert>
      }

      @if (loadError(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div><button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button></div>
      } @else if (secrets(); as list) {
        @if (list.length === 0) {
          <p>Nenhuma credencial ainda. Crie a primeira com “Nova credencial”.</p>
        } @else {
          <input
            class="chain-input"
            type="search"
            aria-label="Filtrar por nome"
            placeholder="Filtrar por nome"
            [value]="filter()"
            (input)="filter.set(typed($event))"
          />
          <ul class="chain-admin__cards">
            @for (secret of shown(); track secret.name) {
              <li class="chain-admin__card">
                <code class="chain-admin__name">{{ secret.name }}</code>
                @if (secret.description) {
                  <p class="chain-admin__text">{{ secret.description }}</p>
                }
                @if (secret.allowedDestinations.length > 0) {
                  <p class="chain-admin__text">Destinos permitidos: {{ secret.allowedDestinations.join(', ') }}</p>
                } @else {
                  <p class="chain-admin__warning">Nenhum destino: ainda não pode ser usada.</p>
                }
                <p class="chain-admin__text">
                  @if (secret.rotatedAt) {
                    Valor: versão {{ secret.version }}, trocado em <time [attr.datetime]="secret.rotatedAt">{{ secret.rotatedAt | date: 'dd/MM/yyyy HH:mm' }}</time>
                  } @else {
                    Valor: versão {{ secret.version }}, definido em <time [attr.datetime]="secret.createdAt">{{ secret.createdAt | date: 'dd/MM/yyyy HH:mm' }}</time>
                  }
                </p>
                <p class="chain-admin__meta">Chave de criptografia: {{ secret.keyId }}</p>
                <div class="chain-admin__actions">
                  <button chainButton variant="secondary" size="sm" type="button" [attr.aria-label]="'Editar a credencial ' + secret.name" (click)="edit(secret.name)">
                    Editar
                  </button>
                  <button chainButton variant="secondary" size="sm" type="button" [attr.aria-label]="'Trocar o valor de ' + secret.name" (click)="changeValue(secret.name)">
                    Trocar valor
                  </button>
                  <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Excluir a credencial ' + secret.name" (click)="remove(secret.name)">
                    Excluir
                  </button>
                </div>
              </li>
            } @empty {
              <li class="chain-admin__meta">Nenhuma credencial com esse nome.</li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: `
    .chain-admin {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-4);
      max-width: var(--chain-size-measure);
    }

    .chain-admin__header,
    .chain-admin__inline,
    .chain-admin__actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }

    .chain-admin__header {
      justify-content: space-between;
    }

    h1 {
      font-size: var(--chain-font-size-2xl);
      line-height: var(--chain-line-height-2xl);
    }

    .chain-admin__lead,
    .chain-admin__text,
    .chain-admin__meta,
    .chain-admin__warning {
      margin: 0;
    }

    .chain-admin__lead,
    .chain-admin__meta {
      color: var(--color-text-muted);
    }

    .chain-admin__meta {
      font-size: var(--chain-font-size-sm);
    }

    .chain-admin__warning {
      color: var(--color-status-warning-text);
    }

    .chain-admin__cards {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-admin__card {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-2);
      padding: var(--chain-space-4);
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-lg);
      background: var(--color-bg-surface);
    }

    .chain-admin__name {
      font-size: var(--chain-font-size-lg);
      font-weight: var(--chain-font-weight-semibold);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CredentialsPage {
  private readonly api = inject(SecretsApi);
  private readonly destinationsApi = inject(DestinationsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly secrets = signal<readonly Secret[] | null>(null);
  private readonly destinations = signal<readonly Destination[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly shown = computed(() => (this.secrets() ?? []).filter((secret) => secret.name.includes(this.filter().trim().toLowerCase())));

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    forkJoin([this.api.list(), this.destinationsApi.list()]).subscribe({
      next: ([secrets, destinations]) => {
        this.secrets.set(secrets);
        this.destinations.set(destinations);
      },
      error: (error: unknown) => this.loadError.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected create(): void {
    this.clearMessages();
    this.openPanel(null);
  }

  protected edit(name: string): void {
    this.clearMessages();
    this.withCurrent(name, (secret) => this.openPanel(secret));
  }

  /** Trocar valor (§4.4): "Valor trocado. Versão N." */
  protected changeValue(name: string): void {
    this.clearMessages();
    this.withCurrent(name, (secret) =>
      this.dialogs
        .open<ValueResult, ValueDialogData>(CredentialValueDialog, { data: { secret } })
        .closed.subscribe((result) => {
          if (!result) {
            return;
          }
          if ('version' in result) {
            this.toasts.show({ tone: 'success', message: `Valor trocado. Versão ${result.version}.` });
          } else {
            this.notice.set(result.uncertain);
          }
          this.load();
        }),
    );
  }

  /** Excluir (§4.5), as for destinations: asks once; one in use only when forced. */
  protected remove(name: string): void {
    this.clearMessages();
    this.dialogs
      .confirm({ title: `Excluir a credencial ${name}?`, message: 'Não é possível desfazer.', confirmLabel: 'Excluir', tone: 'danger' })
      .subscribe((confirmed) => confirmed && this.delete(name, false, false));
  }

  private delete(name: string, force: boolean, retried: boolean): void {
    this.actionError.set(null);
    this.api.remove(name, force).subscribe({
      next: () => {
        this.toasts.show({ tone: 'success', message: 'Credencial excluída.' });
        this.load();
      },
      error: (error: unknown) => {
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.actionError.set({ text: 'Não foi possível confirmar a exclusão.', retry: () => this.delete(name, force, true) });
        } else if (retried && problem?.status === 404) {
          this.notice.set(UNCONFIRMED);
          this.load();
        } else if (problem?.code === 'secret_in_use') {
          this.dialogs
            .open<boolean, InUseData>(InUseDialog, { data: secretInUse(name, usageOf(problem), 'delete') })
            .closed.subscribe((forced) => forced && this.delete(name, true, false));
        } else if (problem?.status === 404) {
          this.notice.set('Esta credencial já foi excluída.');
          this.load();
        } else {
          this.actionError.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  private withCurrent(name: string, then: (secret: VersionedSecret) => void): void {
    this.api.get(name).subscribe({
      next: then,
      error: (error: unknown) => {
        if (isApiProblem(error) && error.status === 404) {
          this.notice.set('Esta credencial já foi excluída.');
          this.load();
        } else {
          this.actionError.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') });
        }
      },
    });
  }

  private openPanel(secret: VersionedSecret | null): void {
    this.dialogs
      .open<CredentialResult, CredentialPanelData>(CredentialPanel, { data: { secret, destinations: this.destinations() }, size: 'side' })
      .closed.subscribe((result) => {
        if (!result) {
          return;
        }
        if ('saved' in result) {
          this.toasts.show({ tone: 'success', message: secret ? 'Credencial salva.' : 'Credencial criada.' });
        } else {
          this.notice.set(result.uncertain);
        }
        this.load();
      });
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
