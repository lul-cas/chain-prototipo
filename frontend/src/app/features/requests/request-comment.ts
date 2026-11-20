import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../core/http/api-problem';
import { CommandKey, offersRetry } from '../../core/http/command-key';
import { EngineApi, InstanceView } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { FormRenderer, FormSubmission } from '../../forms/form-renderer';
import { FormDocument } from '../../forms/model';
import { provideFileUploads } from '../../forms/uploads';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { ToastService } from '../../ui/toast/toast.service';

/** A form document, so the attachments upload, list and hold the submit back as a form's file field does (forms.md F3). */
const COMMENT_FORM: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'textarea', key: 'text', label: 'Comentário', validate: { maxLength: 1000 } },
    { type: 'file', key: 'files', label: 'Anexos', validate: { maxFiles: 10 } },
  ],
};

/** The comment's own texts (requests-ui.md §6, "Commenting"); the other codes take the app's. */
const MESSAGES: Readonly<Record<string, string>> = {
  comment_empty: 'Escreva um comentário ou anexe um arquivo.',
  too_many_files: 'Anexe no máximo 10 arquivos.',
  duplicate_file: 'O mesmo arquivo foi anexado duas vezes.',
  forbidden: 'Você não pode comentar nesta solicitação.',
  file_invalid: 'Um dos arquivos expirou ou já foi usado. Remova-o e anexe de novo.',
  idempotency_key_reused: 'O comentário anterior pode já ter sido registrado. Confira a linha do tempo antes de enviar de novo.',
};

/** Commenting on a request, with attachments (requests-ui.md §6, "Commenting"; workflow-engine.md §17). */
@Component({
  selector: 'chain-request-comment',
  imports: [Alert, Button, FormRenderer],
  providers: [provideFileUploads()],
  template: `
    <chain-form-renderer [document]="form" [prefill]="prefill()" [disabled]="busy()" (submitted)="send($event)">
      @if (error(); as message) {
        <chain-alert tone="danger">
          {{ message }}
          @if (retry()) {
            <div class="chain-request-comment__retry">
              <button chainButton variant="secondary" size="sm" type="button" (click)="tryAgain()">Tentar novamente</button>
            </div>
          }
        </chain-alert>
      }
      <div>
        <button chainButton type="submit" [loading]="busy()">Comentar</button>
      </div>
    </chain-form-renderer>
  `,
  styles: `
    .chain-request-comment__retry {
      margin-top: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestComment {
  readonly instanceId = input.required<string>();
  /** The request as the server answered the comment. */
  readonly commented = output<InstanceView>();
  /**
   * The request changed under the page, which loads it again. The message is for the page to show, since this section goes
   * away when the request is no longer running; null when there is nothing to add.
   */
  readonly stale = output<string | null>();

  private readonly api = inject(EngineApi);
  private readonly toasts = inject(ToastService);
  private key = new CommandKey();
  /** Emits when the page shows another request, which stops the old one's comment. */
  private readonly switched = new Subject<void>();

  protected readonly form = COMMENT_FORM;
  /** A new object empties the form: the renderer starts again when its prefill changes. */
  protected readonly prefill = signal<Readonly<Record<string, unknown>>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Sends the comment again, when its answer was lost (requests-ui.md §1.5, "Tentar novamente"). */
  protected readonly retry = signal<(() => void) | null>(null);

  constructor() {
    // Each request starts with an empty form and a new key.
    effect(() => {
      this.instanceId();
      untracked(() => {
        this.switched.next();
        this.key = new CommandKey();
        this.prefill.set({});
        this.busy.set(false);
        this.error.set(null);
        this.retry.set(null);
      });
    });
  }

  protected send(submission: FormSubmission): void {
    const text = typeof submission.data['text'] === 'string' ? submission.data['text'] : '';
    const files = Array.isArray(submission.data['files']) ? (submission.data['files'] as readonly { fileId: string }[]) : [];
    if (!text.trim() && files.length === 0) {
      this.error.set(MESSAGES['comment_empty']);
      this.retry.set(null);
      return;
    }
    this.post(
      this.instanceId(),
      text.trim() ? text : null,
      files.map((file) => file.fileId),
    );
  }

  protected tryAgain(): void {
    this.retry()?.();
  }

  private post(id: string, text: string | null, fileIds: readonly string[]): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.retry.set(null);
    this.api
      .comment(id, text, fileIds, this.key.next())
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: (view) => {
          this.key.settle();
          this.busy.set(false);
          this.prefill.set({});
          this.toasts.show({ tone: 'success', message: 'Comentário enviado.' });
          this.commented.emit(view);
        },
        error: (error: unknown) => {
          const problem = isApiProblem(error) ? error : unexpected();
          this.key.settle(problem);
          this.busy.set(false);
          if (offersRetry(problem)) {
            this.error.set(messageFor('network_error'));
            this.retry.set(() => this.post(id, text, fileIds)); // the same comment, with the same key
            return;
          }
          const message = messageFor(problem.code === 'validation_failed' ? (errorCodes(problem)[0] ?? problem.code) : problem.code, MESSAGES);
          this.error.set(message);
          if (problem.code === 'instance_not_running') {
            this.stale.emit(message);
          } else if (problem.code === 'idempotency_key_reused') {
            this.stale.emit(null); // the timeline shows whether the earlier comment was recorded
          }
        },
      });
  }
}

function unexpected(): ApiProblem {
  return { kind: 'api-problem', status: -1, code: 'unexpected', title: null, errors: [] };
}
