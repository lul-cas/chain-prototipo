import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Observable, forkJoin } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { Capability, GrantInput, ProcessGrant, WorkflowsApi } from '../workflows-api';

export interface PermissionsPanelData {
  readonly processId: string;
  /** The process's `ETag` as the editor holds it: grants share it (admin-ui.md §8, S-A2). */
  readonly etag: string;
}

/** What the panel closes with: the process's new `ETag` once applied, or, after a retry it could not confirm, what to say. */
export type PermissionsResult = { readonly etag: string } | { readonly uncertain: string };

interface Row {
  readonly groupId: string;
  readonly groupName: string;
  readonly capabilities: ReadonlySet<Capability>;
}

/** The capabilities in the order of the columns and of what **Aplicar** sends (admin-ui.md §7). */
const CAPABILITIES: readonly { readonly key: Capability; readonly label: string }[] = [
  { key: 'start', label: 'Iniciar' },
  { key: 'view', label: 'Ver' },
  { key: 'close', label: 'Encerrar' },
  { key: 'comment', label: 'Comentar' },
  { key: 'viewSensitive', label: 'Ver dados sensíveis' },
];

/** The warning of sensitive-data.md §3, whenever *Ver dados sensíveis* is checked (Q-AD4 (a)). */
const SENSITIVE_WARNING = 'Se um bot deste grupo for usado por um agente de IA, os valores sensíveis irão para o provedor do agente.';
const UNCONFIRMED = 'Não foi possível confirmar se as permissões foram aplicadas. Abra Permissões de novo para conferir.';

/**
 * **Permissões** (admin-ui.md §7, A3), in the workflow editor's side panel (Q-AD3 (a)): one row per group and one box per
 * capability. **Aplicar** sends the whole list with the editor's `If-Match`, dropping rows without a capability, and closes
 * with the process's new `ETag`, so the editor saves its draft next without reloading. A lost answer offers **Tentar de
 * novo** with the same request; a 412 then may be the first attempt's doing.
 */
@Component({
  selector: 'chain-permissions-panel',
  imports: [Alert, Button, DialogLayout],
  template: `
    <chain-dialog title="Permissões">
      <div class="chain-permissions">
        <p class="chain-permissions__muted">Os grupos das áreas não precisam de permissão para executar as tarefas da própria área.</p>
        @if (loadError(); as message) {
          <chain-alert tone="danger">{{ message }}</chain-alert>
        } @else if (rows(); as list) {
          @if (list.length === 0) {
            <p class="chain-permissions__muted">Nenhum grupo tem permissões neste processo.</p>
          } @else {
            <div class="chain-permissions__scroll">
              <table class="chain-permissions__table">
                <caption class="chain-visually-hidden">Permissões por grupo</caption>
                <thead>
                  <tr>
                    <th scope="col">Grupo</th>
                    @for (capability of capabilities; track capability.key) {
                      <th scope="col">{{ capability.label }}</th>
                    }
                    <th scope="col"><span class="chain-visually-hidden">Ações</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of list; track row.groupId) {
                    <tr>
                      <th scope="row">
                        <span class="chain-permissions__group">
                          <span>{{ row.groupName }}</span>
                          @if (!activeIds().has(row.groupId)) {
                            <span class="chain-permissions__note">Arquivado ou removido</span>
                          }
                        </span>
                      </th>
                      @for (capability of capabilities; track capability.key) {
                        <td class="chain-permissions__box">
                          <input
                            type="checkbox"
                            [attr.aria-label]="capability.label + ' — ' + row.groupName"
                            [checked]="row.capabilities.has(capability.key)"
                            (change)="toggle(row.groupId, capability.key, $event)"
                          />
                        </td>
                      }
                      <td>
                        <button
                          chainButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          [attr.aria-label]="'Remover ' + row.groupName + ' das permissões'"
                          (click)="remove(row.groupId)"
                        >
                          Remover
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (sensitiveGroups().length > 0) {
            <chain-alert tone="warning">
              <ul class="chain-permissions__warnings">
                @for (name of sensitiveGroups(); track name) {
                  <li>{{ name + ': ' + sensitiveWarning }}</li>
                }
              </ul>
            </chain-alert>
          }
          <div class="chain-permissions__add">
            <select #pick class="chain-input" aria-label="Grupo a adicionar" [disabled]="addable().length === 0">
              @for (group of addable(); track group.id) {
                <option [value]="group.id">{{ group.name }}</option>
              }
            </select>
            <button chainButton variant="secondary" size="sm" type="button" [disabled]="addable().length === 0" (click)="add(pick.value)">
              Adicionar grupo
            </button>
          </div>
        }
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-permissions__inline">
              {{ current.text }}
              @if (current.retry) {
                <button chainButton variant="secondary" size="sm" type="button" (click)="current.retry()">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
      </div>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="button" [loading]="saving()" [disabled]="rows() === null" (click)="apply()">Aplicar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-permissions {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-permissions__muted {
      margin: 0;
      color: var(--color-text-muted);
    }

    .chain-permissions__scroll {
      overflow-x: auto;
    }

    .chain-permissions__table {
      width: 100%;
      border-collapse: collapse;
    }

    .chain-permissions__table th,
    .chain-permissions__table td {
      padding: var(--chain-space-2);
      border-bottom: var(--chain-border-width) solid var(--color-border-subtle);
      text-align: start;
      vertical-align: middle;
    }

    .chain-permissions__table thead th {
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
      font-weight: var(--chain-font-weight-semibold);
    }

    .chain-permissions__table tbody th {
      font-weight: var(--chain-font-weight-regular);
    }

    .chain-permissions__table .chain-permissions__box {
      text-align: center;
    }

    .chain-permissions__group {
      display: flex;
      flex-direction: column;
    }

    .chain-permissions__note {
      color: var(--color-status-warning-text);
      font-size: var(--chain-font-size-sm);
    }

    .chain-permissions__warnings {
      margin: 0;
      padding-inline-start: var(--chain-space-4);
    }

    .chain-permissions__add,
    .chain-permissions__inline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionsPanel {
  protected readonly ref = inject<DialogRef<PermissionsResult>>(DialogRef);
  private readonly data = inject<PermissionsPanelData>(DIALOG_DATA);
  private readonly api = inject(WorkflowsApi);

  protected readonly capabilities = CAPABILITIES;
  protected readonly sensitiveWarning = SENSITIVE_WARNING;
  protected readonly rows = signal<readonly Row[] | null>(null);
  /** The active groups, which `GET /api/workflows/groups` lists (workflow-definition.md §5.5). */
  private readonly groups = signal<readonly { readonly id: string; readonly name: string }[]>([]);
  protected readonly activeIds = computed(() => new Set(this.groups().map((group) => group.id)));
  protected readonly addable = computed(() => {
    const listed = new Set((this.rows() ?? []).map((row) => row.groupId));
    return this.groups().filter((group) => !listed.has(group.id));
  });
  protected readonly sensitiveGroups = computed(() =>
    (this.rows() ?? []).filter((row) => row.capabilities.has('viewSensitive')).map((row) => row.groupName),
  );
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);

  constructor() {
    forkJoin([this.api.grants(this.data.processId), this.api.groups()]).subscribe({
      next: ([grants, groups]) => {
        this.groups.set(groups);
        this.rows.set(grants.map(toRow));
      },
      error: (error: unknown) => this.loadError.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }

  protected toggle(groupId: string, capability: Capability, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.rows.update((rows) =>
      (rows ?? []).map((row) => {
        if (row.groupId !== groupId) {
          return row;
        }
        const capabilities = new Set(row.capabilities);
        if (checked) {
          capabilities.add(capability);
        } else {
          capabilities.delete(capability);
        }
        return { ...row, capabilities };
      }),
    );
  }

  protected remove(groupId: string): void {
    this.rows.update((rows) => (rows ?? []).filter((row) => row.groupId !== groupId));
  }

  protected add(groupId: string): void {
    const group = this.groups().find((candidate) => candidate.id === groupId);
    if (group) {
      this.rows.update((rows) => [...(rows ?? []), { groupId: group.id, groupName: group.name, capabilities: new Set<Capability>() }]);
    }
  }

  protected apply(): void {
    const grants: GrantInput[] = (this.rows() ?? [])
      .filter((row) => row.capabilities.size > 0)
      .map((row) => ({ groupId: row.groupId, capabilities: CAPABILITIES.map((capability) => capability.key).filter((key) => row.capabilities.has(key)) }));
    this.send(() => this.api.replaceGrants(this.data.processId, this.data.etag, grants), false);
  }

  private send(request: () => Observable<{ readonly etag: string }>, retried: boolean): void {
    this.saving.set(true);
    this.alert.set(null);
    request().subscribe({
      next: (answer) => this.ref.close({ etag: answer.etag }),
      error: (error: unknown) => {
        this.saving.set(false);
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.alert.set({ text: 'Não foi possível confirmar a aplicação.', retry: () => this.send(request, true) });
        } else if (retried && problem?.status === 412) {
          this.ref.close({ uncertain: UNCONFIRMED });
        } else if (problem?.code === 'invalid_grants') {
          this.alert.set({ text: 'Um dos grupos foi arquivado ou removido. Remova-o e aplique de novo.' });
        } else {
          this.alert.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }
}

function toRow(grant: ProcessGrant): Row {
  return { groupId: grant.groupId, groupName: grant.groupName, capabilities: new Set(grant.capabilities) };
}
