import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { ApiProblem, isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { InUseData, InUseDialog } from '../in-use-dialog';
import { destinationInUse } from './destination-in-use';
import { DestinationPanel, DestinationPanelData, PanelResult } from './destination-panel';
import { DEFAULT_MAX_BYTES, addressText, sizeText } from './destination-rules';
import { Secret, SecretsApi } from '../credentials/secrets-api';
import { Destination, DestinationsApi, usageOf } from './destinations-api';

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';

/**
 * Destinos (automation-ui.md §3, AS1), for admins: the addresses automations may call, as cards with a filter. A destination
 * is created and edited in the side panel, and deleted after asking; one in use is deleted only when forced (§3.3).
 */
@Component({
  selector: 'chain-destinations-page',
  imports: [Alert, Button, DatePipe],
  template: `
    <section class="chain-admin" aria-labelledby="chain-destinations-title">
      <header class="chain-admin__header">
        <h1 id="chain-destinations-title">Destinos</h1>
        <button chainButton type="button" (click)="create()">Novo destino</button>
      </header>
      <p class="chain-admin__lead">Os endereços que as automações podem chamar. Uma credencial só é enviada aos destinos que ela permite.</p>

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
      } @else if (destinations(); as list) {
        @if (list.length === 0) {
          <p>Nenhum destino ainda. Crie o primeiro com “Novo destino”.</p>
        } @else {
          <input
            class="chain-input chain-admin__filter"
            type="search"
            aria-label="Filtrar por nome ou host"
            placeholder="Filtrar por nome ou host"
            [value]="filter()"
            (input)="filter.set(typed($event))"
          />
          <ul class="chain-admin__cards">
            @for (destination of shown(); track destination.name) {
              <li class="chain-admin__card">
                <div class="chain-admin__card-head">
                  <code class="chain-admin__name">{{ destination.name }}</code>
                  <span class="chain-admin__address">{{ address(destination) }}</span>
                </div>
                @if (badges(destination); as list) {
                  @if (list.length > 0) {
                    <p class="chain-admin__badges">
                      @for (badge of list; track badge) {
                        <span class="chain-admin__badge">{{ badge }}</span>
                      }
                    </p>
                  }
                }
                @if (destination.description) {
                  <p class="chain-admin__description">{{ destination.description }}</p>
                }
                @if (credentialsOf(destination.name); as names) {
                  <p class="chain-admin__meta">Credenciais que o permitem: {{ names.length > 0 ? names.join(', ') : 'nenhuma' }}</p>
                }
                <p class="chain-admin__meta">Atualizado em <time [attr.datetime]="destination.updatedAt">{{ destination.updatedAt | date: 'dd/MM/yyyy HH:mm' }}</time></p>
                <div class="chain-admin__actions">
                  <button chainButton variant="secondary" size="sm" type="button" [attr.aria-label]="'Editar o destino ' + destination.name" (click)="edit(destination.name)">
                    Editar
                  </button>
                  <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Excluir o destino ' + destination.name" (click)="remove(destination.name)">
                    Excluir
                  </button>
                </div>
              </li>
            } @empty {
              <li class="chain-admin__meta">Nenhum destino com esse nome ou host.</li>
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
    .chain-admin__actions,
    .chain-admin__badges {
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
    .chain-admin__description,
    .chain-admin__meta,
    .chain-admin__badges {
      margin: 0;
    }

    .chain-admin__lead,
    .chain-admin__meta {
      color: var(--color-text-muted);
    }

    .chain-admin__meta {
      font-size: var(--chain-font-size-sm);
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

    .chain-admin__card-head {
      display: flex;
      flex-direction: column;
    }

    .chain-admin__name {
      font-size: var(--chain-font-size-lg);
      font-weight: var(--chain-font-weight-semibold);
    }

    .chain-admin__address {
      color: var(--color-text-muted);
      overflow-wrap: anywhere;
    }

    .chain-admin__badge {
      padding: 0 var(--chain-space-2);
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-full);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DestinationsPage {
  private readonly api = inject(DestinationsApi);
  private readonly secretsApi = inject(SecretsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly destinations = signal<readonly Destination[] | null>(null);
  /** The credentials, to list those that allow each destination (§3.1, AS2). */
  private readonly secrets = signal<readonly Secret[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly filter = signal('');
  /** What the page could not confirm after a retry, or a destination already gone. */
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly shown = computed(() => {
    const wanted = this.filter().trim().toLocaleLowerCase('pt-BR');
    return (this.destinations() ?? []).filter((destination) => `${destination.name} ${destination.host}`.includes(wanted));
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    forkJoin([this.api.list(), this.secretsApi.list()]).subscribe({
      next: ([destinations, secrets]) => {
        this.destinations.set(destinations);
        this.secrets.set(secrets);
      },
      error: (error: unknown) => this.loadError.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** *Credenciais que o permitem* (§3.1): those whose allowed destinations list it. */
  protected credentialsOf(name: string): string[] {
    return this.secrets()
      .filter((secret) => secret.allowedDestinations.includes(name))
      .map((secret) => secret.name);
  }

  protected address(destination: Destination): string {
    return addressText(destination);
  }

  /** Badges in words (§3.1): Interno, HTTP sem TLS, Credenciais por HTTP, and each size that isn't the default. */
  protected badges(destination: Destination): string[] {
    return [
      destination.internal ? 'Interno' : null,
      destination.scheme === 'http' ? 'HTTP sem TLS' : null,
      destination.allowSecretsOverHttp ? 'Credenciais por HTTP' : null,
      destination.maxRequestBytes !== DEFAULT_MAX_BYTES ? `Envio até ${sizeText(destination.maxRequestBytes)}` : null,
      destination.maxResponseBytes !== DEFAULT_MAX_BYTES ? `Resposta até ${sizeText(destination.maxResponseBytes)}` : null,
    ].filter((badge): badge is string => badge !== null);
  }

  protected create(): void {
    this.openPanel(null);
  }

  protected edit(name: string): void {
    this.clearMessages();
    this.api.get(name).subscribe({
      next: (destination) => this.openPanel(destination),
      error: (error: unknown) => this.gone(error) || this.actionError.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  /** Excluir (§3.3): asks once, then deletes; a destination in use is deleted only when forced. */
  protected remove(name: string): void {
    this.clearMessages();
    this.dialogs
      .confirm({ title: `Excluir o destino ${name}?`, message: 'Não é possível desfazer.', confirmLabel: 'Excluir', tone: 'danger' })
      .subscribe((confirmed) => confirmed && this.delete(name, false, false));
  }

  private delete(name: string, force: boolean, retried: boolean): void {
    this.actionError.set(null);
    this.api.remove(name, force).subscribe({
      next: () => {
        this.toasts.show({ tone: 'success', message: 'Destino excluído.' });
        this.load();
      },
      error: (error: unknown) => {
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.actionError.set({ text: 'Não foi possível confirmar a exclusão.', retry: () => this.delete(name, force, true) });
        } else if (retried && problem?.status === 404) {
          this.notice.set(UNCONFIRMED);
          this.load();
        } else if (problem?.code === 'destination_in_use') {
          this.dialogs
            .open<boolean, InUseData>(InUseDialog, { data: destinationInUse(name, usageOf(problem), 'delete') })
            .closed.subscribe((forced) => forced && this.delete(name, true, false));
        } else if (!this.gone(problem)) {
          this.actionError.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  private openPanel(destination: DestinationPanelData['destination']): void {
    this.dialogs
      .open<PanelResult, DestinationPanelData>(DestinationPanel, { data: { destination }, size: 'side' })
      .closed.subscribe((result) => {
        if (!result) {
          return;
        }
        if ('saved' in result) {
          this.toasts.show({ tone: 'success', message: 'Destino salvo.' });
        } else {
          this.notice.set(result.uncertain);
        }
        this.load();
      });
  }

  /** A 404: the destination was deleted meanwhile, which the list then shows. */
  private gone(problem: unknown): boolean {
    if (isApiProblem(problem) && (problem as ApiProblem).status === 404) {
      this.notice.set('Este destino já foi excluído.');
      this.load();
      return true;
    }
    return false;
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
