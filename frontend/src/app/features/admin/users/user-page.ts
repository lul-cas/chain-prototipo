import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, Subject, takeUntil } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { showTemporaryPassword } from './temporary-password';
import { UserDialog, UserDialogData, UserDialogResult } from './user-dialog';
import { userStates } from './user-rules';
import { UsersApi, VersionedUser } from './users-api';

type Action = 'deactivate' | 'activate' | 'unlock' | 'reset';

interface ActionTexts {
  readonly title: (name: string) => string;
  readonly message: (name: string) => string;
  readonly confirmLabel: string;
  readonly tone: 'primary' | 'danger';
  /** The toast once done; a reset shows the password instead. */
  readonly done: string | null;
  /** What the page says when the answer was lost, next to **Tentar de novo**. */
  readonly unconfirmed: string;
}

/** Each action's question and texts (admin-ui.md §4.2). */
const ACTIONS: Readonly<Record<Action, ActionTexts>> = {
  deactivate: {
    title: (name) => `Desativar ${name}?`,
    message: (name) => `${name} não poderá entrar, e as sessões abertas terminam agora.`,
    confirmLabel: 'Desativar',
    tone: 'danger',
    done: 'Usuário desativado.',
    unconfirmed: 'Não foi possível confirmar a desativação.',
  },
  activate: {
    title: (name) => `Ativar ${name}?`,
    message: (name) => `${name} poderá entrar de novo.`,
    confirmLabel: 'Ativar',
    tone: 'primary',
    done: 'Usuário ativado.',
    unconfirmed: 'Não foi possível confirmar a ativação.',
  },
  unlock: {
    title: (name) => `Desbloquear ${name}?`,
    message: (name) => `${name} poderá tentar entrar de novo agora, sem esperar o bloqueio terminar.`,
    confirmLabel: 'Desbloquear',
    tone: 'primary',
    done: 'Usuário desbloqueado.',
    unconfirmed: 'Não foi possível confirmar o desbloqueio.',
  },
  reset: {
    title: (name) => `Redefinir a senha de ${name}?`,
    message: () => 'Uma nova senha temporária é criada, as sessões abertas terminam e a conta é desbloqueada. A senha aparece em seguida, uma única vez.',
    confirmLabel: 'Redefinir senha',
    tone: 'danger',
    done: null,
    unconfirmed: 'Não foi possível confirmar a nova senha. Tente de novo para gerar outra.',
  },
};

/**
 * A user's page (admin-ui.md §4.2, A1): the facts, **Editar** with `If-Match`, and the actions, each asked first. After an
 * action the user is read again. A lost answer offers **Tentar de novo**, which repeats the action without asking: each is
 * safe to repeat, and a repeated reset makes another password. The page starts afresh when the route moves to another user.
 */
@Component({
  selector: 'chain-user-page',
  imports: [Alert, Button, DatePipe, RouterLink],
  templateUrl: './user-page.html',
  styleUrl: './user-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserPage {
  readonly id = input.required<string>();
  private readonly api = inject(UsersApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly user = signal<VersionedUser | null>(null);
  protected readonly loadError = signal<{ readonly text: string; readonly retry: boolean } | null>(null);
  /** What the page could not confirm after a retry. */
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly busy = signal<Action | null>(null);
  /** The role, when there is one, then the state (§4.2). */
  protected readonly facts = computed(() => {
    const user = this.user();
    return user ? [...(user.isAdmin ? ['Administrador'] : []), ...userStates(user)] : [];
  });
  /** Ends what was started for the previous user (card #187). */
  private readonly switched = new Subject<void>();

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
    inject(DestroyRef).onDestroy(() => this.switched.next());
  }

  protected load(id: string = this.id()): void {
    this.api
      .get(id)
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: (user) => {
          this.user.set(user);
          this.loadError.set(null);
        },
        error: (error: unknown) => {
          const problem = isApiProblem(error) ? error : null;
          this.loadError.set(problem?.status === 404 ? { text: 'Este usuário não existe.', retry: false } : { text: messageFor(problem?.code ?? 'unexpected'), retry: true });
        },
      });
  }

  protected edit(): void {
    const user = this.user();
    if (!user) {
      return;
    }
    this.clearMessages();
    this.dialogs
      .open<UserDialogResult, UserDialogData>(UserDialog, { data: { user } })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((result) => {
        if (result && 'saved' in result) {
          this.user.set(result.saved);
          this.toasts.show({ tone: 'success', message: 'Usuário salvo.' });
        } else if (result && 'uncertain' in result) {
          this.notice.set(result.uncertain);
          this.load();
        }
      });
  }

  /** Asks first (§4.2), then runs the action. */
  protected act(action: Action): void {
    const user = this.user();
    if (!user) {
      return;
    }
    this.clearMessages();
    const texts = ACTIONS[action];
    this.dialogs
      .confirm({ title: texts.title(user.displayName), message: texts.message(user.displayName), confirmLabel: texts.confirmLabel, tone: texts.tone })
      .pipe(takeUntil(this.switched))
      .subscribe((confirmed) => confirmed && this.run(action, user.id, user.username));
  }

  private run(action: Action, id: string, username: string): void {
    this.busy.set(action);
    this.actionError.set(null);
    const request: Observable<string | void> = action === 'reset' ? this.api.resetPassword(id) : this.api[action](id);
    request.pipe(takeUntil(this.switched)).subscribe({
      next: (password) => {
        this.busy.set(null);
        this.load(id);
        const done = ACTIONS[action].done;
        if (done) {
          this.toasts.show({ tone: 'success', message: done });
        } else {
          showTemporaryPassword(this.dialogs, username, password as string);
        }
      },
      error: (error: unknown) => {
        this.busy.set(null);
        const problem = isApiProblem(error) ? error : null;
        this.actionError.set(
          problem && offersRetry(problem)
            ? { text: ACTIONS[action].unconfirmed, retry: () => this.run(action, id, username) }
            : { text: messageFor(problem?.code ?? 'unexpected') },
        );
      },
    });
  }

  private open(id: string): void {
    this.switched.next();
    this.user.set(null);
    this.loadError.set(null);
    this.busy.set(null);
    this.clearMessages();
    this.load(id);
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
