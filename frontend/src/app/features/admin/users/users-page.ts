import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { showTemporaryPassword } from './temporary-password';
import { UserDialog, UserDialogData, UserDialogResult } from './user-dialog';
import { userStates } from './user-rules';
import { PAGE_SIZE, User, UserPage, UsersApi } from './users-api';

/** How long typing must stop before the search is sent (admin-ui.md §4.1). */
const SEARCH_DELAY_MS = 300;

interface Query {
  readonly search: string;
  readonly offset: number;
}

/**
 * *Usuários* (admin-ui.md §4.1, A1), for admins: a table of 50 per page with a search by name or username, sent once
 * typing stops. Only the answer to the latest query is shown. **Novo usuário** creates one and shows its temporary
 * password once (§4.3).
 */
@Component({
  selector: 'chain-users-page',
  imports: [Alert, Button, RouterLink],
  templateUrl: './users-page.html',
  styleUrls: ['../admin-table.css', './users-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersPage {
  private readonly api = inject(UsersApi);
  private readonly dialogs = inject(DialogService);

  protected readonly search = signal('');
  protected readonly page = signal<UserPage | null>(null);
  /** The offset of the page shown, which changes when its answer arrives. */
  protected readonly offset = signal(0);
  protected readonly loadError = signal<string | null>(null);
  /** What the page could not confirm after a retry. */
  protected readonly notice = signal<string | null>(null);

  protected readonly countText = computed(() => {
    const total = this.page()?.total ?? 0;
    return total === 1 ? '1 usuário' : `${total} usuários`;
  });
  protected readonly paged = computed(() => (this.page()?.total ?? 0) > PAGE_SIZE);
  protected readonly hasPrevious = computed(() => this.offset() > 0);
  protected readonly hasNext = computed(() => this.offset() + PAGE_SIZE < (this.page()?.total ?? 0));
  protected readonly rangeText = computed(() => {
    const total = this.page()?.total ?? 0;
    return `${this.offset() + 1}–${Math.min(this.offset() + PAGE_SIZE, total)} de ${total}`;
  });

  private readonly queries = new Subject<Query>();
  private lastQuery: Query = { search: '', offset: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.queries
      .pipe(
        switchMap((query) =>
          this.api.list(query.search, query.offset).pipe(
            map((page) => ({ query, page })),
            catchError((error: unknown) => of({ query, error })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((answer) => {
        if ('page' in answer) {
          this.page.set(answer.page);
          this.offset.set(answer.query.offset);
          this.loadError.set(null);
        } else {
          this.loadError.set(messageFor(isApiProblem(answer.error) ? answer.error.code : 'unexpected'));
        }
      });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    this.fetch(0);
  }

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fetch(0), SEARCH_DELAY_MS);
  }

  protected previous(): void {
    this.fetch(Math.max(0, this.offset() - PAGE_SIZE));
  }

  protected next(): void {
    this.fetch(this.offset() + PAGE_SIZE);
  }

  /** Tentar de novo, or after a change: the last query again. */
  protected reload(): void {
    this.queries.next(this.lastQuery);
  }

  protected states(user: User): string[] {
    return userStates(user);
  }

  protected create(): void {
    this.notice.set(null);
    this.dialogs
      .open<UserDialogResult, UserDialogData>(UserDialog, { data: { user: null } })
      .closed.subscribe((result) => {
        if (!result) {
          return;
        }
        this.reload();
        if ('created' in result) {
          showTemporaryPassword(this.dialogs, result.created.user.username, result.created.temporaryPassword);
        } else if ('uncertain' in result) {
          this.notice.set(result.uncertain);
        }
      });
  }

  private fetch(offset: number): void {
    this.lastQuery = { search: this.search().trim(), offset };
    this.queries.next(this.lastQuery);
  }
}
