import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { isApiProblem } from '../../core/http/api-problem';
import { messageFor } from '../../core/http/messages';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { DialogService } from '../../ui/dialog/dialog.service';
import { NewProcessDialog } from './new-process-dialog';
import { ProcessSummary } from './workflow-document';
import { WorkflowsApi } from './workflows-api';

/** The processes an admin or Modeler can edit (workflow-editor.md §10.1), and "Novo processo". */
@Component({
  selector: 'chain-processes-page',
  imports: [Alert, Button, DatePipe, RouterLink],
  template: `
    <section class="chain-processes" aria-labelledby="chain-processes-title">
      <header class="chain-processes__header">
        <h1 id="chain-processes-title">Processos</h1>
        <button chainButton type="button" (click)="create()">Novo processo</button>
      </header>

      @if (error(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div><button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button></div>
      } @else if (processes(); as processes) {
        @if (processes.length === 0) {
          <p>Nenhum processo ainda. Crie o primeiro com “Novo processo”.</p>
        } @else {
          <ul class="chain-processes__list">
            @for (process of processes; track process.id) {
              <li class="chain-processes__item">
                <a class="chain-processes__name" [routerLink]="['/processos', process.id]">{{ process.name }}</a>
                @if (process.description) {
                  <p class="chain-processes__description">{{ process.description }}</p>
                }
                <p class="chain-processes__facts">
                  <span>{{ process.isActive ? 'Ativo' : 'Inativo' }}</span>
                  <span>{{ process.latestVersion ? 'Versão ' + process.latestVersion : 'Nunca publicado' }}</span>
                  <span>
                    Rascunho salvo em <time [attr.datetime]="process.draftUpdatedAt">{{ process.draftUpdatedAt | date: 'dd/MM/yyyy HH:mm' }}</time>
                  </span>
                </p>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: `
    .chain-processes {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-5);
      max-width: var(--chain-size-measure);
    }

    .chain-processes__header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--chain-space-3);
    }

    h1 {
      font-size: var(--chain-font-size-2xl);
      line-height: var(--chain-line-height-2xl);
    }

    .chain-processes__list {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-processes__item {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-1);
      padding: var(--chain-space-4);
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-lg);
      background: var(--color-bg-surface);
    }

    .chain-processes__name {
      color: var(--color-text-link);
      font-size: var(--chain-font-size-lg);
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-processes__description,
    .chain-processes__facts {
      margin: 0;
      color: var(--color-text-muted);
    }

    .chain-processes__facts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--chain-space-1) var(--chain-space-4);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessesPage {
  private readonly api = inject(WorkflowsApi);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);

  protected readonly processes = signal<readonly ProcessSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.api.list().subscribe({
      next: (processes) => this.processes.set(processes),
      error: (error: unknown) => this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected create(): void {
    this.dialogs
      .open<string>(NewProcessDialog)
      .closed.subscribe((id) => {
        if (id) {
          void this.router.navigate(['/processos', id]);
        }
      });
  }
}
