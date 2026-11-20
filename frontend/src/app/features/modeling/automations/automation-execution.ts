import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { storable } from '../../../core/text/storable';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { AutomationDocument, deadlineSeconds, durationText } from './automation-document';
import { AutomationDraftEditor } from './automation-draft-editor';
import { executionProblems } from './execution-checks';
import { ExecutionChange } from './execution-edits';
import { SectionControl } from './section-control';

const WHOLE = /^-?[0-9]+$/;
const INT32 = 2_147_483_647;
const NOT_WHOLE = 'Informe um número inteiro. O valor anterior continua valendo.';
const UNSTORABLE = 'O texto tem caracteres que não podem ser guardados, e não foi gravado.';
const NO_KEY_WARNING =
  'Sem a chave, o sistema de destino não reconhece repetições. Uma nova tentativa, ou uma nova execução pedida depois de uma falha, pode repetir o efeito, como cadastrar ou cobrar duas vezes.';

type NumberField = 'timeoutSeconds' | 'maxAttempts' | 'initialDelaySeconds' | 'max';

/**
 * *Execução* (automation-ui.md §7.5, §12.5 AS5b): the time limit, the attempts and their wait, the idempotency key and the
 * redirects, edited through `AutomationDraftEditor`, which writes the whole `execution` object. A field that holds no whole
 * number is flagged and not written; a whole number out of range is written and flagged (§7.7). The step's deadline follows
 * the numbers (automation.md §8.2).
 */
@Component({
  selector: 'chain-automation-execution',
  imports: [FormField, Input, SectionControl],
  template: `
    @let e = document().execution;
    <section class="chain-section" aria-labelledby="chain-section-execution">
      <h2 id="chain-section-execution">Execução</h2>
      <div class="chain-call__grid">
        <chain-form-field
          label="Tempo limite por tentativa"
          hint="Em segundos, de 1 a 300."
          [error]="problemAt('execution.timeoutSeconds', 'timeoutSeconds')"
        >
          <input
            chainInput
            type="text"
            inputmode="numeric"
            chainControl="execution.timeoutSeconds"
            [value]="e.timeoutSeconds"
            (change)="setNumber('timeoutSeconds', $event)"
          />
        </chain-form-field>
        <chain-form-field
          label="Tentativas"
          hint="De 1 a 10. Só erros de conexão, tempo esgotado, 429 e 5xx levam a nova tentativa."
          [error]="problemAt('execution.retry.maxAttempts', 'maxAttempts')"
        >
          <input
            chainInput
            type="text"
            inputmode="numeric"
            chainControl="execution.retry.maxAttempts"
            [value]="e.retry.maxAttempts"
            (change)="setNumber('maxAttempts', $event)"
          />
        </chain-form-field>
        <chain-form-field
          label="Espera antes da segunda tentativa"
          hint="Em segundos, de 1 a 60. Dobra a cada tentativa, até 5 minutos."
          [error]="problemAt('execution.retry.initialDelaySeconds', 'initialDelaySeconds')"
        >
          <input
            chainInput
            type="text"
            inputmode="numeric"
            chainControl="execution.retry.initialDelaySeconds"
            [value]="e.retry.initialDelaySeconds"
            (change)="setNumber('initialDelaySeconds', $event)"
          />
        </chain-form-field>
      </div>

      <div class="chain-call__grid">
        <chain-form-field
          label="Chave de idempotência"
          [error]="problemAt('execution.idempotency.mode')"
        >
          <select
            chainInput
            chainControl="execution.idempotency.mode"
            (change)="setIdempotency($event)"
          >
            @if (e.idempotency.mode !== 'header' && e.idempotency.mode !== 'none') {
              <option [value]="e.idempotency.mode" selected>
                {{ e.idempotency.mode }} (não editável)
              </option>
            }
            <option value="header" [selected]="e.idempotency.mode === 'header'">
              Enviar no cabeçalho
            </option>
            <option value="none" [selected]="e.idempotency.mode === 'none'">
              Não enviar: o sistema de destino não evita repetições
            </option>
          </select>
        </chain-form-field>
        @if (e.idempotency.mode === 'header' || e.idempotency.header !== undefined) {
          <chain-form-field
            label="Cabeçalho da chave"
            [error]="problemAt('execution.idempotency.header', 'header')"
          >
            <input
              chainInput
              class="chain-mono"
              type="text"
              autocomplete="off"
              spellcheck="false"
              chainControl="execution.idempotency.header"
              [value]="e.idempotency.header ?? 'Idempotency-Key'"
              (change)="setHeader($event)"
            />
          </chain-form-field>
        }
      </div>
      @if (e.idempotency.mode === 'none') {
        <p class="chain-section__warning">
          {{ noKeyWarning }}{{ oneAttempt() ? ' Considere usar uma tentativa só.' : '' }}
        </p>
      }

      <div class="chain-call__grid">
        <chain-form-field
          label="Redirecionamentos"
          hint="Credenciais não são enviadas a outro host."
        >
          <select chainInput (change)="setFollow($event)">
            <option value="no" [selected]="!e.redirects.follow">Não seguir</option>
            <option value="yes" [selected]="e.redirects.follow">Seguir</option>
          </select>
        </chain-form-field>
        @if (e.redirects.follow || e.redirects.max !== 0) {
          <chain-form-field
            label="Até quantos redirecionamentos"
            hint="De 1 a 3."
            [error]="problemAt('execution.redirects.max', 'max')"
          >
            <input
              chainInput
              type="text"
              inputmode="numeric"
              chainControl="execution.redirects.max"
              [value]="e.redirects.max"
              (change)="setNumber('max', $event)"
            />
          </chain-form-field>
        }
      </div>
      <p class="chain-section__muted">
        Sem resultado em {{ deadline() }}, a etapa falha (sem resultado no prazo).
      </p>
    </section>
  `,
  styleUrls: ['./automation-sections.css', './automation-call.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationExecution {
  readonly document = input.required<AutomationDocument>();

  protected readonly editor = inject(AutomationDraftEditor);
  protected readonly noKeyWarning = NO_KEY_WARNING;
  /** Fields whose last text wasn't written, with why, by field (§7.7). */
  private readonly unwritten = signal<ReadonlyMap<string, string>>(new Map());

  private readonly problems = computed(() => executionProblems(this.document()));
  protected readonly deadline = computed(() =>
    durationText(deadlineSeconds(this.document().execution)),
  );
  /** ADR-0011 §6: more than one attempt of a call that may change something. */
  protected readonly oneAttempt = computed(
    () =>
      this.document().execution.retry.maxAttempts > 1 && this.document().request.method !== 'GET',
  );

  /** The local problems at a path, and, with `field`, why its last text wasn't written. */
  protected problemAt(path: string, field?: string): string | null {
    const texts = [
      field ? this.unwritten().get(field) : undefined,
      ...this.problems()
        .filter((problem) => problem.path === path)
        .map((problem) => problem.text),
    ];
    return texts.filter((text) => text).join(' ') || null;
  }

  /** A whole number is written, even out of range, which the checks flag; anything else isn't written (§7.7). */
  protected setNumber(field: NumberField, event: Event): void {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = Number(text);
    if (!WHOLE.test(text) || Math.abs(value) > INT32) {
      this.unwritten.update((fields) => new Map(fields).set(field, NOT_WHOLE));
      this.editor.refuse(`O valor não foi gravado: ${NOT_WHOLE}`);
      return;
    }
    this.unwritten.update((fields) => new Map([...fields].filter(([other]) => other !== field)));
    const redirects = this.document().execution.redirects;
    this.editor.setExecution(
      field === 'max'
        ? { redirects: { follow: redirects.follow, max: value } }
        : ({ [field]: value } as ExecutionChange),
    );
  }

  /** *Não enviar* leaves no header in the document; *Enviar no cabeçalho* starts with `Idempotency-Key` (AU012). */
  protected setIdempotency(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value;
    this.editor.setExecution({
      idempotency:
        mode === 'none'
          ? { mode: 'none' }
          : {
              mode: 'header',
              header: this.document().execution.idempotency.header ?? 'Idempotency-Key',
            },
    });
  }

  protected setHeader(event: Event): void {
    const header = (event.target as HTMLInputElement).value;
    if (!storable(header)) {
      this.unwritten.update((fields) => new Map(fields).set('header', UNSTORABLE));
      this.editor.refuse(
        'O texto não foi gravado: ele tem caracteres que não podem ser guardados.',
      );
      return;
    }
    this.unwritten.update((fields) => new Map([...fields].filter(([other]) => other !== 'header')));
    this.editor.setExecution({ idempotency: { mode: 'header', header } });
  }

  /** *Seguir* starts at one redirect; *Não seguir* is a maximum of 0 (AU011). */
  protected setFollow(event: Event): void {
    const follow = (event.target as HTMLSelectElement).value === 'yes';
    const max = this.document().execution.redirects.max;
    this.editor.setExecution({
      redirects: follow
        ? { follow: true, max: max >= 1 && max <= 3 ? max : 1 }
        : { follow: false, max: 0 },
    });
  }
}
