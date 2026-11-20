import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentType } from '@angular/cdk/portal';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ConfirmDialog, ConfirmOptions } from './confirm-dialog';

/** The widths of centered dialogs, or `side`: a panel at the right edge, full height (workflow-editor.md §10.5). */
export type DialogSize = 'sm' | 'md' | 'lg' | 'side';

export interface DialogOptions<D> {
  readonly data?: D;
  readonly size?: DialogSize;
  /** Describe the dialog by its body (short confirmations); leave off for dialogs holding forms. */
  readonly describedByBody?: boolean;
}

let nextId = 0;

/**
 * Opens Chain dialogs on the CDK dialog (design-system.md §4.5). The CDK supplies role="dialog",
 * aria-modal, the focus trap, Escape, and focus restoration; this service adds Chain's panel,
 * backdrop and the title and description ids used by the `chain-dialog` layout.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  open<R = unknown, D = unknown, C = unknown>(component: ComponentType<C>, options: DialogOptions<D> = {}): DialogRef<R, C> {
    const id = `chain-dialog-${nextId++}`;
    return this.dialog.open<R, D, C>(component, {
      id,
      data: options.data,
      ariaLabelledBy: `${id}-title`,
      ariaDescribedBy: options.describedByBody ? `${id}-body` : null,
      ariaModal: true,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      hasBackdrop: true,
      backdropClass: 'chain-dialog-backdrop',
      panelClass: ['chain-dialog-pane', `chain-dialog-pane--${options.size ?? 'md'}`],
      ...(options.size === 'side' ? { positionStrategy: this.overlay.position().global().right('0').top('0') } : {}),
    });
  }

  /** Asks a yes/no question. Emits true only when the confirm button is used. */
  confirm(options: ConfirmOptions): Observable<boolean> {
    return this.open<boolean, ConfirmOptions>(ConfirmDialog, { data: options, size: 'sm', describedByBody: true }).closed.pipe(
      map((answer) => answer === true),
    );
  }
}
