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
import { Bot, BotsApi } from '../bots/bots-api';
import { AddMemberData, AddMemberDialog, AddMemberResult } from './add-member-dialog';
import { GroupDialog, GroupDialogData, GroupDialogResult } from './group-dialog';
import { GroupsApi, Member, VersionedGroup } from './groups-api';

/**
 * A group's page (admin-ui.md §5.2, A2): the name and description, **Modelagem**, the members, and **Arquivar** or
 * **Desarquivar**. The members are marked *Bot* by the bots list, since a member's view doesn't say. Each change reads the
 * group again; a lost answer offers **Tentar de novo**, which repeats it without asking, as each is safe to repeat. The page
 * starts afresh when the route moves to another group.
 */
@Component({
  selector: 'chain-group-page',
  imports: [Alert, Button, RouterLink],
  templateUrl: './group-page.html',
  styleUrls: ['../admin-table.css', './group-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupPage {
  readonly id = input.required<string>();
  private readonly api = inject(GroupsApi);
  private readonly botsApi = inject(BotsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly group = signal<VersionedGroup | null>(null);
  private readonly bots = signal<readonly Bot[]>([]);
  protected readonly loadError = signal<{ readonly text: string; readonly retry: boolean } | null>(null);
  /** What the page could not confirm after a retry. */
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly busy = signal(false);
  protected readonly countText = computed(() => {
    const count = this.group()?.members.length ?? 0;
    return count === 1 ? '1 membro' : `${count} membros`;
  });
  private readonly botIds = computed(() => new Set(this.bots().map((bot) => bot.id)));
  /** Ends what was started for the previous group (card #187). */
  private readonly switched = new Subject<void>();

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
    inject(DestroyRef).onDestroy(() => this.switched.next());
  }

  /** A member's states (§5.2): *Bot*, and *Inativo*, when they apply. */
  protected states(member: Member): string[] {
    return [this.botIds().has(member.id) ? 'Bot' : null, member.isActive ? null : 'Inativo'].filter((state): state is string => state !== null);
  }

  protected load(id: string = this.id()): void {
    this.api
      .get(id)
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: (group) => {
          this.group.set(group);
          this.loadError.set(null);
        },
        error: (error: unknown) => {
          const problem = isApiProblem(error) ? error : null;
          this.loadError.set(problem?.status === 404 ? { text: 'Este grupo não existe.', retry: false } : { text: messageFor(problem?.code ?? 'unexpected'), retry: true });
        },
      });
  }

  protected edit(): void {
    const group = this.group();
    if (!group) {
      return;
    }
    this.clearMessages();
    this.dialogs
      .open<GroupDialogResult, GroupDialogData>(GroupDialog, { data: { group } })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((result) => {
        if (result && 'saved' in result) {
          this.group.set(result.saved);
          this.toasts.show({ tone: 'success', message: 'Grupo salvo.' });
        } else if (result && 'uncertain' in result) {
          this.notice.set(result.uncertain);
          this.load();
        }
      });
  }

  /** **Modelagem** (§5.2): grants or revokes at once; a refusal puts the box back. */
  protected toggleModeler(event: Event): void {
    const box = event.target as HTMLInputElement;
    const granted = box.checked;
    const id = this.id();
    this.clearMessages();
    this.run(
      () => this.api.setModeler(id, granted),
      granted ? 'Modelagem concedida.' : 'Modelagem retirada.',
      'Não foi possível confirmar a mudança na modelagem.',
      () => (box.checked = this.group()?.isModeler ?? false),
    );
  }

  protected remove(member: Member): void {
    const id = this.id();
    this.ask(`Remover ${member.displayName} do grupo?`, 'Quem sai do grupo deixa de poder executar as tarefas dele na hora.', 'Remover', 'danger', () =>
      this.run(() => this.api.removeMember(id, member.id), 'Membro removido.', 'Não foi possível confirmar a remoção.'),
    );
  }

  protected archive(): void {
    const group = this.group();
    if (!group) {
      return;
    }
    if (group.isArchived) {
      this.ask(
        `Desarquivar ${group.name}?`,
        'O grupo volta a receber membros e a poder ser usado em novas versões. Se ele modela, os membros recuperam a modelagem.',
        'Desarquivar',
        'primary',
        () => this.run(() => this.api.unarchive(group.id), 'Grupo desarquivado.', 'Não foi possível confirmar o desarquivamento.'),
      );
    } else {
      this.ask(
        `Arquivar ${group.name}?`,
        'O grupo não recebe novos membros e não pode ser usado em novas versões. As tarefas já atribuídas a ele continuam. Se ele modela, os membros perdem a modelagem até o grupo ser desarquivado.',
        'Arquivar',
        'danger',
        () => this.run(() => this.api.archive(group.id), 'Grupo arquivado.', 'Não foi possível confirmar o arquivamento.'),
      );
    }
  }

  protected addMember(): void {
    const group = this.group();
    if (!group) {
      return;
    }
    this.clearMessages();
    this.dialogs
      .open<AddMemberResult, AddMemberData>(AddMemberDialog, { data: { group, bots: this.bots() } })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((result) => {
        if (result) {
          this.toasts.show({ tone: 'success', message: 'Membro adicionado.' });
          this.load();
        }
      });
  }

  private ask(title: string, message: string, confirmLabel: string, tone: 'primary' | 'danger', then: () => void): void {
    this.clearMessages();
    this.dialogs
      .confirm({ title, message, confirmLabel, tone })
      .pipe(takeUntil(this.switched))
      .subscribe((confirmed) => confirmed && then());
  }

  private run(request: () => Observable<void>, done: string, unconfirmed: string, revert?: () => void): void {
    const id = this.id();
    this.busy.set(true);
    this.actionError.set(null);
    request()
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toasts.show({ tone: 'success', message: done });
          this.load(id);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          revert?.();
          const problem = isApiProblem(error) ? error : null;
          this.actionError.set(
            problem && offersRetry(problem) ? { text: unconfirmed, retry: () => this.run(request, done, unconfirmed, revert) } : { text: messageFor(problem?.code ?? 'unexpected') },
          );
        },
      });
  }

  private open(id: string): void {
    this.switched.next();
    this.group.set(null);
    this.loadError.set(null);
    this.busy.set(false);
    this.clearMessages();
    this.botsApi
      .list()
      .pipe(takeUntil(this.switched))
      .subscribe({ next: (bots) => this.bots.set(bots), error: () => this.bots.set([]) });
    this.load(id);
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
