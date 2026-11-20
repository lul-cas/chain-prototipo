import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { ConditionBuilder } from '../editor/condition-builder';
import { CatalogEntry, Group, toJson, toRows } from '../editor/conditions';

export interface ConditionDialogData {
  /** *Mostrar quando* or *Obrigatório quando*. */
  readonly title: string;
  /** The stored ADR-0003 tree, or undefined for none. */
  readonly condition: unknown;
  /** This form's fields (`catalogOf`). */
  readonly catalog: readonly CatalogEntry[];
}

/** What Aplicar gives: the tree, or undefined when no comparison is left, which removes the condition. */
export interface ConditionResult {
  readonly json: unknown;
}

const EMPTY = { kind: 'group', op: 'and', items: [] };

/**
 * A component's condition (form-designer.md §12.5), built with the workflow editor's condition builder (expression-language.md
 * §6) on this form's fields, or on a path into the request's data (*Outro dado do pedido*).
 */
@Component({
  selector: 'chain-condition-dialog',
  imports: [Alert, Button, ConditionBuilder, DialogLayout],
  template: `
    <chain-dialog [title]="data.title">
      <chain-condition-builder [(rows)]="rows" [catalog]="data.catalog" [otherData]="true" />
      @if (incomplete()) {
        <chain-alert tone="danger">Complete ou remova as condições incompletas.</chain-alert>
      }
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="button" (click)="apply()">Aplicar</button>
      </div>
    </chain-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConditionDialog {
  protected readonly ref = inject<DialogRef<ConditionResult>>(DialogRef);
  protected readonly data = inject<ConditionDialogData>(DIALOG_DATA);
  protected readonly rows = signal<Group>(toRows(this.data.condition ?? EMPTY));
  protected readonly incomplete = signal(false);

  protected apply(): void {
    const rows = this.rows();
    if (rows.items.length === 0) {
      this.ref.close({ json: undefined });
      return;
    }
    const written = toJson(rows);
    if ('incomplete' in written) {
      this.incomplete.set(true);
      return;
    }
    this.ref.close({ json: written.json });
  }
}
