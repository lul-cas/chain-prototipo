import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { Bot } from '../bots/bots-api';
import { PAGE_SIZE, UserPage, UsersApi } from '../users/users-api';
import { Group, GroupsApi } from './groups-api';

export interface AddMemberData {
  readonly group: Group;
  /** Every bot, which the page has already read. */
  readonly bots: readonly Bot[];
}

/** What the dialog closes with once a member was added. */
export interface AddMemberResult {
  readonly added: string;
}

interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly kind: 'Usuário' | 'Bot';
  readonly isActive: boolean;
  readonly isMember: boolean;
}

/** How long typing must stop before the users are searched (admin-ui.md §4.1). */
const SEARCH_DELAY_MS = 300;

/**
 * *Adicionar membro* (admin-ui.md §5.2): searches the users on the server and the bots the page has, by name or identifier,
 * labelled by kind. Those already in the group are marked, and adding one closes the dialog. Adding is idempotent, so a lost
 * answer offers **Tentar de novo** with the same request.
 */
@Component({
  selector: 'chain-add-member-dialog',
  imports: [Alert, Button, DialogLayout],
  template: `
    <chain-dialog [title]="'Adicionar membro a ' + data.group.name">
      <div class="chain-add-member">
        <input
          class="chain-input"
          type="search"
          aria-label="Buscar por nome ou identificador"
          placeholder="Buscar por nome ou identificador"
          [value]="search()"
          (input)="typed($event)"
        />
        @if (failure(); as current) {
          <chain-alert tone="danger">
            <span class="chain-add-member__inline">
              {{ current.text }}
              @if (current.retry) {
                <button chainButton variant="secondary" size="sm" type="button" (click)="current.retry()">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
        @if (candidates(); as list) {
          @if (list.length === 0) {
            <p class="chain-add-member__muted">Nenhum usuário ou bot encontrado.</p>
          } @else {
            <ul class="chain-add-member__results" aria-label="Resultados">
              @for (candidate of list; track candidate.id) {
                <li class="chain-add-member__result">
                  <span class="chain-add-member__who">
                    <span>{{ candidate.name }}</span>
                    <span class="chain-add-member__muted">
                      <code>{{ candidate.username }}</code>{{ ' · ' + candidate.kind + (candidate.isActive ? '' : ' · Inativo') }}
                    </span>
                  </span>
                  @if (candidate.isMember) {
                    <span class="chain-add-member__muted">Já é membro</span>
                  } @else {
                    <button
                      chainButton
                      variant="secondary"
                      size="sm"
                      type="button"
                      [attr.aria-label]="'Adicionar ' + candidate.name + ' ao grupo'"
                      [loading]="adding() === candidate.id"
                      (click)="add(candidate)"
                    >
                      Adicionar
                    </button>
                  }
                </li>
              }
            </ul>
            @if (moreUsers()) {
              <p class="chain-add-member__muted">Só os primeiros {{ pageSize }} usuários aparecem. Refine a busca.</p>
            }
          }
        } @else {
          <p class="chain-add-member__muted">Digite parte do nome ou do identificador.</p>
        }
      </div>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Fechar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-add-member {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-add-member__results {
      display: flex;
      flex-direction: column;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-add-member__result {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--chain-space-2);
      padding: var(--chain-space-2) 0;
      border-bottom: var(--chain-border-width) solid var(--color-border-subtle);
    }

    .chain-add-member__who {
      display: flex;
      flex-direction: column;
    }

    .chain-add-member__inline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }

    .chain-add-member__muted {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddMemberDialog {
  protected readonly data = inject<AddMemberData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<AddMemberResult>>(DialogRef);
  private readonly users = inject(UsersApi);
  private readonly groups = inject(GroupsApi);

  protected readonly pageSize = PAGE_SIZE;
  protected readonly search = signal('');
  /** The users found for the latest search, or null before one. */
  private readonly found = signal<{ readonly term: string; readonly page: UserPage } | null>(null);
  protected readonly adding = signal<string | null>(null);
  protected readonly failure = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly moreUsers = computed(() => {
    const found = this.found();
    return found !== null && found.page.total > found.page.items.length;
  });
  /** The users found, then the bots whose name or identifier holds the term, by name. */
  protected readonly candidates = computed<readonly Candidate[] | null>(() => {
    const found = this.found();
    if (!found) {
      return null;
    }
    const members = new Set(this.data.group.members.map((member) => member.id));
    const term = found.term.toLocaleLowerCase('pt-BR');
    const users = found.page.items.map((user) => ({ id: user.id, name: user.displayName, username: user.username, kind: 'Usuário' as const, isActive: user.isActive }));
    const bots = [...this.data.bots]
      .filter((bot) => `${bot.displayName}\n${bot.name}`.toLocaleLowerCase('pt-BR').includes(term))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'))
      .map((bot) => ({ id: bot.id, name: bot.displayName, username: bot.name, kind: 'Bot' as const, isActive: bot.isActive }));
    return [...users, ...bots].map((candidate) => ({ ...candidate, isMember: members.has(candidate.id) }));
  });

  private readonly terms = new Subject<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.terms
      .pipe(
        switchMap((term) =>
          this.users.list(term, 0).pipe(
            map((page) => ({ term, page })),
            catchError((error: unknown) => of({ term, error })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((answer) => {
        if ('page' in answer) {
          this.found.set(answer);
          this.failure.set(null);
        } else {
          this.failure.set({ text: messageFor(isApiProblem(answer.error) ? answer.error.code : 'unexpected') });
        }
      });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected typed(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.search.set(text);
    clearTimeout(this.timer);
    if (text.trim() === '') {
      this.found.set(null);
      return;
    }
    this.timer = setTimeout(() => this.terms.next(text.trim()), SEARCH_DELAY_MS);
  }

  protected add(candidate: Candidate): void {
    this.adding.set(candidate.id);
    this.failure.set(null);
    this.groups.addMember(this.data.group.id, candidate.id).subscribe({
      next: () => this.ref.close({ added: candidate.name }),
      error: (error: unknown) => {
        this.adding.set(null);
        const problem = isApiProblem(error) ? error : null;
        this.failure.set(
          problem && offersRetry(problem)
            ? { text: 'Não foi possível confirmar a inclusão.', retry: () => this.add(candidate) }
            : { text: messageFor(problem?.code ?? 'unexpected') },
        );
      },
    });
  }
}
