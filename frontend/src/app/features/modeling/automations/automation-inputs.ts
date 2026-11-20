import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { storable } from '../../../core/text/storable';
import { Button } from '../../../ui/button/button';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { inputProblems } from './automation-checks';
import { AutomationDocument, inputUsage } from './automation-document';
import { AutomationDraftEditor } from './automation-draft-editor';
import { SectionControl } from './section-control';
import { TypeFields } from './type-fields';

const RENAME_WARNING =
  'Ao publicar de novo um processo que usa esta automação, ele passa a usar a nova versão, e os mapeamentos com a chave antiga deixam de valer (WF110).';

/** An input as its row draws it. */
interface InputRow {
  readonly id: string;
  readonly index: number;
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
  readonly usage: string;
  readonly keyProblem: string | null;
  readonly typeProblem: string | null;
  /** A published key, renamed since the draft was opened (§7.2). */
  readonly renamed: boolean;
}

/**
 * *Entradas* (automation-ui.md §7.2): the input contract, one row per input, edited through `AutomationDraftEditor`. A text
 * field is one change when it loses the focus (§7.7). Each row shows where the call uses it, and its local problems (§7.9).
 */
@Component({
  selector: 'chain-automation-inputs',
  imports: [Button, FormField, Input, SectionControl, TypeFields],
  template: `
    <section class="chain-section" aria-labelledby="chain-section-inputs">
      <h2 id="chain-section-inputs" chainControl="inputs">Entradas</h2>
      @if (countProblem(); as text) {
        <p class="chain-section__flag">{{ text }}</p>
      }
      @if (rows().length === 0) {
        <p class="chain-section__muted">Nenhuma entrada.</p>
      } @else {
        <ol class="chain-inputs">
          @for (row of rows(); track row.id; let first = $first; let last = $last) {
            <li>
              <div
                class="chain-inputs__row"
                role="group"
                [attr.aria-label]="'Entrada ' + (row.index + 1)"
                [attr.data-row]="row.id"
              >
                <chain-form-field label="Chave" [error]="row.keyProblem">
                  <input
                    chainInput
                    class="chain-mono"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    [attr.data-key]="row.id"
                    [value]="row.key"
                    [chainControl]="'inputs[' + row.index + '].key'"
                    (change)="setKey(row.id, $event)"
                  />
                </chain-form-field>
                <chain-type-fields
                  [type]="row.type"
                  [control]="'inputs[' + row.index + '].type'"
                  [problem]="row.typeProblem"
                  (changed)="editor.setInputType(row.id, $event)"
                />
                @if (row.renamed) {
                  <p class="chain-section__warning chain-inputs__wide">{{ renameWarning }}</p>
                }
                <label class="chain-inputs__required">
                  <input
                    type="checkbox"
                    [checked]="row.required"
                    (change)="setRequired(row.id, $event)"
                  />
                  Obrigatória
                </label>
                <p class="chain-inputs__usage">Uso: {{ row.usage }}</p>
                <div class="chain-inputs__actions">
                  <button
                    chainButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-move="-1"
                    [disabled]="first"
                    [attr.aria-label]="'Mover a entrada ' + name(row) + ' para cima'"
                    (click)="move(row.id, -1)"
                  >
                    ↑
                  </button>
                  <button
                    chainButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-move="1"
                    [disabled]="last"
                    [attr.aria-label]="'Mover a entrada ' + name(row) + ' para baixo'"
                    (click)="move(row.id, 1)"
                  >
                    ↓
                  </button>
                  <button
                    chainButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    [attr.aria-label]="'Remover a entrada ' + name(row)"
                    (click)="remove(row.id)"
                  >
                    Remover
                  </button>
                </div>
              </div>
            </li>
          }
        </ol>
      }
      <div>
        <button
          chainButton
          variant="secondary"
          size="sm"
          type="button"
          class="chain-inputs__add"
          (click)="add()"
        >
          Adicionar entrada
        </button>
      </div>
    </section>
  `,
  styleUrls: ['./automation-sections.css', './automation-inputs.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationInputs {
  readonly document = input.required<AutomationDocument>();
  /** The input keys of the latest published version; null when none was published (§7.2). */
  readonly published = input<ReadonlySet<string> | null>(null);

  protected readonly editor = inject(AutomationDraftEditor);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly renameWarning = RENAME_WARNING;
  /** Rows whose last typed key the API can't store, so it wasn't written (§7.7). */
  private readonly unstorable = signal<ReadonlySet<string>>(new Set());

  private readonly problems = computed(() => inputProblems(this.document()));
  protected readonly countProblem = computed(
    () => this.problems().find((problem) => problem.path === 'inputs')?.text ?? null,
  );
  protected readonly rows = computed<readonly InputRow[]>(() => {
    const document = this.document();
    const ids = this.editor.draft().inputIds;
    const problems = this.problems();
    const published = this.published();
    const unstorable = this.unstorable();
    return document.inputs.map(({ key, type, required }, index) => {
      const id = ids[index] ?? `input-row-${index}`;
      const loaded = this.editor.keyAtLoad(id);
      const problemAt = (path: string) =>
        problems.find((problem) => problem.path === `inputs[${index}].${path}`)?.text ?? null;
      return {
        id,
        index,
        key,
        type,
        required,
        usage: inputUsage(document, key),
        keyProblem: unstorable.has(id)
          ? 'A chave tem caracteres que não podem ser guardados, e não foi gravada.'
          : problemAt('key'),
        typeProblem: problemAt('type'),
        renamed:
          published !== null && loaded !== undefined && published.has(loaded) && key !== loaded,
      };
    });
  });

  /** How a row's actions name it: by its key, or by its number while it has none. */
  protected name(row: InputRow): string {
    return row.key || String(row.index + 1);
  }

  /** Adicionar entrada: a new row, whose key takes the focus (§7.2). */
  protected add(): void {
    const id = this.editor.addInput();
    if (id !== null) {
      this.focusAfterRender([`[data-key="${id}"]`]);
    }
  }

  /** Removes a row; the focus goes to the next row's key, else the previous one's, else Adicionar entrada. */
  protected remove(id: string): void {
    const ids = this.editor.draft().inputIds;
    const index = ids.indexOf(id);
    const neighbour = ids[index + 1] ?? ids[index - 1];
    this.editor.removeInput(id);
    this.focusAfterRender([neighbour ? `[data-key="${neighbour}"]` : '.chain-inputs__add']);
  }

  /** Moves a row; the focus stays on the button, or goes to the other one when the row reaches an end. */
  protected move(id: string, by: -1 | 1): void {
    this.editor.moveInput(id, by);
    this.focusAfterRender([
      `[data-row="${id}"] [data-move="${by}"]:not(:disabled)`,
      `[data-row="${id}"] [data-move="${-by}"]`,
    ]);
  }

  protected setKey(id: string, event: Event): void {
    const key = (event.target as HTMLInputElement).value;
    if (!storable(key)) {
      this.unstorable.update((ids) => new Set(ids).add(id));
      this.editor.refuse(
        'A chave não foi gravada: ela tem caracteres que não podem ser guardados.',
      );
      return;
    }
    if (this.unstorable().has(id)) {
      this.unstorable.update((ids) => new Set([...ids].filter((other) => other !== id)));
    }
    this.editor.setInputKey(id, key);
  }

  protected setRequired(id: string, event: Event): void {
    this.editor.setInputRequired(id, (event.target as HTMLInputElement).checked);
  }

  /** After the next render, focuses the first element that matches, trying the selectors in order. */
  private focusAfterRender(selectors: readonly string[]): void {
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        selectors
          .map((selector) => host.querySelector<HTMLElement>(selector))
          .find((element) => element !== null)
          ?.focus();
      },
      { injector: this.injector },
    );
  }
}
