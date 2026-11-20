import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { AutomationResources, AutomationVersion, AutomationVersionSummary, AutomationsApi } from '../automations-api';
import { typeLabel } from '../editor/type-labels';
import { readDocument } from './automation-document';
import { callPreview } from './call-preview';
import { formatPath } from './output-path';

export interface AutomationVersionsData {
  readonly automationId: string;
  /** To draw a version's call against its destination's address. */
  readonly resources: AutomationResources | null;
}

/** What the panel closes with: the version to restore into the draft, which the page asks about first. */
export interface VersionChoice {
  readonly restore: number;
}

/**
 * Versões (automation-ui.md §8.4, AS6): the published versions, newest first. Each can be seen read-only or restored into the
 * draft; restoring closes the panel so the editor asks first. The publisher is a user id only, so it isn't shown.
 */
@Component({
  selector: 'chain-automation-versions-panel',
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
            <li class="chain-versions__muted">A automação ainda não foi publicada.</li>
          }
        </ul>
        @if (versionFailed()) {
          <chain-alert tone="danger">Não foi possível abrir a versão.</chain-alert>
        }
      }
    </chain-dialog>
  `,
  styleUrl: './automation-versions.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationVersionsPanel {
  protected readonly ref = inject<DialogRef<VersionChoice>>(DialogRef);
  private readonly data = inject<AutomationVersionsData>(DIALOG_DATA);
  private readonly api = inject(AutomationsApi);
  private readonly dialogs = inject(DialogService);

  protected readonly versions = signal<readonly AutomationVersionSummary[] | null>(null);
  protected readonly failed = signal(false);
  protected readonly versionFailed = signal(false);

  constructor() {
    this.api.versions(this.data.automationId).subscribe({
      next: (versions) => this.versions.set(versions),
      error: () => this.failed.set(true),
    });
  }

  protected view(versionNumber: number): void {
    this.versionFailed.set(false);
    this.api.version(this.data.automationId, versionNumber).subscribe({
      next: (version) => this.dialogs.open<void, AutomationVersionData>(AutomationVersionDialog, { data: { version, resources: this.data.resources }, size: 'lg' }),
      error: () => this.versionFailed.set(true),
    });
  }
}

export interface AutomationVersionData {
  readonly version: AutomationVersion;
  readonly resources: AutomationResources | null;
}

/**
 * A published version, read-only (§8.4): its call as the preview draws it, its inputs and outputs, and its JSON. The editor's
 * sections are editing controls, so the version is drawn apart *[review]*.
 */
@Component({
  selector: 'chain-automation-version-dialog',
  imports: [DatePipe, DialogLayout],
  template: `
    <chain-dialog [title]="'Versão ' + data.version.versionNumber">
      <p class="chain-versions__muted">
        Publicada em <time [attr.datetime]="data.version.publishedAt">{{ data.version.publishedAt | date: 'dd/MM/yyyy HH:mm' }}</time>
      </p>
      <h3>Chamada</h3>
      <pre class="chain-mono chain-versions__code" tabindex="0" aria-label="Chamada desta versão">{{ preview() }}</pre>
      <h3>Entradas</h3>
      <ul class="chain-versions__fields">
        @for (field of document().inputs; track $index) {
          <li><code>{{ field.key }}</code>: {{ type(field.type) }}{{ field.required ? ', obrigatória' : '' }}</li>
        } @empty {
          <li class="chain-versions__muted">Nenhuma entrada.</li>
        }
      </ul>
      <h3>Saídas</h3>
      <ul class="chain-versions__fields">
        @for (field of document().outputs; track $index) {
          <li>
            <code>{{ field.key }}</code>: {{ type(field.type) }}{{ field.required ? ', obrigatória' : '' }},
            {{ field.source === 'status' ? 'status HTTP' : 'do corpo, em ' + path(field.path) }}
          </li>
        } @empty {
          <li class="chain-versions__muted">Nenhuma saída.</li>
        }
      </ul>
      <h3>JSON</h3>
      <pre class="chain-mono chain-versions__code" tabindex="0" aria-label="JSON desta versão" data-testid="version-json">{{ json }}</pre>
    </chain-dialog>
  `,
  styleUrl: './automation-versions.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationVersionDialog {
  protected readonly data = inject<AutomationVersionData>(DIALOG_DATA);
  protected readonly document = computed(() => readDocument(this.data.version.document));
  protected readonly preview = computed(() => {
    const document = this.document();
    return callPreview(document, this.data.resources?.destinations.find((candidate) => candidate.name === document.request.destination) ?? null);
  });
  protected readonly json = JSON.stringify(this.data.version.document, null, 2);
  protected readonly type = typeLabel;

  protected path(segments: readonly (string | number)[] | undefined): string {
    return formatPath(segments ?? []);
  }
}
