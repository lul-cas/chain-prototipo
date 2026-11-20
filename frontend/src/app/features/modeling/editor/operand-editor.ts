import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Input } from '../../../ui/form-field/input';
import { CatalogEntry, LiteralType, Offset, Operand, SystemName, fromZoneLocal, literalTypeFor, offsetUnits, toZoneLocal, typeOf } from './conditions';
import { OffsetEditor } from './offset-editor';
import { typeLabel } from './type-labels';

type Kind = 'none' | 'literal' | 'path' | 'system';

const LITERAL_TYPES: readonly string[] = ['text', 'number', 'boolean', 'date', 'datetime', 'time'];
const SYSTEM: Readonly<Record<SystemName, string>> = { currentDate: 'Data atual', currentDateTime: 'Data e hora atual' };

/**
 * A value of a given type (workflow-editor.md §10.7–§10.9): *Valor*, entered as its type; *Dado*, a datum of that type; or
 * *Sistema*, the current date or date and time, for dates; with an adjustment for a date or a datetime. A step's input may
 * also be *Não enviar*. Its controls join the grid of the row it is in.
 */
@Component({
  selector: 'chain-operand-editor',
  imports: [Input, OffsetEditor],
  templateUrl: './operand-editor.html',
  styles: `
    :host {
      display: contents;
    }

    .chain-operand__kind {
      grid-column-start: 1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperandEditor {
  readonly operand = model<Operand | null>(null);
  /** The type the value should have. */
  readonly type = input.required<string>();
  /** The data it may name; every one for an `unknown` type. */
  readonly catalog = input<readonly CatalogEntry[]>([]);
  /** Whether it may be left out, as *Não enviar*. */
  readonly optional = input(false);
  /** The name of the datum's select. */
  readonly pathLabel = input('Outro dado');

  protected readonly systemLabel = SYSTEM;
  protected readonly kinds = computed(() => {
    const type = this.type();
    return [
      ...(this.optional() ? [{ kind: 'none' as const, label: 'Não enviar' }] : []),
      ...(LITERAL_TYPES.includes(type) || type === 'unknown' ? [{ kind: 'literal' as const, label: 'Valor' }] : []),
      { kind: 'path' as const, label: 'Dado' },
      ...(type === 'date' || type === 'datetime' || type === 'unknown' ? [{ kind: 'system' as const, label: 'Sistema' }] : []),
    ];
  });
  protected readonly kind = computed<Kind>(() => {
    const operand = this.operand();
    return operand === null ? (this.optional() ? 'none' : 'literal') : operand.kind === 'path' || operand.kind === 'system' ? operand.kind : 'literal';
  });
  protected readonly literalType = computed<LiteralType>(() => literalTypeFor(this.type()));
  protected readonly candidates = computed(() => {
    const type = this.type();
    return this.catalog().filter((entry) => type === 'unknown' || entry.type === type);
  });
  /** The system values of its type: both for an `unknown` type, which takes any value. */
  protected readonly systemNames = computed<SystemName[]>(() =>
    this.type() === 'datetime' ? ['currentDateTime'] : this.type() === 'unknown' ? ['currentDate', 'currentDateTime'] : ['currentDate'],
  );
  /** The units its adjustment offers: none when it takes none. */
  protected readonly units = computed(() => {
    const operand = this.operand();
    if (operand?.kind === 'system') {
      return offsetUnits(operand.name === 'currentDate' ? 'date' : 'datetime');
    }
    return operand?.kind === 'path' && operand.path.length > 0 ? offsetUnits(typeOf(operand, this.catalog())) : [];
  });
  protected readonly offset = computed(() => {
    const operand = this.operand();
    return operand?.kind === 'path' || operand?.kind === 'system' ? (operand.offset ?? null) : null;
  });

  protected entryValue(entry: CatalogEntry): string {
    return entry.path.join('.');
  }

  /** A datum as the list shows it: its path and type, marked when it is sensitive (sensitive-data.md §10). */
  protected entryLabel(entry: CatalogEntry): string {
    return `${entry.path.join('.').replace(/\.\[\]/g, '[]')} (${typeLabel(entry.type)}${entry.sensitive ? ', sensível' : ''})`;
  }

  protected pathValue(): string {
    const operand = this.operand();
    return operand?.kind === 'path' ? operand.path.join('.') : '';
  }

  protected systemName(): SystemName | null {
    const operand = this.operand();
    return operand?.kind === 'system' ? operand.name : null;
  }

  protected literalValue(): string {
    const operand = this.operand();
    if (operand?.kind !== 'literal') {
      return '';
    }
    return operand.type === 'datetime' ? (toZoneLocal(operand.value) ?? '') : operand.value;
  }

  protected setKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value as Kind;
    this.operand.set(
      kind === 'none'
        ? null
        : kind === 'path'
          ? { kind: 'path', path: [] }
          : kind === 'system'
            ? { kind: 'system', name: this.systemNames()[0] }
            : { kind: 'literal', type: this.literalType(), value: '' },
    );
  }

  protected setLiteral(event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    const type = this.literalType();
    this.operand.set({ kind: 'literal', type, value: type === 'datetime' && value ? fromZoneLocal(value) : value });
  }

  /** Another datum drops the adjustment (§10.8). */
  protected setPath(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.operand.set({ kind: 'path', path: value ? value.split('.') : [] });
  }

  protected setSystem(event: Event): void {
    this.operand.set({ kind: 'system', name: (event.target as HTMLSelectElement).value as SystemName });
  }

  protected setOffset(offset: Offset | null): void {
    const operand = this.operand();
    if (operand?.kind !== 'path' && operand?.kind !== 'system') {
      return;
    }
    const bare: Operand = operand.kind === 'path' ? { kind: 'path', path: operand.path } : { kind: 'system', name: operand.name };
    this.operand.set(offset ? { ...bare, offset } : bare);
  }
}
