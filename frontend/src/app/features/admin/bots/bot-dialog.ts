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
import { displayNameProblem } from '../users/user-rules';
import { BOT_FIELD_TEXTS, botNameProblem } from './bot-rules';
import { Bot, BotsApi, VersionedBot } from './bots-api';

export interface BotDialogData {
  /** The bot to rename, or null for *Novo bot*. */
  readonly bot: VersionedBot | null;
}

/** What the dialog closes with: the new bot, the renamed one, or, after a retry it could not confirm, what the page should say. */
export type BotDialogResult = { readonly created: Bot } | { readonly saved: VersionedBot } | { readonly uncertain: string };

type Field = 'name' | 'displayName';

const FIELD_OF: Readonly<Record<string, Field>> = {
  invalid_name: 'name',
  username_taken: 'name',
  invalid_display_name: 'displayName',
};

/** The field a code belongs to; a name every object inherits, such as `constructor`, is not a code (card #188). */
function fieldOf(code: string): Field | undefined {
  return Object.hasOwn(FIELD_OF, code) ? FIELD_OF[code] : undefined;
}

const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';
const CREATED_UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Se ela criou o bot, ele já está na lista.';

/**
 * *Novo bot* (admin-ui.md §6.1) or *Editar nome* (§6.2). The rules are checked as the admin types, once a field has text, and
 * every field on **Criar** or **Salvar**; the server's answer wins. A rename sends `If-Match`, and a 412 offers **Recarregar**.
 * A retry sends the same request (ADR-0010 D4).
 */
@Component({
  selector: 'chain-bot-dialog',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog [title]="title">
      <form id="chain-bot-form" class="chain-bot-form" novalidate (submit)="save($event)">
        @if (!editing) {
          <chain-form-field label="Identificador" required hint="Aparece nos registros e nos tokens. Não pode ser trocado depois." [error]="error('name')">
            <input chainInput class="chain-mono" type="text" autocomplete="off" spellcheck="false" [value]="name()" (input)="setName($event)" />
          </chain-form-field>
        }
        <chain-form-field label="Nome" required [error]="error('displayName')">
          <input chainInput type="text" autocomplete="off" [value]="displayName()" (input)="setDisplayName($event)" />
        </chain-form-field>
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-bot-form__alert">
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
        <button chainButton type="submit" form="chain-bot-form" [loading]="saving()">{{ editing ? 'Salvar' : 'Criar' }}</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-bot-form {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-bot-form__alert {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotDialog {
  protected readonly ref = inject<DialogRef<BotDialogResult>>(DialogRef);
  private readonly data = inject<BotDialogData>(DIALOG_DATA);
  private readonly api = inject(BotsApi);

  protected readonly editing = this.data.bot !== null;
  protected readonly title = this.data.bot ? `Editar ${this.data.bot.displayName}` : 'Novo bot';
  protected readonly name = signal('');
  protected readonly displayName = signal(this.data.bot?.displayName ?? '');
  private readonly etag = signal(this.data.bot?.etag ?? '');

  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private readonly submitted = signal(false);
  private readonly serverCodes = signal<readonly string[]>([]);
  private pending: (() => void) | null = null;

  /** A field's text: the server's code for it, or its rule once it has text or a save was tried. */
  protected error(field: Field): string | null {
    const value = field === 'name' ? this.name() : this.displayName();
    const local = field === 'name' ? botNameProblem(value) : displayNameProblem(value);
    const code = this.serverCodes().find((candidate) => fieldOf(candidate) === field) ?? (local && (value !== '' || this.submitted()) ? local : null);
    return code ? BOT_FIELD_TEXTS[code] : null;
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.forget('name');
  }

  protected setDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
    this.forget('displayName');
  }

  protected save(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    this.serverCodes.set([]);
    const bot = this.data.bot;
    if ((!bot && botNameProblem(this.name()) !== null) || displayNameProblem(this.displayName()) !== null) {
      return;
    }
    const name = this.name().trim();
    const displayName = this.displayName().trim();
    const etag = this.etag();
    this.send(
      () =>
        bot
          ? this.api.update(bot.id, etag, displayName).pipe(map((saved) => ({ saved })))
          : this.api.create(name, displayName).pipe(map((created) => ({ created }))),
      false,
    );
  }

  /** Tentar de novo: the same request, with the same `If-Match`. */
  protected retry(): void {
    this.pending?.();
  }

  /** Recarregar after a 412: what the server has replaces what was typed. */
  protected reload(): void {
    this.api.get(this.data.bot!.id).subscribe({
      next: (bot) => {
        this.displayName.set(bot.displayName);
        this.etag.set(bot.etag);
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  private send(request: () => Observable<BotDialogResult>, retried: boolean): void {
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
          this.alert.set({ text: 'Este bot mudou desde que você o abriu.', action: 'reload' });
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
