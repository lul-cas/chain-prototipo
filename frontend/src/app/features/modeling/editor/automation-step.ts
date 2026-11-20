import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Alert } from '../../../ui/alert/alert';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { AutomationsApi } from '../automations-api';
import { ReferenceStep } from './reference-step';
import { StepMappingsEditor } from './step-mappings';

export type { StepResult } from './reference-step';

/**
 * An automatic step's automation and mappings (workflow-editor.md §10.9): the automation, by name; a value for each input its
 * latest version declares; and the key each output is kept as. What it doesn't edit is shown as text, and kept.
 */
@Component({
  selector: 'chain-automation-step',
  imports: [Alert, FormField, Input, StepMappingsEditor],
  templateUrl: './automation-step.html',
  styleUrl: './automation-step.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationStep extends ReferenceStep {
  private readonly api = inject(AutomationsApi);
  protected readonly idField = 'automationId';

  protected listOptions() {
    return this.api.list();
  }

  protected readContractOf(id: string, version: number) {
    return this.api.contract(id, version);
  }
}
