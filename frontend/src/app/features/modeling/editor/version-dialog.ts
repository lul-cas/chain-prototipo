import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DraftEditor } from '../../../diagram/draft-editor';
import { WorkflowCanvas } from '../../../diagram/workflow-canvas';
import { WorkflowDocument } from '../../../diagram/workflow-document';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { WorkflowsApi } from '../workflows-api';

export interface VersionDialogData {
  readonly processId: string;
  readonly versionNumber: number;
}

/**
 * A published version, read-only (workflow-editor.md §9, §10.11). It closes with "restore" when the Modeler asks to copy it
 * into the draft. It provides no editor, so the canvas can't edit whatever draft is open behind it.
 */
@Component({
  selector: 'chain-version-dialog',
  imports: [Alert, Button, DialogLayout, WorkflowCanvas],
  providers: [{ provide: DraftEditor, useValue: null }],
  template: `
    <chain-dialog [title]="'Versão ' + data.versionNumber">
      @if (failed()) {
        <chain-alert tone="danger">Não foi possível carregar a versão.</chain-alert>
      } @else if (document(); as shown) {
        <chain-workflow-canvas class="chain-version__canvas" [document]="shown" />
      } @else {
        <p>Carregando a versão…</p>
      }
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" [disabled]="document() === null" (click)="ref.close('restore')">
          Restaurar no rascunho
        </button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-version__canvas {
      block-size: var(--chain-size-canvas-compact);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VersionDialog {
  protected readonly ref = inject<DialogRef<'restore'>>(DialogRef);
  protected readonly data = inject<VersionDialogData>(DIALOG_DATA);
  protected readonly document = signal<WorkflowDocument | null>(null);
  protected readonly failed = signal(false);

  constructor() {
    inject(WorkflowsApi)
      .version(this.data.processId, this.data.versionNumber)
      .subscribe({
        next: (document) => this.document.set(document),
        error: () => this.failed.set(true),
      });
  }
}
