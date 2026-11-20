import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Button } from '../../ui/button/button';
import { DialogLayout } from '../../ui/dialog/dialog-layout';
import { BrokenVersion } from './in-use';

/** One list of what uses an item, such as *Credenciais que o permitem*. */
export interface InUseSection {
  readonly title: string;
  readonly items: readonly string[];
  readonly note?: string;
}

export interface InUseData {
  readonly title: string;
  readonly sections: readonly InUseSection[];
  /** The published versions a change would break, with the rules they would fail (Q-AS3 (a)). */
  readonly versions: readonly BrokenVersion[];
  /** What forcing does. */
  readonly consequence: string;
  readonly forceLabel: string;
}

/**
 * An item in use (automation-ui.md §3.3, §4.5): what uses it, from the 409, and what forcing does. Cancelar has the focus;
 * the forcing button is destructive. Closes with true to force.
 */
@Component({
  selector: 'chain-in-use-dialog',
  imports: [Button, DialogLayout],
  template: `
    <chain-dialog [title]="data.title">
      @for (section of sections; track section.title) {
        <h3 class="chain-in-use__title">{{ section.title }}</h3>
        <ul>
          @for (item of section.items; track item) {
            <li><code>{{ item }}</code></li>
          }
        </ul>
        @if (section.note) {
          <p class="chain-in-use__note">{{ section.note }}</p>
        }
      }
      @if (data.versions.length > 0) {
        <h3 class="chain-in-use__title">Versões que deixariam de funcionar</h3>
        <ul>
          @for (version of data.versions; track version.automation + version.version) {
            <li>
              <code>{{ version.automation }}</code>, versão {{ version.version }}:
              @for (error of version.errors; track $index) {
                <span class="chain-in-use__error">{{ error.code }} {{ error.message }}</span>
              }
            </li>
          }
        </ul>
      }
      <p>{{ data.consequence }}</p>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" cdkFocusInitial (click)="ref.close(false)">Cancelar</button>
        <button chainButton variant="danger" type="button" (click)="ref.close(true)">{{ data.forceLabel }}</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-in-use__title {
      margin-block: var(--chain-space-3) var(--chain-space-1);
      font-size: var(--chain-font-size-md);
    }

    .chain-in-use__note {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }

    .chain-in-use__error {
      display: block;
      color: var(--color-text-muted);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InUseDialog {
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
  protected readonly data = inject<InUseData>(DIALOG_DATA);
  protected readonly sections = this.data.sections.filter((section) => section.items.length > 0);
}
