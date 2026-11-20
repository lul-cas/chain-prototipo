import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import { Subject, forkJoin, takeUntil } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../core/http/api-problem';
import { CommandKey, offersRetry } from '../../core/http/command-key';
import { EngineApi, StartFormView, StartableWorkflow } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { FormRenderer } from '../../forms/form-renderer';
import { FieldErrorView } from '../../forms/model';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { ToastService } from '../../ui/toast/toast.service';
import { provideFileUploads } from '../../forms/uploads';

const EMPTY: Readonly<Record<string, unknown>> = {};

/** A new request of one workflow, through its start form when it has one (requests-ui.md §4). */
@Component({
  selector: 'chain-start-request-page',
  imports: [Alert, Button, FormRenderer, RouterLink],
  providers: [provideFileUploads()],
  template: `
    <section class="chain-start" aria-labelledby="chain-start-title">
      @if (notStartable()) {
        <h1 id="chain-start-title">Este fluxo não pode ser iniciado</h1>
        <p>Ele não existe, está inativo, ou você não pode iniciá-lo.</p>
        <p><a routerLink="/solicitar">Ver os fluxos</a></p>
      } @else if (loadError(); as message) {
        <h1 id="chain-start-title">Nova solicitação</h1>
        <chain-alert tone="danger">{{ message }}</chain-alert>
        <div>
          <button chainButton variant="secondary" type="button" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (startForm(); as start) {
        <header class="chain-start__header">
          <p class="chain-eyebrow">Nova solicitação</p>
          <h1 id="chain-start-title">{{ workflow()?.name }}</h1>
          @if (workflow()?.description; as description) {
            <p class="chain-start__description">{{ description }}</p>
          }
        </header>
        @if (commandError(); as message) {
          <chain-alert tone="danger">
            {{ message }}
            @if (closed()) {
              <a routerLink="/solicitar">Ver os fluxos</a>
            }
            @if (mayHaveStarted()) {
              <a routerLink="/solicitacoes">Ver as solicitações</a>
            }
            @if (retry()) {
              <div class="chain-start__retry">
                <button chainButton variant="secondary" size="sm" type="button" (click)="tryAgain()">Tentar novamente</button>
              </div>
            }
          </chain-alert>
        }
        @if (start.form; as form) {
          <h2 class="chain-start__section">Dados da solicitação</h2>
          <chain-form-renderer [document]="form.document" [prefill]="empty" [context]="empty" [serverErrors]="serverErrors()" [disabled]="closed()" (submitted)="send($event.json)">
            @if (!closed()) {
              <div class="chain-start__actions">
                <button chainButton type="submit" [loading]="busy()">Iniciar solicitação</button>
              </div>
            }
          </chain-form-renderer>
        } @else if (!closed()) {
          <div class="chain-start__actions">
            <button chainButton type="button" [loading]="busy()" (click)="send(null)">Iniciar solicitação</button>
          </div>
        }
      } @else {
        <p role="status">Carregando…</p>
      }
    </section>
  `,
  styleUrl: './start-pages.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartRequestPage {
  /** The route's `:workflowId`. */
  readonly workflowId = input.required<string>();

  private readonly api = inject(EngineApi);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly title = inject(Title);
  /** The key of a start; each workflow starts with a new one (requests-ui.md §4). */
  private key = new CommandKey();
  /** Emits when the router keeps this page for another workflow, which stops the old one's loads and start (§4). */
  private readonly switched = new Subject<void>();

  protected readonly empty = EMPTY;
  protected readonly workflows = signal<readonly StartableWorkflow[] | null>(null);
  protected readonly startForm = signal<StartFormView | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notStartable = signal(false);
  protected readonly commandError = signal<string | null>(null);
  /** Sends the failed request again, when its answer was lost (requests-ui.md §1.5, "Tentar novamente"). */
  protected readonly retry = signal<(() => void) | null>(null);
  protected readonly serverErrors = signal<readonly FieldErrorView[]>([]);
  protected readonly busy = signal(false);
  /** The workflow stopped being startable while the page was open. */
  protected readonly closed = signal(false);
  /** A changed form met the key kept after a lost answer, so that attempt may have started the request (requests-ui.md §4). */
  protected readonly mayHaveStarted = signal(false);
  protected readonly workflow = computed(() => this.workflows()?.find((workflow) => workflow.id === this.workflowId()) ?? null);

  constructor() {
    effect(() => {
      const id = this.workflowId();
      untracked(() => this.open(id));
    });
  }

  protected load(id: string = this.workflowId()): void {
    this.loadError.set(null);
    this.notStartable.set(false);
    forkJoin([this.api.startable(), this.api.startForm(id)]).pipe(takeUntil(this.switched)).subscribe({
      next: ([workflows, startForm]) => {
        this.workflows.set(workflows);
        if (!workflows.some((workflow) => workflow.id === id)) {
          this.notStartable.set(true);
          return;
        }
        this.startForm.set(startForm);
        this.title.setTitle(`${this.workflow()?.name ?? 'Nova solicitação'} · Chain`);
      },
      error: (error: unknown) => {
        const problem = isApiProblem(error) ? error : null;
        if (problem?.code === 'not_found') {
          this.notStartable.set(true);
        } else {
          this.loadError.set(messageFor(problem?.code ?? 'unexpected'));
        }
      },
    });
  }

  protected send(dataJson: string | null): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.commandError.set(null);
    this.retry.set(null);
    this.mayHaveStarted.set(false);
    this.api.start(this.workflowId(), dataJson, this.key.next()).pipe(takeUntil(this.switched)).subscribe({
      next: (request) => {
        this.key.settle();
        this.busy.set(false);
        this.toasts.show({ tone: 'success', message: 'Solicitação iniciada.' });
        void this.router.navigate(['/solicitacoes', request.id]);
      },
      error: (error: unknown) => {
        const problem: ApiProblem = isApiProblem(error) ? error : { kind: 'api-problem', status: -1, code: 'unexpected', title: null, errors: [] };
        this.key.settle(problem);
        this.busy.set(false);
        if (offersRetry(problem)) {
          this.commandError.set(messageFor('network_error'));
          this.retry.set(() => this.send(dataJson)); // the same request: same data, same key
          return;
        }
        switch (problem.code) {
          case 'submission_invalid':
            this.serverErrors.set(problem.errors as FieldErrorView[]);
            return;
          case 'workflow_not_startable':
            this.closed.set(true);
            this.commandError.set(messageFor(problem.code));
            return;
          case 'forbidden':
            this.closed.set(true);
            this.commandError.set('Você não pode iniciar este fluxo.');
            return;
          case 'validation_failed':
            this.commandError.set(messageFor(errorCodes(problem)[0] ?? problem.code));
            return;
          case 'idempotency_key_reused':
            this.mayHaveStarted.set(true);
            this.commandError.set('A tentativa anterior pode já ter iniciado a solicitação. Confira antes de iniciar outra.');
            return;
          default:
            this.commandError.set(messageFor(problem.code));
        }
      },
    });
  }

  protected tryAgain(): void {
    this.retry()?.();
  }

  /**
   * Shows a workflow as if the page had just opened. The router keeps this page from one workflow to another, so nothing
   * of the old workflow stays: its form, messages, key and retry, and its loads and start still running (requests-ui.md §4).
   */
  private open(id: string): void {
    this.switched.next();
    this.key = new CommandKey();
    this.startForm.set(null);
    this.commandError.set(null);
    this.retry.set(null);
    this.serverErrors.set([]);
    this.busy.set(false);
    this.closed.set(false);
    this.mayHaveStarted.set(false);
    this.load(id);
  }
}
