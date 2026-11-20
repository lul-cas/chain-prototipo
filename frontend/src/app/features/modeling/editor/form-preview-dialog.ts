import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormRenderer } from '../../../forms/form-renderer';
import { FormDocument } from '../../../forms/model';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';

export interface FormPreviewData {
  readonly name: string;
  readonly document: FormDocument;
}

/** A form's latest version, read-only, as the node panel's "Visualizar" shows it (workflow-editor.md §10.5). */
@Component({
  selector: 'chain-form-preview-dialog',
  imports: [DialogLayout, FormRenderer],
  template: `
    <chain-dialog [title]="data.name">
      <chain-form-renderer [document]="data.document" disabled />
    </chain-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormPreviewDialog {
  protected readonly data = inject<FormPreviewData>(DIALOG_DATA);
}
