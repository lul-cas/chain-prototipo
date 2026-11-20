import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { map } from 'rxjs';
import { Alert } from '../../../ui/alert/alert';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { WorkflowsApi } from '../workflows-api';
import { SUBPROCESS_TEXTS } from './mappings';
import { ReferenceStep } from './reference-step';
import { StepMappingsEditor } from './step-mappings';

/**
 * A sub-workflow step's process and mappings (workflow-editor.md §10.10): the process, by name, never the one being edited
 * (WF106); a value for each field of its start form, or free keys when it has none (TC-5); and the key each top-level datum
 * it has at completion is kept as.
 */
@Component({
  selector: 'chain-subprocess-step',
  imports: [Alert, FormField, Input, StepMappingsEditor],
  templateUrl: './subprocess-step.html',
  styleUrl: './automation-step.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubprocessStep extends ReferenceStep {
  /** The process being edited, which a step can't call. */
  readonly exclude = input<string | null>(null);

  private readonly api = inject(WorkflowsApi);
  protected readonly idField = 'workflowId';
  protected readonly texts = SUBPROCESS_TEXTS;

  protected listOptions() {
    return this.api.list().pipe(
      map((processes) =>
        processes
          .filter((process) => process.id !== this.exclude())
          .map(({ id, name, latestVersion }) => ({ id, name, latestVersion: latestVersion ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      ),
    );
  }

  protected readContractOf(id: string, version: number) {
    return this.api.contract(id, version);
  }
}
