import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { GroupDialog, GroupDialogData, GroupDialogResult } from './group-dialog';
import { GroupSummary, GroupsApi } from './groups-api';

/**
 * *Grupos* (admin-ui.md §5.1, A2), for admins: a table of the groups, with the archived ones on **Mostrar arquivados**. Only
 * the answer to the latest choice is shown. **Novo grupo** asks for the name and the description.
 */
@Component({
  selector: 'chain-groups-page',
  imports: [Alert, Button, RouterLink],
  templateUrl: './groups-page.html',
  styleUrls: ['../admin-table.css', './groups-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupsPage {
  private readonly api = inject(GroupsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly includeArchived = signal(false);
  protected readonly groups = signal<readonly GroupSummary[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** What the page could not confirm after a retry. */
  protected readonly notice = signal<string | null>(null);
  private readonly queries = new Subject<boolean>();

  constructor() {
    this.queries
      .pipe(
        switchMap((includeArchived) =>
          this.api.list(includeArchived).pipe(
            map((groups) => ({ groups })),
            catchError((error: unknown) => of({ error })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((answer) => {
        if ('groups' in answer) {
          this.groups.set(answer.groups);
          this.loadError.set(null);
        } else {
          this.loadError.set(messageFor(isApiProblem(answer.error) ? answer.error.code : 'unexpected'));
        }
      });
    this.reload();
  }

  protected toggleArchived(event: Event): void {
    this.includeArchived.set((event.target as HTMLInputElement).checked);
    this.reload();
  }

  /** Tentar de novo, or after a change: the current choice again. */
  protected reload(): void {
    this.queries.next(this.includeArchived());
  }

  protected create(): void {
    this.notice.set(null);
    this.dialogs
      .open<GroupDialogResult, GroupDialogData>(GroupDialog, { data: { group: null } })
      .closed.subscribe((result) => {
        if (!result) {
          return;
        }
        this.reload();
        if ('created' in result) {
          this.toasts.show({ tone: 'success', message: 'Grupo criado.' });
        } else if ('uncertain' in result) {
          this.notice.set(result.uncertain);
        }
      });
  }
}
