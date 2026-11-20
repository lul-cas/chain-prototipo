import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { WorkflowLane } from '../workflow-document';
import { WorkflowsApi } from '../workflows-api';
import { LaneProperties } from '../../../diagram/edits';

export interface LanePanelData {
  readonly lane: WorkflowLane;
}

const REQUESTERS = 'requesters';
/** As a node's label (WF012). */
const TITLE_LIMIT = 120;

/**
 * "Propriedades da Área" (workflow-editor.md §5, §10.6): a lane's title, and the group responsible for its steps, the
 * requesters or one of the active groups. It closes with the properties on "Aplicar", or with nothing.
 */
@Component({
  selector: 'chain-lane-panel',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog title="Propriedades da Área">
      <form id="chain-lane-panel" class="chain-lane-panel" (submit)="apply($event)">
        <chain-form-field label="Rótulo" required [error]="titleError()">
          <input chainInput type="text" [maxLength]="titleLimit" [value]="title()" (input)="title.set(typed($event)); titleError.set(null)" />
        </chain-form-field>
        <chain-form-field label="Grupo" hint="Grupo responsável pelas etapas nesta área.">
          <select chainInput [disabled]="groups() === null" (change)="group.set(typed($event))">
            @if (unavailable()) {
              <option [value]="group()" [selected]="true">Grupo indisponível</option>
            }
            <option [value]="requesters" [selected]="group() === requesters">Solicitantes</option>
            @for (option of groups() ?? []; track option.id) {
              <option [value]="option.id" [selected]="option.id === group()">{{ option.name }}</option>
            }
          </select>
        </chain-form-field>
        @if (error(); as message) {
          <chain-alert tone="danger">{{ message }}</chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-lane-panel">Aplicar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-lane-panel {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanePanel {
  protected readonly ref = inject<DialogRef<LaneProperties>>(DialogRef);
  private readonly lane = inject<LanePanelData>(DIALOG_DATA).lane;
  private readonly api = inject(WorkflowsApi);

  protected readonly requesters = REQUESTERS;
  protected readonly titleLimit = TITLE_LIMIT;
  protected readonly title = signal(this.lane.title);
  /** The requesters, or a group's id. */
  protected readonly group = signal(this.lane.group?.kind === 'group' ? this.lane.group.groupId : REQUESTERS);
  protected readonly titleError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly groups = signal<readonly { readonly id: string; readonly name: string }[] | null>(null);
  /** The lane's own group, while it is archived or gone: shown as such until another is chosen (§10.6). */
  protected readonly unavailable = computed(() => {
    const groups = this.groups();
    const current = this.group();
    return groups !== null && current !== REQUESTERS && !groups.some((group) => group.id === current);
  });

  constructor() {
    this.api.groups().subscribe({
      next: (groups) => this.groups.set(groups),
      error: () => {
        this.groups.set([]);
        this.error.set('Não foi possível carregar os grupos.');
      },
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const title = this.title().trim();
    if (!title) {
      this.titleError.set('Informe o rótulo.');
      return;
    }
    const group = this.group();
    this.ref.close({ title, group: group === REQUESTERS ? { kind: 'requesters' } : { kind: 'group', groupId: group } });
  }
}
