import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import { Observable, Subject, map, switchMap, takeUntil } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../core/http/api-problem';
import { CommandKey, offersRetry } from '../../core/http/command-key';
import { EngineApi, InstanceView, TaskDetail, TaskView } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { SessionService } from '../../core/session/session.service';
import { FormRenderer } from '../../forms/form-renderer';
import { FieldErrorView } from '../../forms/model';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { DialogService } from '../../ui/dialog/dialog.service';
import { FormField } from '../../ui/form-field/form-field';
import { Input } from '../../ui/form-field/input';
import { ToastService } from '../../ui/toast/toast.service';
import { provideFileUploads } from '../../forms/uploads';

/** One open task: its request, its form or question, and the commands on it (requests-ui.md §1). */
@Component({
  selector: 'chain-task-page',
  imports: [Alert, Button, FormField, FormRenderer, Input, RouterLink],
  providers: [provideFileUploads()],
  templateUrl: './task-page.html',
  styleUrl: './task-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskPage {
  /** The route's `:id`. */
  readonly id = input.required<string>();

  private readonly api = inject(EngineApi);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly title = inject(Title);

  protected readonly detail = signal<TaskDetail | null>(null);
  protected readonly instance = signal<InstanceView | null>(null);
  protected readonly loadError = signal<ApiProblem | null>(null);
  protected readonly commandError = signal<string | null>(null);
  /** Sends the failed request again, when its answer was lost (requests-ui.md §1.5, "Tentar novamente"). */
  protected readonly retry = signal<(() => void) | null>(null);
  protected readonly serverErrors = signal<readonly FieldErrorView[]>([]);
  protected readonly busy = signal(false);
  /** The task is no longer open, or its request stopped: nothing can be done here any more. */
  protected readonly closed = signal(false);
  protected readonly comment = signal('');
  protected readonly justification = signal('');

  /**
   * One key per command, and "Sim" and "Não" are two; a retry keeps it until a definitive answer (requests-ui.md §1.5). The
   * router keeps this page from one task to another, and each task starts with new keys (card #173).
   */
  private keys = commandKeys();
  /** Emits when the router keeps this page for another task, which stops the old task's loads and commands (§1.1). */
  private readonly switched = new Subject<void>();

  protected readonly task = computed(() => this.detail()?.task ?? null);
  protected readonly assignedToMe = computed(() => !!this.task()?.assignee && this.task()?.assignee?.id === this.session.user()?.id);
  protected readonly assignedToOther = computed(() => !!this.task()?.assignee && !this.assignedToMe());
  protected readonly canAct = computed(() => !this.assignedToOther() && !this.closed());
  protected readonly availability = computed(() => {
    const task = this.task();
    if (!task?.assignee) {
      return task?.group ? `Disponível para ${task.group.name}` : 'Disponível para quem solicitou';
    }
    return this.assignedToMe() ? 'Com você' : `Com ${task.assignee.displayName}`;
  });
  // The renderer starts again when these change, so they keep their identity while the task only changes its assignee.
  protected readonly document = computed(() => this.detail()?.form?.document ?? null);
  protected readonly prefill = computed(() => this.detail()?.prefill ?? {});
  protected readonly context = computed(() => this.instance()?.data ?? {});

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
  }

  protected reload(): void {
    this.load(this.id(), false);
  }

  // Each command keeps the task it was pressed on, so neither it nor its retry can reach another task (requests-ui.md §1.1).
  protected start(): void {
    const id = this.id();
    this.run(
      this.keys.start,
      (key) => this.api.startWorking(id, key),
      (task) => this.updateTask(task),
    );
  }

  protected takeOver(): void {
    const id = this.id();
    const assignee = this.task()?.assignee;
    if (!assignee) {
      return;
    }
    this.dialogs
      .confirm({
        title: `Assumir a tarefa de ${assignee.displayName}?`,
        message: `${assignee.displayName} deixa de trabalhar nela, e a linha do tempo registra a troca.`,
        confirmLabel: 'Assumir a tarefa',
        cancelLabel: 'Voltar',
      })
      .pipe(takeUntil(this.switched))
      .subscribe((confirmed) => {
        if (confirmed) {
          this.run(
            this.keys.takeOver,
            (key) => this.api.takeOver(id, key),
            (task) => this.updateTask(task),
          );
        }
      });
  }

  protected complete(dataJson: string | null): void {
    const id = this.id();
    const comment = this.comment().trim() || null;
    this.run(
      this.keys.complete,
      (key) => this.api.complete(id, comment, dataJson, key),
      () => this.done('Tarefa concluída.'),
    );
  }

  protected decide(outcome: boolean): void {
    const id = this.id();
    const justification = this.justification().trim() || null;
    this.run(
      outcome ? this.keys.yes : this.keys.no,
      (key) => this.api.decide(id, outcome, justification, key),
      () => this.done('Decisão registrada.'),
    );
  }

  protected tryAgain(): void {
    this.retry()?.();
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected loadMessage(problem: ApiProblem): string {
    return messageFor(problem.code);
  }

  /**
   * Shows a task as if the page had just opened. The router keeps this page from one task to another, so nothing of the
   * old task stays: its form, messages, keys and retry, and its loads and commands still running (requests-ui.md §1.1).
   */
  private open(id: string): void {
    this.switched.next();
    this.keys = commandKeys(); // a key never crosses tasks
    this.detail.set(null);
    this.instance.set(null);
    this.serverErrors.set([]);
    this.busy.set(false);
    this.closed.set(false);
    this.comment.set('');
    this.justification.set('');
    this.load(id, false);
  }

  private load(id: string, keepMessage: boolean): void {
    if (!keepMessage) {
      this.commandError.set(null);
      this.retry.set(null);
    }
    this.loadError.set(null);
    this.api
      .task(id)
      .pipe(
        switchMap((detail) => this.api.instance(detail.task.instanceId).pipe(map((instance) => ({ detail, instance })))),
        takeUntil(this.switched),
      )
      .subscribe({
        next: ({ detail, instance }) => {
          this.detail.set(detail);
          this.instance.set(instance);
          this.serverErrors.set([]);
          this.title.setTitle(`${detail.task.label} · Chain`);
        },
        error: (error: unknown) => this.loadError.set(isApiProblem(error) ? error : unexpected()),
      });
  }

  private updateTask(task: TaskView): void {
    this.detail.update((detail) => (detail ? { ...detail, task } : detail));
  }

  /** Sends one command with its own idempotency key (requests-ui.md §1.5). */
  private run<T>(key: CommandKey, call: (key: string) => Observable<T>, onSuccess: (value: T) => void): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.commandError.set(null);
    this.retry.set(null);
    call(key.next()).pipe(takeUntil(this.switched)).subscribe({
      next: (value) => {
        key.settle();
        this.busy.set(false);
        onSuccess(value);
      },
      error: (error: unknown) => {
        const problem = isApiProblem(error) ? error : unexpected();
        key.settle(problem);
        this.busy.set(false);
        if (offersRetry(problem)) {
          this.commandError.set(messageFor('network_error'));
          this.retry.set(() => this.run(key, call, onSuccess)); // the same request: same body, same key
        } else {
          this.fail(problem);
        }
      },
    });
  }

  private fail(problem: ApiProblem): void {
    switch (problem.code) {
      case 'submission_invalid':
        this.serverErrors.set(problem.errors as FieldErrorView[]); // the renderer shows them on their fields
        return;
      case 'task_not_open':
      case 'instance_not_running':
        this.closed.set(true);
        this.commandError.set(messageFor(problem.code));
        return;
      case 'task_assigned':
        this.commandError.set(messageFor(problem.code));
        this.load(this.id(), true);
        return;
      case 'validation_failed':
        this.commandError.set(messageFor(errorCodes(problem)[0] ?? problem.code));
        return;
      case 'idempotency_key_reused': // a changed form met the key kept after a lost answer (requests-ui.md §1.5)
        this.commandError.set('A tentativa anterior pode já ter sido registrada, com os dados de antes. Tente de novo para conferir.');
        return;
      default:
        this.commandError.set(messageFor(problem.code));
    }
  }

  private done(message: string): void {
    this.toasts.show({ tone: 'success', message });
    void this.router.navigateByUrl('/tarefas');
  }
}

/** A new key for each command of the page (requests-ui.md §1.5). */
function commandKeys() {
  return { start: new CommandKey(), takeOver: new CommandKey(), complete: new CommandKey(), yes: new CommandKey(), no: new CommandKey() };
}

function unexpected(): ApiProblem {
  return { kind: 'api-problem', status: -1, code: 'unexpected', title: null, errors: [] };
}
