import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Button } from '../../../ui/button/button';
import { Input } from '../../../ui/form-field/input';
import {
  CatalogEntry,
  Comparison,
  Group,
  OPERATOR_LABEL,
  Offset,
  OffsetUnit,
  Operand,
  Operator,
  Problem,
  Row,
  addAt,
  isUnary,
  literalTypeFor,
  offsetUnits,
  operatorsFor,
  problemsOf,
  removeAt,
  render,
  rightTypeFor,
  typeOf,
  updateAt,
} from './conditions';
import { OffsetEditor } from './offset-editor';
import { OperandEditor } from './operand-editor';
import { typeLabel } from './type-labels';

/** The value of the *Outro dado do pedido* choice, which no catalog path can take: keys have no `#`. */
const OTHER = '#outro';

/**
 * The condition builder (workflow-editor.md §10.7, expression-language.md §6): groups of comparisons with E or OU, each
 * comparison a datum of the catalog, an operator valid for its type, and a value of that type, another datum or a system
 * value. What it cannot edit is shown as text and kept. Problems are shown next to their row, and a preview renders it all.
 */
@Component({
  selector: 'chain-condition-builder',
  imports: [Button, Input, NgTemplateOutlet, OffsetEditor, OperandEditor],
  templateUrl: './condition-builder.html',
  styleUrl: './condition-builder.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConditionBuilder {
  /** The condition being built; the panel writes it back on "Aplicar". */
  readonly rows = model.required<Group>();
  /** The data at the gateway (workflow-definition.md §6.5). */
  readonly catalog = input<readonly CatalogEntry[]>([]);
  /**
   * *Outro dado do pedido* (form-designer.md §12.5): a comparison may start from a path into the request's data that the
   * catalog lacks, typed `unknown`, instead of being kept as text. The form designer allows it, since a form's conditions can
   * read the request's data (ADR-0009).
   */
  readonly otherData = input(false);

  protected readonly operatorLabel = OPERATOR_LABEL;
  protected readonly other = OTHER;
  /** The data a comparison can start from: objects can't be compared. */
  protected readonly entries = computed(() => this.catalog().filter((entry) => entry.type !== 'object'));
  protected readonly problems = computed(() => problemsOf(this.rows(), this.catalog()));
  private readonly known = computed(() => new Set(this.entries().map((entry) => this.entryValue(entry))));
  protected readonly preview = computed(() => render(this.rows()));

  protected child(place: readonly number[], index: number): number[] {
    return [...place, index];
  }

  protected key(place: readonly number[]): string {
    return place.join('.');
  }

  protected problem(place: readonly number[]): Problem | null {
    return this.problems().get(this.key(place)) ?? null;
  }

  protected problemText(problem: Problem): string {
    return 'error' in problem ? problem.error : problem.warning;
  }

  protected entryValue(entry: CatalogEntry): string {
    return entry.path.join('.');
  }

  protected entryLabel(entry: CatalogEntry): string {
    return `${entry.path.join('.').replace(/\.\[\]/g, '[]')} (${typeLabel(entry.type)})`;
  }

  protected pathValue(operand: Operand | null): string {
    return this.isOther(operand) ? OTHER : operand?.kind === 'path' ? operand.path.join('.') : '';
  }

  /** A left datum outside the catalog, allowed with `otherData`: the request's data, or one chosen but not typed yet. */
  protected isOther(operand: Operand | null): boolean {
    return this.otherData() && operand?.kind === 'path' && !this.known().has(operand.path.join('.'));
  }

  protected otherText(operand: Operand | null): string {
    return operand?.kind === 'path' ? operand.path.join('.') : '';
  }

  /** The path typed for *Outro dado do pedido*, as dot-separated keys. */
  protected setOtherPath(place: readonly number[], event: Event): void {
    const path = (event.target as HTMLInputElement).value.split('.').map((segment) => segment.trim()).filter((segment) => segment !== '');
    this.change(place, (row) => ({ ...(row as Comparison), left: { kind: 'path', path } }));
  }

  /**
   * A comparison shown as text and kept (§10.7, §10.8): an operand the builder doesn't edit, a datum the catalog lacks, or
   * an offset in a unit the operand's type doesn't take.
   */
  protected isKept(row: Comparison): boolean {
    return [row.left, row.right].some((operand) => {
      const offset = this.offsetOf(operand);
      return (
        operand?.kind === 'kept' ||
        (operand?.kind === 'path' && operand.path.length > 0 && !this.known().has(operand.path.join('.')) && !(operand === row.left && this.otherData())) ||
        (offset !== null && !this.unitsOf(operand).includes(offset.unit))
      );
    });
  }

  /** The units a datum's or a system value's adjustment offers, by its type (§10.8); none when it takes no adjustment. */
  protected unitsOf(operand: Operand | null): readonly OffsetUnit[] {
    if (operand?.kind === 'system') {
      return offsetUnits(operand.name === 'currentDate' ? 'date' : 'datetime');
    }
    return operand?.kind === 'path' && operand.path.length > 0 ? offsetUnits(typeOf(operand, this.catalog())) : [];
  }

  protected offsetOf(operand: Operand | null): Offset | null {
    return operand?.kind === 'path' || operand?.kind === 'system' ? (operand.offset ?? null) : null;
  }

  protected render(row: Row): string {
    return render(row);
  }

  protected leftType(row: Comparison): string {
    return row.left ? typeOf(row.left, this.catalog()) : 'unknown';
  }

  protected operatorsOf(row: Comparison): Operator[] {
    return operatorsFor(this.leftType(row));
  }

  protected isUnary(operator: Operator | null): boolean {
    return operator !== null && isUnary(operator);
  }

  /** The type a comparison's value should have: the left's, or its elements' for `contains`. */
  protected rightType(row: Comparison): string {
    return rightTypeFor(this.leftType(row));
  }

  protected setOp(place: readonly number[], event: Event): void {
    const op = (event.target as HTMLSelectElement).value === 'or' ? 'or' : 'and';
    this.change(place, (row) => ({ ...(row as Group), op }));
  }

  protected add(place: readonly number[], what: 'compare' | 'group'): void {
    const row: Row = what === 'group' ? { kind: 'group', op: 'and', items: [] } : { kind: 'compare', left: null, operator: null, right: null };
    this.rows.set(addAt(this.rows(), place, row));
  }

  protected remove(place: readonly number[]): void {
    this.rows.set(removeAt(this.rows(), place));
  }

  /** A new left side keeps the operator if its type allows it, and the right side if the type is the same. */
  protected setLeft(place: readonly number[], event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.change(place, (row) => {
      const current = row as Comparison;
      const before = this.leftType(current);
      const left: Operand | null = value === OTHER ? { kind: 'path', path: [] } : value ? { kind: 'path', path: value.split('.') } : null;
      const next = { ...current, left };
      const type = this.leftType(next);
      const operator = current.operator && operatorsFor(type).includes(current.operator) ? current.operator : null;
      return { ...next, operator, right: type === before ? current.right : null };
    });
  }

  /** A binary operator starts with an empty value of the left's type; a unary one takes none. */
  protected setOperator(place: readonly number[], event: Event): void {
    const operator = ((event.target as HTMLSelectElement).value || null) as Operator | null;
    this.change(place, (row) => {
      const current = row as Comparison;
      const right = operator === null || isUnary(operator) ? null : (current.right ?? { kind: 'literal', type: literalTypeFor(this.rightType(current)), value: '' });
      return { ...current, operator, right };
    });
  }

  protected setRight(place: readonly number[], right: Operand | null): void {
    this.change(place, (row) => ({ ...(row as Comparison), right }));
  }

  protected setLeftOffset(place: readonly number[], offset: Offset | null): void {
    this.change(place, (row) => {
      const current = row as Comparison;
      return current.left?.kind === 'path' ? { ...current, left: offset ? { kind: 'path', path: current.left.path, offset } : { kind: 'path', path: current.left.path } } : current;
    });
  }

  private change(place: readonly number[], change: (row: Row) => Row): void {
    this.rows.set(updateAt(this.rows(), place, change));
  }
}
