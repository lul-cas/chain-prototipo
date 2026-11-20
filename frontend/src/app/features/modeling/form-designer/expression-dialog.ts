import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { parseValue } from '../../../expression';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { CatalogEntry, valueText } from '../editor/conditions';
import { typeLabel } from '../editor/type-labels';
import { ValueBuilder } from './value-builder';
import { inferType } from './value-types';

export interface ExpressionDialogData {
  readonly title: string;
  /** The stored value tree, or undefined. */
  readonly expression: unknown;
  /** This form's fields (`catalogOf`). */
  readonly catalog: readonly CatalogEntry[];
}

/** What Aplicar gives: a value tree the parser accepts (FM007). */
export interface ExpressionResult {
  readonly json: unknown;
}

/**
 * A computed field's expression (form-designer.md §12.6, Q-FD6 (a)): the value builder, the tree's text form for reading,
 * and the type it produces. Aplicar takes only a tree the expression parser accepts, so the field passes FM007.
 */
@Component({
  selector: 'chain-expression-dialog',
  imports: [Alert, Button, DialogLayout, ValueBuilder],
  template: `
    <chain-dialog [title]="data.title">
      <chain-value-builder [(value)]="value" [catalog]="data.catalog" label="Expressão" />
      <p class="chain-expression__text" data-testid="expression-text">{{ text() }}</p>
      <p class="chain-expression__type">Produz: {{ type() }}</p>
      @if (invalid()) {
        <chain-alert tone="danger">Complete a expressão.</chain-alert>
      }
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="button" (click)="apply()">Aplicar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-expression__text {
      margin-block: var(--chain-space-3) 0;
      font-family: var(--chain-font-mono);
      overflow-wrap: anywhere;
    }

    .chain-expression__type {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpressionDialog {
  protected readonly ref = inject<DialogRef<ExpressionResult>>(DialogRef);
  protected readonly data = inject<ExpressionDialogData>(DIALOG_DATA);
  protected readonly value = signal<unknown>(this.data.expression);
  protected readonly invalid = signal(false);
  protected readonly text = computed(() => (this.value() === undefined ? '' : valueText(this.value())));
  protected readonly type = computed(() => typeLabel(inferType(this.value())));

  protected apply(): void {
    const value = this.value();
    const valid = typeof value === 'object' && value !== null && parseValue(value).ok;
    this.invalid.set(!valid);
    if (valid) {
      this.ref.close({ json: value });
    }
  }
}
