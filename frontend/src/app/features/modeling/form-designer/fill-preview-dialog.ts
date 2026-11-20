import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRenderer } from '../../../forms/form-renderer';
import { FormDocument } from '../../../forms/model';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { Input } from '../../../ui/form-field/input';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormProblem } from './form-checks';
import { formProblemText } from './form-messages';

export interface FillPreviewData {
  readonly name: string;
  readonly document: FormDocument;
  /** The local checks' problems: the renderer expects a valid document, so the dialog lists them instead. */
  readonly problems: readonly FormProblem[];
}

/**
 * Pré-visualizar (form-designer.md §9.5): the draft in the F3 renderer, which can be filled in. Validar preenchimento shows
 * the client's errors, or what a valid fill would send, as /_formulario does. A preview uploads no file.
 */
@Component({
  selector: 'chain-fill-preview-dialog',
  imports: [Alert, Button, DialogLayout, FormRenderer, Input],
  template: `
    <chain-dialog [title]="'Pré-visualizar: ' + data.name">
      @if (data.problems.length > 0) {
        <chain-alert tone="warning" title="Corrija o formulário para pré-visualizá-lo">
          <ul class="chain-fill-preview__problems">
            @for (problem of data.problems; track $index) {
              <li>
                {{ text(problem) }} <code>{{ problem.code }}</code>
                @if (problem.path) {
                  — <code>{{ problem.path }}</code>
                }
              </li>
            }
          </ul>
        </chain-alert>
      } @else {
        <details class="chain-fill-preview__context">
          <summary>Dados do pedido</summary>
          <p class="chain-fill-preview__hint">Um objeto JSON com os dados do pedido, que as condições e os campos calculados podem ler.</p>
          <textarea chainInput class="chain-mono" rows="4" aria-label="Dados do pedido (JSON)" (change)="setContext($event)"></textarea>
          @if (contextError()) {
            <p class="chain-fill-preview__error" role="alert">Use um objeto JSON, como {{ example }}.</p>
          }
        </details>
        <chain-form-renderer [document]="data.document" [context]="context()" (submitted)="sent.set($event.json)">
          <button chainButton type="submit">Validar preenchimento</button>
        </chain-form-renderer>
        @if (sent(); as json) {
          <h3 class="chain-fill-preview__sent">Enviaria:</h3>
          <pre class="chain-mono chain-fill-preview__json" tabindex="0" aria-label="Dados enviados">{{ json }}</pre>
        }
      }
    </chain-dialog>
  `,
  styles: `
    .chain-fill-preview__problems {
      margin: 0;
      padding-inline-start: var(--chain-space-4);
    }

    .chain-fill-preview__sent {
      margin-block-start: var(--chain-space-4);
      font-size: var(--chain-font-size-md);
    }

    .chain-fill-preview__context {
      margin-block-end: var(--chain-space-4);
    }

    .chain-fill-preview__hint,
    .chain-fill-preview__error {
      margin: var(--chain-space-1) 0;
      font-size: var(--chain-font-size-sm);
    }

    .chain-fill-preview__hint {
      color: var(--color-text-muted);
    }

    .chain-fill-preview__error {
      color: var(--color-text-danger);
    }

    .chain-fill-preview__json {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FillPreviewDialog {
  protected readonly data = inject<FillPreviewData>(DIALOG_DATA);
  protected readonly sent = signal<string | null>(null);
  protected readonly example = '{"cliente": {"tipo": "pj"}}';
  /** *Dados do pedido* (§9.5): the request's data the renderer reads around the form (its `context`). */
  protected readonly context = signal<Readonly<Record<string, unknown>>>({});
  protected readonly contextError = signal(false);

  /** A JSON object becomes the request's data, which starts the form again; anything else is refused. Empty clears it. */
  protected setContext(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value.trim();
    if (text === '') {
      this.contextError.set(false);
      this.context.set({});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    this.contextError.set(!isObject);
    if (isObject) {
      this.context.set(parsed as Record<string, unknown>);
    }
  }

  protected text(problem: FormProblem): string {
    return formProblemText(problem.code);
  }
}
