import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Observable, map } from 'rxjs';
import { errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { USER_FIELD_TEXTS, displayNameProblem, usernameProblem } from './user-rules';
import { CreatedUser, UsersApi, VersionedUser } from './users-api';

export interface UserDialogData {
  /** The user to edit, or null for *Novo usuário*. */
  readonly user: VersionedUser | null;
}

/** What the dialog closes with: the new user and its password, the saved user, or, after a retry it could not confirm, what the page should say. */
export type UserDialogResult = { readonly created: CreatedUser } | { readonly saved: VersionedUser } | { readonly uncertain: string };

type Field = 'username' | 'displayName';

const FIELD_OF: Readonly<Record<string, Field>> = {
  invalid_username: 'username',
  username_taken: 'username',
  invalid_display_name: 'displayName',
};
/** The field a code belongs to; a name every object inherits, such as `constructor`, is not a code (card #188). */
function fieldOf(code: string): Field | undefined {
  return Object.hasOwn(FIELD_OF, code) ? FIELD_OF[code] : undefined;
}

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';
const CREATED_UNCONFIRMED =
  'Não foi possível confirmar a tentativa anterior. Se ela criou o usuário, a senha temporária se perdeu: redefina a senha na página do usuário.';

/**
 * *Novo usuário* (admin-ui.md §4.1) or *Editar* (§4.2). The rules are checked as the admin types, once a field has text, and
 * every field on **Criar** or **Salvar**; the server's answer wins. An edit sends `If-Match`, and a 412 offers **Recarregar**.
 * A retry sends the same request: a username then in use, or a 412, may be the first attempt's doing (ADR-0010 D4).
 */
@Component({
  selector: 'chain-user-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog [title]="title">
      <form id="chain-user-form" class="chain-user-form" novalidate (submit)="save($event)">
        @if (!editing) {
          <chain-form-field label="Usuário" required hint="Usado para entrar. Não pode ser trocado depois." [error]="error('username')">
            <input chainInput class="chain-mono" type="text" autocomplete="off" spellcheck="false" [value]="username()" (input)="setUsername($event)" />
          </chain-form-field>
        }
        <chain-form-field label="Nome" required [error]="error('displayName')">
          <input chainInput type="text" autocomplete="off" [value]="displayName()" (input)="setDisplayName($event)" />
        </chain-form-field>
        <label class="chain-user-form__check">
          <input type="checkbox" [checked]="isAdmin()" (change)="isAdmin.set(checked($event))" />
          Administrador
        </label>
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-user-form__alert">
              {{ current.text }}
              @if (current.action === 'reload') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="reload()">Recarregar</button>
              }
              @if (current.action === 'retry') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="retry()">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-user-form" [loading]="saving()">{{ editing ? 'Salvar' : 'Criar' }}</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-user-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-user-form__check,
    .chain-user-form__alert {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserDialog {
  protected readonly ref = inject<DialogRef<UserDialogResult>>(DialogRef);
  private readonly data = inject<UserDialogData>(DIALOG_DATA);
  private readonly api = inject(UsersApi);

  protected readonly editing = this.data.user !== null;
  protected readonly title = this.data.user ? `Editar ${this.data.user.displayName}` : 'Novo usuário';
  protected readonly username = signal('');
  protected readonly displayName = signal(this.data.user?.displayName ?? '');
  protected readonly isAdmin = signal(this.data.user?.isAdmin ?? false);
  private readonly etag = signal(this.data.user?.etag ?? '');

  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private readonly submitted = signal(false);
  private readonly serverCodes = signal<readonly string[]>([]);
  private pending: (() => void) | null = null;

  /** A field's text: the server's code for it, or its rule once it has text or a save was tried. */
  protected error(field: Field): string | null {
    const value = field === 'username' ? this.username() : this.displayName();
    const local = field === 'username' ? usernameProblem(value) : displayNameProblem(value);
    const code = this.serverCodes().find((candidate) => fieldOf(candidate) === field) ?? (local && (value !== '' || this.submitted()) ? local : null);
    return code ? USER_FIELD_TEXTS[code] : null;
  }

  protected setUsername(event: Event): void {
    this.username.set(this.text(event));
    this.forget('username');
  }

  protected setDisplayName(event: Event): void {
    this.displayName.set(this.text(event));
    this.forget('displayName');
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected save(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    this.serverCodes.set([]);
    const user = this.data.user;
    const problems = [user ? null : usernameProblem(this.username()), displayNameProblem(this.displayName())];
    if (problems.some((problem) => problem !== null)) {
      return;
    }
    const username = this.username().trim();
    const displayName = this.displayName().trim();
    const isAdmin = this.isAdmin();
    const etag = this.etag();
    this.send(
      () =>
        user
          ? this.api.update(user.id, etag, { displayName, isAdmin }).pipe(map((saved) => ({ saved })))
          : this.api.create(username, displayName, isAdmin).pipe(map((created) => ({ created }))),
      false,
    );
  }

  /** Tentar de novo: the same request, with the same `If-Match`. */
  protected retry(): void {
    this.pending?.();
  }

  /** Recarregar after a 412: what the server has replaces what was typed. */
  protected reload(): void {
    this.api.get(this.data.user!.id).subscribe({
      next: (user) => {
        this.displayName.set(user.displayName);
        this.isAdmin.set(user.isAdmin);
        this.etag.set(user.etag);
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  private send(request: () => Observable<UserDialogResult>, retried: boolean): void {
    this.saving.set(true);
    this.alert.set(null);
    this.pending = null;
    request().subscribe({
      next: (result) => this.ref.close(result),
      error: (error: unknown) => {
        this.saving.set(false);
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.pending = () => this.send(request, true);
          this.alert.set({ text: 'Não foi possível confirmar o envio.', action: 'retry' });
        } else if (retried && problem?.code === 'username_taken') {
          this.ref.close({ uncertain: CREATED_UNCONFIRMED });
        } else if (retried && problem?.status === 412) {
          this.ref.close({ uncertain: UNCONFIRMED });
        } else if (problem?.code === 'validation_failed' || problem?.code === 'username_taken') {
          const codes = problem.code === 'username_taken' ? [problem.code] : errorCodes(problem);
          this.serverCodes.set(codes);
          const unplaced = codes.find((code) => fieldOf(code) === undefined);
          if (unplaced) {
            this.alert.set({ text: messageFor(unplaced) });
          }
        } else if (problem?.status === 412) {
          this.alert.set({ text: 'Este usuário mudou desde que você o abriu.', action: 'reload' });
        } else {
          this.alert.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  private text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /** A field's server code no longer applies once its text changes. */
  private forget(field: Field): void {
    this.serverCodes.update((codes) => codes.filter((code) => fieldOf(code) !== field));
  }
}
