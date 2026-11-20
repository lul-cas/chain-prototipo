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
import { AutomationDocument } from './automation-document';
import { AutomationDraftEditor } from './automation-draft-editor';
import { outputProblems } from './output-checks';
import { OutputSource } from './output-edits';
import { formatPath, parsePath } from './output-path';
import { SectionControl } from './section-control';
import { TypeFields } from './type-fields';

const UNSTORABLE = 'O texto tem caracteres que não podem ser guardados, e não foi gravado.';

/** An output as its row draws it. */
interface OutputRow {
  readonly id: string;
  readonly index: number;
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
  readonly source: string;
  /** The path in its text form, or null when the output has none. */
  readonly path: string | null;
  readonly keyProblem: string | null;
  readonly sourceProblem: string | null;
  readonly pathProblem: string | null;
  readonly typeProblem: string | null;
}

/**
 * *Resposta e saídas* (automation-ui.md §7.4, §12.5 AS5a): the response's type, and the output contract, one row per output,
 * edited through `AutomationDraftEditor`. A path is written in its text form and stored as segments; a text that isn't a path
 * is flagged and not written. The local checks show at their controls (§7.9).
 */
@Component({
  selector: 'chain-automation-outputs',
  imports: [Button, FormField, Input, SectionControl, TypeFields],
  template: `
    <section class="chain-section" aria-labelledby="chain-section-response">
      <h2 id="chain-section-response">Resposta e saídas</h2>
      <chain-form-field label="Resposta" [error]="problemAt('response.type')">
        <select chainInput chainControl="response.type" (change)="setResponse($event)">
          @if (response() !== 'json' && response() !== 'none') {
            <option [value]="response()" selected>
              {{ response() || '(vazio)' }} (não editável)
            </option>
          }
          <option value="json" [selected]="response() === 'json'">JSON</option>
          <option value="none" [selected]="response() === 'none'">
            Nenhuma: o corpo é descartado
          </option>
        </select>
      </chain-form-field>

      <h3 chainControl="outputs">Saídas</h3>
      @if (problemAt('outputs'); as text) {
        <p class="chain-section__flag">{{ text }}</p>
      }
      @if (rows().length === 0) {
        <p class="chain-section__muted">Nenhuma saída.</p>
      } @else {
        <ol class="chain-inputs">
          @for (row of rows(); track row.id; let first = $first; let last = $last) {
            <li>
              <div
                class="chain-inputs__row"
                role="group"
                [attr.aria-label]="'Saída ' + (row.index + 1)"
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
                    [chainControl]="'outputs[' + row.index + '].key'"
                    (change)="setKey(row.id, $event)"
                  />
                </chain-form-field>
                <chain-form-field label="Origem" [error]="row.sourceProblem">
                  <select
                    chainInput
                    [chainControl]="'outputs[' + row.index + '].source'"
                    (change)="setSource(row.id, $event)"
                  >
                    @if (row.source !== 'body' && row.source !== 'status') {
                      <option [value]="row.source" selected>
                        {{ row.source || '(vazio)' }} (não editável)
                      </option>
                    }
                    <option value="body" [selected]="row.source === 'body'">
                      Corpo da resposta
                    </option>
                    <option value="status" [selected]="row.source === 'status'">Status HTTP</option>
                  </select>
                </chain-form-field>
                @if (row.source !== 'status' || row.path !== null) {
                  <chain-form-field
                    label="Caminho"
                    hint="Como resultado.situacao ou itens[0].nome"
                    [error]="row.pathProblem"
                  >
                    <input
                      chainInput
                      class="chain-mono"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      [value]="row.path ?? ''"
                      [chainControl]="'outputs[' + row.index + '].path'"
                      (change)="setPath(row.id, $event)"
                    />
                  </chain-form-field>
                }
                @if (row.source !== 'status' || row.type !== 'number') {
                  <chain-type-fields
                    [type]="row.type"
                    [control]="'outputs[' + row.index + '].type'"
                    [problem]="row.typeProblem"
                    (changed)="editor.setOutputType(row.id, $event)"
                  />
                } @else {
                  <p class="chain-inputs__usage">Tipo: número</p>
                }
                <div class="chain-outputs__required">
                  <label class="chain-inputs__required">
                    <input
                      type="checkbox"
                      [checked]="row.required"
                      (change)="setRequired(row.id, $event)"
                    />
                    Obrigatória
                  </label>
                  <p class="chain-inputs__usage">
                    Se faltar na resposta, a etapa falha: a resposta não trouxe os dados esperados.
                  </p>
                </div>
                <div class="chain-inputs__actions">
                  <button
                    chainButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-move="-1"
                    [disabled]="first"
                    [attr.aria-label]="'Mover a saída ' + name(row) + ' para cima'"
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
                    [attr.aria-label]="'Mover a saída ' + name(row) + ' para baixo'"
                    (click)="move(row.id, 1)"
                  >
                    ↓
                  </button>
                  <button
                    chainButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    [attr.aria-label]="'Remover a saída ' + name(row)"
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
          class="chain-outputs__add"
          (click)="add()"
        >
          Adicionar saída
        </button>
      </div>
    </section>
  `,
  styleUrls: ['./automation-sections.css', './automation-inputs.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationOutputs {
  readonly document = input.required<AutomationDocument>();

  protected readonly editor = inject(AutomationDraftEditor);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Paths whose last text wasn't written, with why: it isn't a path, or the API can't store it (§7.7), by output. */
  private readonly unwritten = signal<ReadonlyMap<string, string>>(new Map());
  /** Keys whose last text the API can't store, by output. */
  private readonly unstorable = signal<ReadonlySet<string>>(new Set());

  private readonly problems = computed(() => outputProblems(this.document()));
  protected readonly response = computed(() => this.document().response.type);
  protected readonly rows = computed<readonly OutputRow[]>(() => {
    const ids = this.editor.draft().outputIds;
    const problems = this.problems();
    const unwritten = this.unwritten();
    const unstorable = this.unstorable();
    return this.document().outputs.map((output, index) => {
      const id = ids[index] ?? `output-row-${index}`;
      const at = (member: string) =>
        problems
          .filter((problem) => problem.path === `outputs[${index}].${member}`)
          .map((problem) => problem.text);
      const joined = (texts: (string | null | undefined)[]) =>
        texts.filter((text) => text).join(' ') || null;
      return {
        id,
        index,
        key: output.key,
        type: output.type,
        required: output.required,
        source: output.source,
        path: output.path === undefined ? null : formatPath(output.path),
        keyProblem: joined([unstorable.has(id) ? UNSTORABLE : null, ...at('key')]),
        sourceProblem: joined(at('source')),
        pathProblem: joined([unwritten.get(id), ...at('path')]),
        typeProblem: joined(at('type')),
      };
    });
  });

  protected problemAt(path: string): string | null {
    return (
      this.problems()
        .filter((problem) => problem.path === path)
        .map((problem) => problem.text)
        .join(' ') || null
    );
  }

  protected name(row: OutputRow): string {
    return row.key || String(row.index + 1);
  }

  protected setResponse(event: Event): void {
    this.editor.setResponseType((event.target as HTMLSelectElement).value);
  }

  protected add(): void {
    const id = this.editor.addOutput();
    if (id !== null) {
      this.focusAfterRender([`[data-key="${id}"]`]);
    }
  }

  protected remove(id: string): void {
    const ids = this.editor.draft().outputIds;
    const index = ids.indexOf(id);
    const neighbour = ids[index + 1] ?? ids[index - 1];
    this.editor.removeOutput(id);
    this.focusAfterRender([neighbour ? `[data-key="${neighbour}"]` : '.chain-outputs__add']);
  }

  protected move(id: string, by: -1 | 1): void {
    this.editor.moveOutput(id, by);
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
    this.unstorable.update((ids) => new Set([...ids].filter((other) => other !== id)));
    this.editor.setOutputKey(id, key);
  }

  protected setSource(id: string, event: Event): void {
    this.editor.setOutputSource(id, (event.target as HTMLSelectElement).value as OutputSource);
  }

  /** A path's text form, read back into segments; a text that isn't a path is flagged and not written (§7.4, §7.7). */
  protected setPath(id: string, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    const parsed = storable(text) ? parsePath(text) : { error: UNSTORABLE };
    if ('error' in parsed) {
      this.unwritten.update((paths) => new Map(paths).set(id, parsed.error));
      this.editor.refuse(`O caminho não foi gravado: ${parsed.error}`);
      return;
    }
    this.unwritten.update((paths) => new Map([...paths].filter(([other]) => other !== id)));
    this.editor.setOutputPath(id, parsed.segments);
  }

  protected setRequired(id: string, event: Event): void {
    this.editor.setOutputRequired(id, (event.target as HTMLInputElement).checked);
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
