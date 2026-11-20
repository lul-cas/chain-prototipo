import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormDocument } from '../../../forms/model';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormPreviewData, FormPreviewDialog } from '../editor/form-preview-dialog';
import { FormVersionSummary, FormsApi } from '../forms-api';
import { ServerTestData, ServerTestDialog } from './server-test-dialog';

export interface FormVersionsData {
  readonly formId: string;
}

/** What the panel closes with: the version to restore into the draft, which the page asks about first. */
export interface VersionChoice {
  readonly restore: number;
}

/**
 * Versões (form-designer.md §9.7, N3g): the published versions, newest first. Each can be seen read-only, tested on the
 * server, or restored into the draft; restoring closes the panel so the designer asks first.
 */
@Component({
  selector: 'chain-form-versions-panel',
  imports: [Alert, Button, DatePipe, DialogLayout],
  template: `
    <chain-dialog title="Versões">
      @if (failed()) {
        <chain-alert tone="danger">Não foi possível carregar as versões.</chain-alert>
      } @else if (versions() === null) {
        <p class="chain-versions__muted">Carregando as versões…</p>
      } @else {
        <ul class="chain-versions">
          @for (version of versions(); track version.versionNumber) {
            <li class="chain-versions__item">
              <span>
                <strong>Versão {{ version.versionNumber }}</strong>
                <span class="chain-versions__muted">
                  publicada em <time [attr.datetime]="version.publishedAt">{{ version.publishedAt | date: 'dd/MM/yyyy HH:mm' }}</time>
                </span>
              </span>
              <span class="chain-versions__actions">
                <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Visualizar a versão ' + version.versionNumber" (click)="view(version.versionNumber)">
                  Visualizar
                </button>
                <button chainButton variant="ghost" size="sm" type="button" [attr.aria-label]="'Testar a versão ' + version.versionNumber" (click)="test(version.versionNumber)">
                  Testar
                </button>
                <button
                  chainButton
                  variant="secondary"
                  size="sm"
                  type="button"
                  [attr.aria-label]="'Restaurar a versão ' + version.versionNumber + ' no rascunho'"
                  (click)="ref.close({ restore: version.versionNumber })"
                >
                  Restaurar no rascunho
                </button>
              </span>
            </li>
          } @empty {
            <li class="chain-versions__muted">O formulário ainda não foi publicado.</li>
          }
        </ul>
        @if (versionFailed()) {
          <chain-alert tone="danger">Não foi possível abrir a versão.</chain-alert>
        }
      }
    </chain-dialog>
  `,
  styles: `
    .chain-versions {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chain-versions__item {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--chain-space-2) var(--chain-space-3);
      padding-block: var(--chain-space-2);
      border-block-end: var(--chain-border-width) solid var(--color-border-subtle);
    }

    .chain-versions__item > span:first-child {
      display: flex;
      flex-direction: column;
    }

    .chain-versions__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--chain-space-1);
    }

    .chain-versions__muted {
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormVersionsPanel {
  protected readonly ref = inject<DialogRef<VersionChoice>>(DialogRef);
  private readonly data = inject<FormVersionsData>(DIALOG_DATA);
  private readonly api = inject(FormsApi);
  private readonly dialogs = inject(DialogService);

  protected readonly versions = signal<readonly FormVersionSummary[] | null>(null);
  protected readonly failed = signal(false);
  protected readonly versionFailed = signal(false);

  constructor() {
    this.api.versions(this.data.formId).subscribe({
      next: (versions) => this.versions.set(versions),
      error: () => this.failed.set(true),
    });
  }

  protected view(versionNumber: number): void {
    this.withDocument(versionNumber, (document) =>
      this.dialogs.open<void, FormPreviewData>(FormPreviewDialog, { data: { name: `Versão ${versionNumber}`, document }, size: 'lg' }),
    );
  }

  protected test(versionNumber: number): void {
    this.withDocument(versionNumber, (document) =>
      this.dialogs.open<void, ServerTestData>(ServerTestDialog, { data: { formId: this.data.formId, versionNumber, document }, size: 'lg' }),
    );
  }

  private withDocument(versionNumber: number, then: (document: FormDocument) => void): void {
    this.versionFailed.set(false);
    this.api.version(this.data.formId, versionNumber).subscribe({
      next: then,
      error: () => this.versionFailed.set(true),
    });
  }
}
