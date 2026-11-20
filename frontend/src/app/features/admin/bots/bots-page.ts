import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { BotDialog, BotDialogData, BotDialogResult } from './bot-dialog';
import { Bot, BotsApi } from './bots-api';

/** *Bots* (admin-ui.md §6.1, A4), for admins: a table of the bots. **Novo bot** asks for the identifier and the name. */
@Component({
  selector: 'chain-bots-page',
  imports: [Alert, Button, RouterLink],
  template: `
    <section class="chain-bots" aria-labelledby="chain-bots-title">
      <div class="chain-bots__header">
        <h1 id="chain-bots-title">Bots</h1>
        <button chainButton type="button" (click)="create()">Novo bot</button>
      </div>
      <p class="chain-bots__muted">Contas de integrações e de agentes de IA. Cada bot entra com tokens, nunca com senha.</p>

      @if (notice(); as text) {
        <chain-alert tone="info">{{ text }}</chain-alert>
      }

      @if (loadError(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div><button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button></div>
      } @else if (bots(); as list) {
        @if (list.length === 0) {
          <p class="chain-bots__muted">Nenhum bot ainda. Crie o primeiro com “Novo bot”.</p>
        } @else {
          <div class="chain-admin-table__scroll">
            <table class="chain-admin-table">
              <caption class="chain-visually-hidden">Bots</caption>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Identificador</th>
                  <th scope="col">Situação</th>
                  <th scope="col">MCP</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                @for (bot of list; track bot.id) {
                  <tr>
                    <th scope="row"><a [routerLink]="['/administracao/bots', bot.id]">{{ bot.displayName }}</a></th>
                    <td><code>{{ bot.name }}</code></td>
                    <td>{{ bot.isActive ? 'Ativo' : 'Inativo' }}</td>
                    <td>{{ bot.mcpEnabled ? 'Ligado' : 'Desligado' }}</td>
                    <td>{{ bot.activeTokenCount }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </section>
  `,
  styleUrls: ['../admin-table.css'],
  styles: `
    .chain-bots {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-4);
      max-width: var(--chain-size-content-max);
    }

    .chain-bots__header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--chain-space-2);
    }

    h1 {
      font-size: var(--chain-font-size-2xl);
      line-height: var(--chain-line-height-2xl);
    }

    .chain-bots__muted {
      margin: 0;
      color: var(--color-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotsPage {
  private readonly api = inject(BotsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly bots = signal<readonly Bot[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** What the page could not confirm after a retry. */
  protected readonly notice = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.api.list().subscribe({
      next: (bots) => {
        this.bots.set(bots);
        this.loadError.set(null);
      },
      error: (error: unknown) => this.loadError.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected create(): void {
    this.notice.set(null);
    this.dialogs
      .open<BotDialogResult, BotDialogData>(BotDialog, { data: { bot: null } })
      .closed.subscribe((result) => {
        if (!result) {
          return;
        }
        this.load();
        if ('created' in result) {
          this.toasts.show({ tone: 'success', message: 'Bot criado.' });
        } else if ('uncertain' in result) {
          this.notice.set(result.uncertain);
        }
      });
  }
}
