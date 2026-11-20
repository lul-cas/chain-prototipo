import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ComponentType, FieldValidation } from '../../../forms/model';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { render, toRows, valueText } from '../editor/conditions';
import { ConditionDialog, ConditionDialogData, ConditionResult } from './condition-dialog';
import { ExpressionDialog, ExpressionDialogData, ExpressionResult } from './expression-dialog';
import { laterComputedReads, unmarkedSensitiveReads } from './value-tree';
import { inferType } from './value-types';
import { typeLabel } from '../editor/type-labels';
import { catalogOf } from './form-catalog';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { MAX_DESCRIPTION_LENGTH, checkForm } from './form-checks';
import { FormDraftEditor, nameOf } from './form-draft-editor';
import { ComponentChange, locate, pathOf } from './form-edits';
import { formProblemText } from './form-messages';
import { TYPE_NAME } from './form-palette';
import { OptionsChange, OptionsEditor } from './options-editor';
import { ValidationFields } from './validation-fields';

export interface PropertiesData {
  readonly editor: FormDraftEditor;
  /** The component whose properties are shown. */
  readonly id: string;
  /** Whether the form has a published version: renaming a key then warns (§8.2). */
  readonly published: boolean;
}

const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const DISPLAY = new Set<ComponentType>(['heading', 'paragraph', 'separator']);
const DATES: readonly ComponentType[] = ['date', 'time', 'datetime'];
/** The types with rules in Validação (§8.1): every field but a computed one, and lists for their rows. */
const RULED = new Set<ComponentType>(['text', 'textarea', 'number', 'date', 'time', 'datetime', 'checkbox', 'select', 'radio', 'checklist', 'file', 'dynamicList']);
const CHOICES = new Set<ComponentType>(['select', 'radio', 'checklist']);
const REQUIRABLE = new Set<ComponentType>(['text', 'textarea', 'number', 'date', 'time', 'datetime', 'checkbox', 'select', 'radio', 'checklist', 'file']);

type ConditionName = 'visibleWhen' | 'requiredWhen';
const READ_ONLY = new Set<ComponentType>(['text', 'textarea', 'number', 'checkbox', 'select', 'radio', 'checklist', 'date', 'time', 'datetime']);

/**
 * Propriedades (form-designer.md §8), in the side panel: **Geral** and **Obrigatório** (N3b-4). A change applies at once and
 * can be undone; a text property counts as one change when its field loses the focus. The local checks' problems show at
 * their property, and the key is checked as it is typed (§8.2).
 */
@Component({
  selector: 'chain-form-properties',
  imports: [Button, DialogLayout, FormField, Input, OptionsEditor, ValidationFields],
  template: `
    <chain-dialog [title]="title()">
      @if (component(); as c) {
        <details class="chain-props__group" open>
          <summary>Geral</summary>
          <div class="chain-props__fields">
            @if (producesValue()) {
              <chain-form-field label="Rótulo do campo" required [error]="labelError()">
                <input chainInput type="text" [value]="c.label ?? ''" (change)="setLabel($event)" />
              </chain-form-field>
              <chain-form-field
                label="Descrição do campo"
                [hint]="(c.description?.length ?? 0) + '/' + descriptionLimit + ' caracteres'"
                [error]="descriptionError()"
              >
                <textarea chainInput rows="2" [value]="c.description ?? ''" (change)="setOptional('description', $event)"></textarea>
              </chain-form-field>
            }
            @if (c.type === 'heading' || c.type === 'paragraph') {
              <chain-form-field label="Texto" required [error]="textError()">
                <textarea chainInput rows="2" [value]="c.text ?? ''" (change)="setText($event)"></textarea>
              </chain-form-field>
            }
            @if (producesValue()) {
              <chain-form-field label="Chave" required [hint]="keyHint()" [error]="keyError()">
                <input chainInput class="chain-mono" type="text" [value]="c.key ?? ''" (input)="typedKey.set(value($event))" (change)="setKey($event)" />
              </chain-form-field>
            }
            @if (c.type === 'text' || c.type === 'textarea' || c.type === 'number') {
              <chain-form-field label="Texto de exemplo">
                <input chainInput type="text" [value]="c.placeholder ?? ''" (change)="setOptional('placeholder', $event)" />
              </chain-form-field>
            }
            @if (c.type === 'computed') {
              <div class="chain-props__condition">
                <span class="chain-props__condition-name">Expressão</span>
                <p class="chain-props__condition-text">{{ expressionText() ?? 'Nenhuma expressão ainda (FM007).' }}</p>
                <p class="chain-props__hint">Produz: {{ expressionType() }}</p>
                @for (later of laterReads(); track later) {
                  <p class="chain-props__warning" role="note">Lê «{{ later }}», que é calculado depois deste campo. Mova este campo para depois dele.</p>
                }
                <div class="chain-props__condition-actions">
                  <button chainButton variant="secondary" size="sm" type="button" (click)="editExpression()">
                    {{ c.expression === undefined ? 'Definir a expressão…' : 'Editar a expressão…' }}
                  </button>
                </div>
              </div>
            }
            @if (isDate()) {
              <chain-form-field label="Subtipo">
                <select chainInput [value]="c.type" (change)="setSubtype($event)">
                  @for (type of dates; track type) {
                    <option [value]="type">{{ typeName(type) }}</option>
                  }
                </select>
              </chain-form-field>
            }
            @if (canBeReadOnly()) {
              <label class="chain-props__check">
                <input type="checkbox" [checked]="c.readOnly === true" (change)="setReadOnly($event)" />
                Somente leitura
              </label>
            }
            @if (canBeSensitive()) {
              <label class="chain-props__check">
                <input type="checkbox" [checked]="c.sensitive === true" (change)="setSensitive($event)" />
                Sensível
              </label>
              <p class="chain-props__hint">Quem não tem a permissão Ver dados sensíveis vê o valor oculto.</p>
            }
            @if (sensitiveReads().length > 0) {
              <p class="chain-props__warning" role="note">
                Este campo lê um dado sensível ({{ sensitiveReads().join(', ') }}). Marque-o como sensível, ou o grupo ou a lista que o contém; senão, um processo que use
                o formulário não publica (WF209).
              </p>
            }
          </div>
        </details>
        @if (hasOptions()) {
          <details class="chain-props__group" open>
            <summary>Opções</summary>
            <chain-options-editor class="chain-props__fields" [options]="c.options ?? []" [follows]="c.optionValuesFollow" (changed)="setOptions($event)" />
          </details>
        }
        <details class="chain-props__group" open>
          <summary>Condição</summary>
          <div class="chain-props__fields">
            @for (slot of conditionSlots(); track slot.name) {
              <div class="chain-props__condition">
                <span class="chain-props__condition-name">{{ slot.title }}</span>
                <p class="chain-props__condition-text">{{ conditionText(c[slot.name]) ?? slot.none }}</p>
                <div class="chain-props__condition-actions">
                  <button
                    chainButton
                    variant="secondary"
                    size="sm"
                    type="button"
                    [attr.aria-label]="(c[slot.name] === undefined ? 'Definir' : 'Editar') + ' a condição de ' + slot.title"
                    (click)="editCondition(slot.name, slot.title)"
                  >
                    {{ c[slot.name] === undefined ? 'Definir…' : 'Editar…' }}
                  </button>
                  @if (c[slot.name] !== undefined) {
                    <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Remover a condição de ' + slot.title" (click)="removeCondition(slot.name)">
                      Remover
                    </button>
                  }
                </div>
              </div>
            }
          </div>
        </details>
        @if (hasRules()) {
          <details class="chain-props__group" open>
            <summary>Validação</summary>
            <chain-validation-fields class="chain-props__fields" [component]="c" (changed)="change({ validate: $event })" />
          </details>
        }
      } @else {
        <p>Este componente não existe mais.</p>
      }
    </chain-dialog>
  `,
  styles: `
    .chain-props__group + .chain-props__group {
      margin-block-start: var(--chain-space-4);
    }

    .chain-props__group > summary {
      font-weight: var(--chain-font-weight-semibold);
      cursor: pointer;
    }

    .chain-props__fields {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
      margin-block-start: var(--chain-space-3);
    }

    .chain-props__condition {
      display: grid;
      gap: var(--chain-space-1);
    }

    .chain-props__condition-name {
      font-weight: var(--chain-font-weight-medium);
    }

    .chain-props__condition-text {
      margin: 0;
      color: var(--color-text-muted);
      font-family: var(--chain-font-mono);
      font-size: var(--chain-font-size-sm);
      overflow-wrap: anywhere;
    }

    .chain-props__condition-actions {
      display: flex;
      gap: var(--chain-space-2);
    }

    .chain-props__hint {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }

    .chain-props__warning {
      margin: 0;
      color: var(--color-status-warning-text);
      font-size: var(--chain-font-size-sm);
    }

    .chain-props__check {
      display: flex;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormPropertiesPanel {
  private readonly data = inject<PropertiesData>(DIALOG_DATA);
  private readonly dialogs = inject(DialogService);
  private readonly editor = this.data.editor;

  protected readonly dates = DATES;
  protected readonly component = computed(() => locate(this.editor.document(), this.data.id)?.component ?? null);
  protected readonly title = computed(() => {
    const c = this.component();
    return c ? `${TYPE_NAME[c.type]}: ${nameOf(c)}` : 'Propriedades';
  });
  protected readonly producesValue = computed(() => !DISPLAY.has(this.component()?.type ?? 'heading'));
  protected readonly isDate = computed(() => DATES.includes(this.component()?.type ?? 'text'));
  protected readonly canBeReadOnly = computed(() => READ_ONLY.has(this.component()?.type ?? 'group'));
  protected readonly hasRules = computed(() => RULED.has(this.component()?.type ?? 'group'));
  /** Sensível (sensitive-data.md §1, N3h): top-level fields, groups and lists, but not files (FM009, FM010). */
  protected readonly canBeSensitive = computed(() => {
    const c = this.component();
    return c !== null && !DISPLAY.has(c.type) && c.type !== 'file' && locate(this.editor.document(), this.data.id)?.parent === null;
  });
  /** The sensitive keys this computed field reads while it isn't sensitive itself (ADR-0016 §6 rule 2, WF209). */
  protected readonly sensitiveReads = computed(() => unmarkedSensitiveReads(this.editor.document(), this.data.id));
  protected readonly hasOptions = computed(() => CHOICES.has(this.component()?.type ?? 'group'));
  /** Condição (§8.1, N3e): every type can be shown under a condition; those that can be required, required under one. */
  protected readonly conditionSlots = computed(() => [
    { name: 'visibleWhen' as ConditionName, title: 'Mostrar quando', none: 'Sempre' },
    ...(REQUIRABLE.has(this.component()?.type ?? 'group') ? [{ name: 'requiredWhen' as ConditionName, title: 'Obrigatório quando', none: 'Sem condição' }] : []),
  ]);

  /** The key as it is typed, checked before it applies; null when the field shows the saved key. */
  protected readonly typedKey = signal<string | null>(null);
  private readonly refusedLabel = signal(false);
  private readonly refusedText = signal(false);
  /** The local checks' problems of this component (§9.2), by code. */
  private readonly problems = computed(() => {
    const path = pathOf(this.editor.document(), this.data.id);
    return new Set(checkForm(this.editor.saveable()).flatMap((problem) => (problem.path === path ? [problem.code] : [])));
  });

  protected readonly descriptionLimit = MAX_DESCRIPTION_LENGTH;
  protected readonly descriptionError = computed(() => (this.problems().has('FM012') ? formProblemText('FM012') : null));
  protected readonly labelError = computed(() => (this.refusedLabel() || this.problems().has('FM011') ? formProblemText('FM011') : null));
  protected readonly textError = computed(() => (this.refusedText() ? 'Dê um texto ao componente.' : null));
  protected readonly keyError = computed(() => {
    const typed = this.typedKey();
    if (typed !== null) {
      return !KEY.test(typed) ? formProblemText('FM001') : this.siblingKeys().has(typed) ? formProblemText('FM002') : null;
    }
    const problems = this.problems();
    return problems.has('FM001') ? formProblemText('FM001') : problems.has('FM002') ? formProblemText('FM002') : null;
  });
  protected readonly keyHint = computed(() => (this.data.published ? 'Processos que usam esta chave podem deixar de encontrá-la.' : null));

  protected typeName(type: ComponentType): string {
    return TYPE_NAME[type];
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  /** FD16: the designer refuses to clear a label, and puts the saved one back. */
  protected setLabel(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.value.trim() === '') {
      input.value = this.component()?.label ?? '';
      this.refusedLabel.set(true);
      return;
    }
    this.refusedLabel.set(false);
    this.change({ label: input.value });
  }

  protected setText(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    if (input.value.trim() === '') {
      input.value = this.component()?.text ?? '';
      this.refusedText.set(true);
      return;
    }
    this.refusedText.set(false);
    this.change({ text: input.value });
  }

  protected setKey(event: Event): void {
    this.typedKey.set(null);
    this.change({ key: this.value(event) });
  }

  protected setOptional(name: 'placeholder' | 'description', event: Event): void {
    const text = this.value(event);
    this.change({ [name]: text === '' ? undefined : text });
  }

  /** Switching between *Data*, *Hora* and *Data e hora* clears the limits, which are written for one type (FM004). */
  protected setSubtype(event: Event): void {
    const validate = this.component()?.validate;
    this.change({ type: this.value(event) as ComponentType, validate: this.withoutBounds(validate) });
  }

  protected setSensitive(event: Event): void {
    this.change({ sensitive: (event.target as HTMLInputElement).checked ? true : undefined });
  }

  protected setReadOnly(event: Event): void {
    this.change({ readOnly: (event.target as HTMLInputElement).checked ? true : undefined });
  }

  protected readonly expressionText = computed(() => {
    const expression = this.component()?.expression;
    return expression === undefined ? null : valueText(expression);
  });
  protected readonly expressionType = computed(() => typeLabel(inferType(this.component()?.expression)));
  /** Computed fields this one reads that come after it, which it would read before they are computed (§12.6). */
  protected readonly laterReads = computed(() => (this.component()?.type === 'computed' ? laterComputedReads(this.editor.document(), this.data.id) : []));

  /** The value builder in a dialog (§12.6). */
  protected editExpression(): void {
    const c = this.component();
    this.dialogs
      .open<ExpressionResult, ExpressionDialogData>(ExpressionDialog, {
        data: { title: `Expressão de ${c ? nameOf(c) : ''}`, expression: c?.expression, catalog: catalogOf(this.editor.saveable()) },
        size: 'lg',
      })
      .closed.subscribe((result) => result && this.change({ expression: result.json }));
  }

  /** A condition's text form, as the card shows it (§7.1). */
  protected conditionText(condition: unknown): string | null {
    return condition === undefined ? null : render(toRows(condition));
  }

  /** The condition builder in a dialog, on this form's fields and the request's data (§12.5). */
  protected editCondition(name: ConditionName, title: string): void {
    this.dialogs
      .open<ConditionResult, ConditionDialogData>(ConditionDialog, {
        data: { title, condition: this.component()?.[name], catalog: catalogOf(this.editor.saveable()) },
        size: 'lg',
      })
      .closed.subscribe((result) => result && this.change({ [name]: result.json }));
  }

  protected removeCondition(name: ConditionName): void {
    this.change({ [name]: undefined });
  }

  protected setOptions(change: OptionsChange): void {
    this.change({ options: change.options, optionValuesFollow: change.follows });
  }

  protected change(change: ComponentChange): void {
    this.editor.change(this.data.id, change);
  }

  private siblingKeys(): Set<string> {
    const at = locate(this.editor.document(), this.data.id);
    return new Set((at?.siblings ?? []).filter((sibling) => sibling.id !== this.data.id).flatMap((sibling) => (sibling.key ? [sibling.key] : [])));
  }

  private withoutBounds(validate: FieldValidation | undefined): FieldValidation | undefined {
    if (!validate) {
      return undefined;
    }
    const rest: Record<string, unknown> = { ...validate };
    delete rest['min'];
    delete rest['max'];
    return Object.keys(rest).length > 0 ? (rest as FieldValidation) : undefined;
  }
}
