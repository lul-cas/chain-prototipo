import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  ViewEncapsulation,
  afterNextRender,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { Alert } from '../ui/alert/alert';
import { FormNode } from './form-node';
import { FormStore } from './form-store';
import { FieldErrorView, FormDocument } from './model';
import { serializeJson } from './values';

/** What a valid submit gives the page: the data, and the same data as JSON with exact decimals for the request body. */
export interface FormSubmission {
  readonly data: Readonly<Record<string, unknown>>;
  readonly json: string;
}

/**
 * Renders a published form document (forms.md F3). Pages give it the document, the prefill, the request's data and the
 * server's errors, and project their own buttons, which submit the form. It calls no API: a valid submit emits `submitted`.
 * Changing `document`, `prefill` or `context` starts the form again, so pages pass stable objects.
 */
@Component({
  selector: 'chain-form-renderer',
  imports: [Alert, FormNode],
  providers: [FormStore],
  template: `
    <form class="chain-form" novalidate (submit)="submit($event)">
      @if (showSummary() || store.formErrors().length > 0) {
        <div class="chain-form__problems" tabindex="-1" #problems>
          @if (showSummary()) {
            <chain-alert tone="danger" [title]="summaryTitle()">
              <ul class="chain-form__summary">
                @for (item of store.summary(); track item.path) {
                  <li>
                    <a [attr.href]="'#' + (store.controlId(item.path) ?? '')" (click)="focusField(item.path, $event)">{{ item.label }}: {{ item.message }}</a>
                  </li>
                }
              </ul>
            </chain-alert>
          }
          @if (store.formErrors().length > 0) {
            <chain-alert tone="danger" title="O envio foi recusado">
              @for (message of store.formErrors(); track $index) {
                <p>{{ message }}</p>
              }
            </chain-alert>
          }
        </div>
      }
      <fieldset class="chain-form__fields" [disabled]="disabled()">
        @for (component of document().components; track $index) {
          <chain-form-node [component]="component" prefix="" [container]="root" [index]="$index" />
        }
      </fieldset>
      <ng-content />
    </form>
  `,
  styleUrl: './form-renderer.css',
  // The node styles reach every level of the recursion, so they are global but scoped by class.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'chain-form-renderer' },
})
export class FormRenderer {
  readonly document = input.required<FormDocument>();
  readonly prefill = input<Readonly<Record<string, unknown>>>({});
  /** The request's data, which conditions and computed fields read around the form; `{}` for a start form. */
  readonly context = input<Readonly<Record<string, unknown>>>({});
  /** The `errors` of a 422 `submission_invalid`, shown on their fields until edited. */
  readonly serverErrors = input<readonly FieldErrorView[]>([]);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly submitted = output<FormSubmission>();

  protected readonly store = inject(FormStore);
  protected readonly root: readonly string[] = [];
  private readonly injector = inject(Injector);
  private readonly problems = viewChild<ElementRef<HTMLElement>>('problems');

  protected readonly showSummary = computed(() => this.store.attempted() && this.store.summary().length > 0);
  protected readonly summaryTitle = computed(() => {
    const count = this.store.summary().length;
    return count === 1 ? 'Corrija 1 campo' : `Corrija ${count} campos`;
  });

  constructor() {
    effect(() => {
      const [document, prefill, context] = [this.document(), this.prefill(), this.context()];
      untracked(() => this.store.load(document, prefill, context));
    });
    effect(() => {
      const errors = this.serverErrors();
      untracked(() => {
        this.store.showServerErrors(errors);
        if (errors.length > 0) {
          this.store.attempted.set(true);
          this.focusProblems();
        }
      });
    });
    effect(() => this.store.disabled.set(this.disabled()));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.store.attempted.set(true);
    const evaluation = this.store.evaluation();
    if (!evaluation.valid) {
      this.focusProblems();
      return;
    }
    this.submitted.emit({ data: evaluation.data, json: serializeJson(evaluation.data) });
  }

  protected focusField(path: string, event: Event): void {
    event.preventDefault();
    const id = this.store.controlId(path);
    if (id) {
      document.getElementById(id)?.focus();
    }
  }

  private focusProblems(): void {
    afterNextRender(() => this.problems()?.nativeElement.focus(), { injector: this.injector });
  }
}
