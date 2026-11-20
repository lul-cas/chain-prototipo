import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Button } from '../../../ui/button/button';
import { Input } from '../../../ui/form-field/input';
import { ContractField } from '../automations-api';
import { CatalogEntry, Operand, Problem, fromOperand, valueText } from './conditions';
import { AUTOMATION_TEXTS, KeptMapping, MappingTexts, StepMappings, carriesFiles, holdsFiles, keptText, mappingProblems, typeHoldsFiles } from './mappings';
import { OperandEditor } from './operand-editor';
import { typeLabel } from './type-labels';

/**
 * A step's *Entradas* and *Saídas* (workflow-editor.md §10.9, §10.10): a value for each declared input, or free keys and values
 * for a child without a start form; the key each output is kept as; and what the step stores otherwise, shown as text.
 */
@Component({
  selector: 'chain-step-mappings',
  imports: [Button, Input, OperandEditor],
  templateUrl: './step-mappings.html',
  styleUrl: './step-mappings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StepMappingsEditor {
  readonly mappings = model.required<StepMappings>();
  /** The data at the step (workflow-definition.md §6.5). */
  readonly catalog = input<readonly CatalogEntry[]>([]);
  /** The step's own words for an input left out, or one its contract lacks. */
  readonly texts = input<MappingTexts>(AUTOMATION_TEXTS);
  /** Whether the inputs are free keys (TC-5). */
  readonly free = input(false);
  /** "obrigatória" for an automation's input, "obrigatório" for a start form's field. */
  readonly requiredWord = input('obrigatória');

  protected readonly problems = computed(() => mappingProblems(this.mappings(), this.catalog(), this.texts()));
  /** Whether the inputs can't carry files: a sub-workflow's (WF206, §10.10). */
  protected readonly refusesFiles = computed(() => this.texts().files !== undefined);
  /** The data an input may name: without the data that hold files, when the inputs can't carry them. */
  protected readonly inputCatalog = computed(() => {
    const catalog = this.catalog();
    return this.refusesFiles() ? catalog.filter((entry) => !holdsFiles(entry, catalog)) : catalog;
  });

  protected typeName(type: string): string {
    return typeLabel(type);
  }

  /** A `file` field of a sub-workflow's start form, which no input can fill (WF206). */
  protected fileField(field: ContractField): boolean {
    return this.refusesFiles() && typeHoldsFiles(field.type);
  }

  /** A value the panel shows as text: one it can't edit, or one that carries files where they can't go, until removed. */
  protected asText(value: Operand | null, field?: ContractField): boolean {
    return value !== null && (value.kind === 'kept' || (field !== undefined && this.fileField(field)) || (this.refusesFiles() && carriesFiles(value, this.catalog())));
  }

  protected problem(key: string): Problem | null {
    return this.problems().get(key) ?? null;
  }

  protected problemText(problem: Problem): string {
    return 'error' in problem ? problem.error : problem.warning;
  }

  protected keptText(mapping: KeptMapping): string {
    return keptText(mapping);
  }

  protected valueText(operand: Operand): string {
    return valueText(fromOperand(operand));
  }

  protected setInput(key: string, value: Operand | null): void {
    this.change((mappings) => ({ ...mappings, inputs: mappings.inputs.map((input) => (input.field.key === key ? { ...input, value } : input)) }));
  }

  protected setTarget(key: string, event: Event): void {
    const target = (event.target as HTMLInputElement).value;
    this.change((mappings) => ({ ...mappings, outputs: mappings.outputs.map((output) => (output.field.key === key ? { ...output, target } : output)) }));
  }

  protected removeInput(key: string): void {
    this.change((mappings) => ({ ...mappings, otherInputs: mappings.otherInputs.filter((mapping) => mapping.key !== key) }));
  }

  protected removeOutput(key: string): void {
    this.change((mappings) => ({ ...mappings, otherOutputs: mappings.otherOutputs.filter((mapping) => mapping.key !== key) }));
  }

  /** A free row starts with no key and an empty text, which it asks for (§10.10). */
  protected addFree(): void {
    this.change((mappings) => ({ ...mappings, freeInputs: [...mappings.freeInputs, { key: '', value: { kind: 'literal', type: 'text', value: '' } }] }));
  }

  protected setFreeKey(index: number, event: Event): void {
    const key = (event.target as HTMLInputElement).value;
    this.change((mappings) => ({ ...mappings, freeInputs: mappings.freeInputs.map((row, i) => (i === index ? { ...row, key } : row)) }));
  }

  protected setFreeValue(index: number, value: Operand | null): void {
    if (value !== null) {
      this.change((mappings) => ({ ...mappings, freeInputs: mappings.freeInputs.map((row, i) => (i === index ? { ...row, value } : row)) }));
    }
  }

  protected removeFree(index: number): void {
    this.change((mappings) => ({ ...mappings, freeInputs: mappings.freeInputs.filter((_, i) => i !== index) }));
  }

  private change(change: (mappings: StepMappings) => StepMappings): void {
    this.mappings.set(change(this.mappings()));
  }
}
