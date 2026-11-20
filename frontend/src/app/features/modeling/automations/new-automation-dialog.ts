import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { AutomationsApi } from '../automations-api';
import { NAME_LIMIT, invalidNameText } from '../process-name';

/** "Nova automação" (automation-ui.md §6): asks a name and a description, creates the automation, and closes with its id. */
@Component({
  selector: 'chain-new-automation-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog title="Nova automação">
      <form id="chain-new-automation" class="chain-new-automation" (submit)="create($event)">
        <chain-form-field label="Nome" required [error]="nameError()">
          <input chainInput type="text" [maxLength]="nameLimit" [value]="name()" (input)="name.set(typed($event)); nameError.set(null)" />
        </chain-form-field>
        <chain-form-field label="Descrição" [error]="descriptionError()">
          <textarea chainInput rows="2" maxlength="500" [value]="description()" (input)="description.set(typed($event)); descriptionError.set(null)"></textarea>
        </chain-form-field>
        @if (error(); as message) {
          <chain-alert tone="danger">{{ message }}</chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-new-automation" [loading]="creating()">Criar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-new-automation {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewAutomationDialog {
  protected readonly ref = inject<DialogRef<string>>(DialogRef);
  protected readonly nameLimit = NAME_LIMIT;
  private readonly api = inject(AutomationsApi);

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly nameError = signal<string | null>(null);
  protected readonly descriptionError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected create(event: Event): void {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) {
      this.nameError.set('Informe o nome.');
      return;
    }

    this.creating.set(true);
    this.error.set(null);
    this.api.create(name, this.description()).subscribe({
      next: (id) => this.ref.close(id),
      error: (error: unknown) => {
        this.creating.set(false);
        const problem = isApiProblem(error) ? error : null;
        const codes = problem ? errorCodes(problem) : [];
        if (problem?.code === 'automation_name_taken') {
          this.nameError.set(messageFor(problem.code));
        } else if (codes.includes('invalid_name')) {
          this.nameError.set(invalidNameText(name));
        } else if (codes.includes('description_too_long')) {
          this.descriptionError.set('A descrição pode ter no máximo 500 caracteres.');
        } else if (codes.includes('invalid_description')) {
          this.descriptionError.set(messageFor('invalid_description'));
        } else {
          this.error.set(messageFor(problem?.code ?? 'unexpected'));
        }
      },
    });
  }
}
