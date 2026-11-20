import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isApiProblem } from '../../core/http/api-problem';
import { EngineApi, StartableWorkflow } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';

/** The workflows the user may start (requests-ui.md §4). */
@Component({
  selector: 'chain-start-list-page',
  imports: [Alert, Button, RouterLink],
  template: `
    <section class="chain-start" aria-labelledby="chain-start-title">
      <h1 id="chain-start-title">Solicitar</h1>
      @if (error(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div>
          <button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (workflows(); as list) {
        @if (list.length === 0) {
          <p class="chain-start__empty">Você ainda não pode iniciar nenhum fluxo.</p>
        } @else {
          <ul class="chain-start__list">
            @for (workflow of list; track workflow.id) {
              <li class="chain-start__item">
                <div class="chain-start__text">
                  <h2 class="chain-start__name">{{ workflow.name }}</h2>
                  @if (workflow.description) {
                    <p class="chain-start__description">{{ workflow.description }}</p>
                  }
                </div>
                <!-- The label starts with the visible word, so speech input still finds it (WCAG 2.5.3). -->
                <a chainButton variant="secondary" size="sm" [routerLink]="['/solicitar', workflow.id]" [attr.aria-label]="'Solicitar ' + workflow.name">
                  Solicitar
                </a>
              </li>
            }
          </ul>
        }
      } @else {
        <p role="status">Carregando fluxos…</p>
      }
    </section>
  `,
  styleUrl: './start-pages.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartListPage {
  private readonly api = inject(EngineApi);
  protected readonly workflows = signal<readonly StartableWorkflow[] | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.api.startable().subscribe({
      next: (workflows) => this.workflows.set(workflows),
      error: (error: unknown) => this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }
}
