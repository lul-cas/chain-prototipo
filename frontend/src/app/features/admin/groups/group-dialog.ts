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
import { GROUP_FIELD_TEXTS, MAX_GROUP_DESCRIPTION, groupDescriptionProblem, groupNameProblem } from './group-rules';
import { Group, GroupsApi, VersionedGroup } from './groups-api';

export interface GroupDialogData {
  /** The group to edit, or null for *Novo grupo*. */
  readonly group: VersionedGroup | null;
}

/** What the dialog closes with: the new group, the saved one, or, after a retry it could not confirm, what the page should say. */
export type GroupDialogResult = { readonly created: Group } | { readonly saved: VersionedGroup } | { readonly uncertain: string };

type Field = 'name' | 'description';

const FIELD_OF: Readonly<Record<string, Field>> = {
  invalid_group_name: 'name',
  group_name_taken: 'name',
  description_too_long: 'description',
  invalid_description: 'description',
};

/** The field a code belongs to; a name every object inherits, such as `constructor`, is not a code (card #188). */
function fieldOf(code: string): Field | undefined {
  return Object.hasOwn(FIELD_OF, code) ? FIELD_OF[code] : undefined;
}

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';
const CREATED_UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Se ela criou o grupo, ele já está na lista.';

/**
 * *Novo grupo* (admin-ui.md §5.1) or *Editar nome e descrição* (§5.2). The rules are checked as the admin types, once a field
 * has text, and every field on **Criar** or **Salvar**; the server's answer wins. An edit sends both fields with `If-Match`,
 * an empty description clearing it, and a 412 offers **Recarregar**. A retry sends the same request (ADR-0010 D4).
 */
@Component({
  selector: 'chain-group-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog [title]="title">
      <form id="chain-group-form" class="chain-group-form" novalidate (submit)="save($event)">
        <chain-form-field label="Nome" required [error]="error('name')">
          <input chainInput type="text" autocomplete="off" [value]="name()" (input)="setName($event)" />
        </chain-form-field>
        <chain-form-field label="Descrição" [hint]="description().length + '/' + maxDescription + ' caracteres'" [error]="error('description')">
          <textarea chainInput rows="3" [value]="description()" (input)="setDescription($event)"></textarea>
        </chain-form-field>
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-group-form__alert">
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
        <button chainButton type="submit" form="chain-group-form" [loading]="saving()">{{ editing ? 'Salvar' : 'Criar' }}</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-group-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-group-form__alert {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupDialog {
  protected readonly ref = inject<DialogRef<GroupDialogResult>>(DialogRef);
  private readonly data = inject<GroupDialogData>(DIALOG_DATA);
  private readonly api = inject(GroupsApi);

  protected readonly editing = this.data.group !== null;
  protected readonly title = this.data.group ? `Editar ${this.data.group.name}` : 'Novo grupo';
  protected readonly maxDescription = MAX_GROUP_DESCRIPTION;
  protected readonly name = signal(this.data.group?.name ?? '');
  protected readonly description = signal(this.data.group?.description ?? '');
  private readonly etag = signal(this.data.group?.etag ?? '');

  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private readonly submitted = signal(false);
  private readonly serverCodes = signal<readonly string[]>([]);
  private pending: (() => void) | null = null;

  /** A field's text: the server's code for it, or its rule once it has text or a save was tried. */
  protected error(field: Field): string | null {
    const value = field === 'name' ? this.name() : this.description();
    const local = field === 'name' ? groupNameProblem(value) : groupDescriptionProblem(value);
    const code = this.serverCodes().find((candidate) => fieldOf(candidate) === field) ?? (local && (value !== '' || this.submitted()) ? local : null);
    return code ? GROUP_FIELD_TEXTS[code] : null;
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.forget('name');
  }

  protected setDescription(event: Event): void {
    this.description.set((event.target as HTMLTextAreaElement).value);
    this.forget('description');
  }

  protected save(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    this.serverCodes.set([]);
    if (groupNameProblem(this.name()) !== null || groupDescriptionProblem(this.description()) !== null) {
      return;
    }
    const group = this.data.group;
    const name = this.name().trim();
    const description = this.description().trim();
    const etag = this.etag();
    this.send(
      () =>
        group
          ? this.api.update(group.id, etag, { name, description }).pipe(map((saved) => ({ saved })))
          : this.api.create(name, description === '' ? null : description).pipe(map((created) => ({ created }))),
      false,
    );
  }

  /** Tentar de novo: the same request, with the same `If-Match`. */
  protected retry(): void {
    this.pending?.();
  }

  /** Recarregar after a 412: what the server has replaces what was typed. */
  protected reload(): void {
    this.api.get(this.data.group!.id).subscribe({
      next: (group) => {
        this.name.set(group.name);
        this.description.set(group.description ?? '');
        this.etag.set(group.etag);
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  private send(request: () => Observable<GroupDialogResult>, retried: boolean): void {
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
        } else if (retried && problem?.code === 'group_name_taken' && !this.editing) {
          this.ref.close({ uncertain: CREATED_UNCONFIRMED });
        } else if (retried && problem?.status === 412) {
          this.ref.close({ uncertain: UNCONFIRMED });
        } else if (problem?.code === 'validation_failed' || problem?.code === 'group_name_taken') {
          const codes = problem.code === 'group_name_taken' ? [problem.code] : errorCodes(problem);
          this.serverCodes.set(codes);
          const unplaced = codes.find((code) => fieldOf(code) === undefined);
          if (unplaced) {
            this.alert.set({ text: messageFor(unplaced) });
          }
        } else if (problem?.status === 412) {
          this.alert.set({ text: 'Este grupo mudou desde que você o abriu.', action: 'reload' });
        } else {
          this.alert.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  /** A field's server code no longer applies once its text changes. */
  private forget(field: Field): void {
    this.serverCodes.update((codes) => codes.filter((code) => fieldOf(code) !== field));
  }
}
