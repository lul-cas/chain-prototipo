import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { FormRenderer, FormSubmission } from '../../../forms/form-renderer';
import { FieldErrorView, FormDocument } from '../../../forms/model';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormsApi } from '../forms-api';

export interface ServerTestData {
  readonly formId: string;
  readonly versionNumber: number;
  readonly document: FormDocument;
}

/**
 * Testar (form-designer.md §9.7): a version in the renderer, filled in and sent to `validate-submission`. The server's errors
 * show on their fields; otherwise the values it would store, computed fields included (forms.md F1). Nothing is stored.
 */
@Component({
  selector: 'chain-server-test-dialog',
  imports: [Alert, Button, DialogLayout, FormRenderer],
  template: `
    <chain-dialog [title]="'Testar a versão ' + data.versionNumber">
      <chain-form-renderer [document]="data.document" [serverErrors]="errors()" (submitted)="test($event)">
        <button chainButton type="submit" [loading]="testing()">Testar no servidor</button>
      </chain-form-renderer>
      @if (failure(); as message) {
        <chain-alert tone="danger">{{ message }}</chain-alert>
      } @else if (errors().length > 0) {
        <chain-alert tone="warning">O servidor recusaria o envio.</chain-alert>
      } @else if (values(); as json) {
        <h3 class="chain-server-test__title">O servidor guardaria:</h3>
        <pre class="chain-mono chain-server-test__json" tabindex="0" aria-label="Valores que o servidor guardaria">{{ json }}</pre>
      }
    </chain-dialog>
  `,
  styles: `
    .chain-server-test__title {
      margin-block-start: var(--chain-space-4);
      font-size: var(--chain-font-size-md);
    }

    .chain-server-test__json {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerTestDialog {
  protected readonly data = inject<ServerTestData>(DIALOG_DATA);
  private readonly api = inject(FormsApi);

  protected readonly errors = signal<readonly FieldErrorView[]>([]);
  protected readonly values = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly testing = signal(false);

  protected test(submission: FormSubmission): void {
    this.testing.set(true);
    this.failure.set(null);
    this.api.validateSubmission(this.data.formId, this.data.versionNumber, submission.json).subscribe({
      next: (report) => {
        this.testing.set(false);
        this.errors.set(report.valid ? [] : report.errors);
        this.values.set(report.valid ? JSON.stringify(report.values, null, 2) : null);
      },
      error: (error: unknown) => {
        this.testing.set(false);
        this.failure.set(messageFor(isApiProblem(error) ? error.code : 'unexpected'));
      },
    });
  }
}
