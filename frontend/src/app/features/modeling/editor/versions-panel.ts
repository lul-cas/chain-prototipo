import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { WorkflowsApi } from '../workflows-api';

export interface VersionsPanelData {
  readonly processId: string;
}

/** "Versões" (workflow-editor.md §10.11): the published versions, newest first; it closes with the version to see. */
@Component({
  selector: 'chain-versions-panel',
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
              <button
                chainButton
                variant="secondary"
                size="sm"
                type="button"
                [attr.aria-label]="'Ver a versão ' + version.versionNumber"
                (click)="ref.close(version.versionNumber)"
              >
                Ver
              </button>
            </li>
          } @empty {
            <li class="chain-versions__muted">O processo ainda não foi publicado.</li>
          }
        </ul>
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
      align-items: center;
      justify-content: space-between;
      gap: var(--chain-space-3);
      padding-block: var(--chain-space-2);
      border-block-end: var(--chain-border-width) solid var(--color-border-subtle);
    }

    .chain-versions__item > span {
      display: flex;
      flex-direction: column;
    }

    .chain-versions__muted {
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VersionsPanel {
  protected readonly ref = inject<DialogRef<number>>(DialogRef);
  private readonly data = inject<VersionsPanelData>(DIALOG_DATA);
  protected readonly versions = signal<readonly { readonly versionNumber: number; readonly publishedAt: string }[] | null>(null);
  protected readonly failed = signal(false);

  constructor() {
    inject(WorkflowsApi)
      .versions(this.data.processId)
      .subscribe({
        next: (versions) => this.versions.set(versions),
        error: () => this.failed.set(true),
      });
  }
}
