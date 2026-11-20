import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { AutomationSummary, AutomationsApi } from '../automations-api';
import { NewAutomationDialog } from './new-automation-dialog';

/** The automations a Modeler can edit (automation-ui.md §6), with a filter by name and "Nova automação". There is no delete. */
@Component({
  selector: 'chain-automations-page',
  imports: [Alert, Button, DatePipe, RouterLink],
  template: `
    <section class="chain-forms" aria-labelledby="chain-automations-title">
      <header class="chain-forms__header">
        <h1 id="chain-automations-title">Automações</h1>
        <button chainButton type="button" (click)="create()">Nova automação</button>
      </header>
      <p class="chain-forms__lead">Chamadas HTTP que as etapas automáticas dos processos fazem.</p>

      @if (error(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div><button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button></div>
      } @else if (forms(); as forms) {
        @if (forms.length === 0) {
          <p>Nenhuma automação ainda. Crie a primeira com “Nova automação”.</p>
        } @else {
          <input
            class="chain-input chain-forms__search"
            type="search"
            aria-label="Buscar automações"
            placeholder="Buscar por nome"
            [value]="search()"
            (input)="search.set(typed($event))"
          />
          @if (shown().length === 0) {
            <p>Nenhuma automação com esse nome.</p>
          }
          <ul class="chain-forms__list">
            @for (form of shown(); track form.id) {
              <li class="chain-forms__item">
                <a class="chain-forms__name" [routerLink]="['/automacoes', form.id]">{{ form.name }}</a>
                @if (form.description) {
                  <p class="chain-forms__description">{{ form.description }}</p>
                }
                <p class="chain-forms__facts">
                  <span>{{ form.latestVersion ? 'Versão ' + form.latestVersion : 'Nunca publicada' }}</span>
                  <span>Rascunho salvo em <time [attr.datetime]="form.draftUpdatedAt">{{ form.draftUpdatedAt | date: 'dd/MM/yyyy HH:mm' }}</time></span>
                </p>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: `
    .chain-forms {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-5);
      max-width: var(--chain-size-measure);
    }

    .chain-forms__header {
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

    .chain-forms__list {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-forms__item {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-1);
      padding: var(--chain-space-4);
      border: var(--chain-border-width) solid var(--color-border-subtle);
      border-radius: var(--chain-radius-lg);
      background: var(--color-bg-surface);
    }

    .chain-forms__name {
      color: var(--color-text-link);
      font-size: var(--chain-font-size-lg);
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-forms__lead,
    .chain-forms__description,
    .chain-forms__facts {
      margin: 0;
      color: var(--color-text-muted);
    }

    .chain-forms__facts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--chain-space-1) var(--chain-space-4);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationsPage {
  private readonly api = inject(AutomationsApi);
  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);

  protected readonly forms = signal<readonly AutomationSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly search = signal('');
  /** The forms whose name contains the search, ignoring case and accents, as in the POC. */
  protected readonly shown = computed(() => {
    const wanted = fold(this.search().trim());
    return (this.forms() ?? []).filter((form) => fold(form.name).includes(wanted));
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.api.summaries().subscribe({
      next: (forms) => this.forms.set(forms),
      error: (error: unknown) => this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected create(): void {
    this.dialogs
      .open<string>(NewAutomationDialog)
      .closed.subscribe((id) => {
        if (id) {
          void this.router.navigate(['/automacoes', id]);
        }
      });
  }
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}
