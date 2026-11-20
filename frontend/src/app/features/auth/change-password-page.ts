import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { errorCodes, isApiProblem } from '../../core/http/api-problem';
import { messageFor } from '../../core/http/messages';
import { safeReturnUrl } from '../../core/session/return-url';
import { SessionService } from '../../core/session/session.service';
import { Alert } from '../../ui/alert/alert';
import { BrandMark } from '../../ui/brand/brand-mark';
import { Button } from '../../ui/button/button';
import { FormField } from '../../ui/form-field/form-field';
import { Input } from '../../ui/form-field/input';
import { PasswordField } from '../../ui/form-field/password-field';
import { ToastService } from '../../ui/toast/toast.service';

/** The password policy (identity.md, I1); the browser checks it for convenience, the server decides. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/** Password change, forced after a temporary password or chosen by the user (identity.md, UI). */
@Component({
  selector: 'chain-change-password-page',
  imports: [ReactiveFormsModule, RouterLink, Alert, BrandMark, Button, FormField, Input, PasswordField],
  template: `
    <main class="chain-auth">
      <div class="chain-auth__panel">
        <div class="chain-auth__header">
          <chain-brand-mark wordmark />
          <h1>Trocar senha</h1>
        </div>
        @if (forced()) {
          <chain-alert tone="info" title="Troca obrigatória">
            Por segurança, defina uma nova senha antes de continuar.
          </chain-alert>
        }
        @if (error()) {
          <chain-alert tone="danger">{{ error() }}</chain-alert>
        }
        <form class="chain-auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <chain-form-field label="Senha atual" required [error]="currentError()">
            <chain-password-field>
              <input #current chainInput type="password" formControlName="current" autocomplete="current-password" />
            </chain-password-field>
          </chain-form-field>
          <chain-form-field label="Nova senha" hint="Pelo menos 12 caracteres." required [error]="nextError()">
            <chain-password-field>
              <input #next chainInput type="password" formControlName="next" autocomplete="new-password" />
            </chain-password-field>
          </chain-form-field>
          <chain-form-field label="Confirme a nova senha" required [error]="confirmationError()">
            <chain-password-field>
              <input #confirmation chainInput type="password" formControlName="confirmation" autocomplete="new-password" />
            </chain-password-field>
          </chain-form-field>
          <div class="chain-auth__actions">
            <button chainButton type="submit" [loading]="pending()">Trocar senha</button>
            @if (forced()) {
              <button chainButton variant="ghost" type="button" [loading]="leaving()" (click)="logout()">Sair</button>
            } @else {
              <a chainButton variant="ghost" routerLink="/">Cancelar</a>
            }
          </div>
        </form>
      </div>
    </main>
  `,
  styleUrl: './auth-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangePasswordPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly currentInput = viewChild.required<ElementRef<HTMLInputElement>>('current');
  private readonly nextInput = viewChild.required<ElementRef<HTMLInputElement>>('next');
  private readonly confirmationInput = viewChild.required<ElementRef<HTMLInputElement>>('confirmation');

  protected readonly form = new FormGroup({
    current: new FormControl('', { nonNullable: true }),
    next: new FormControl('', { nonNullable: true }),
    confirmation: new FormControl('', { nonNullable: true }),
  });
  protected readonly forced = computed(() => this.session.mustChangePassword());
  protected readonly pending = signal(false);
  protected readonly leaving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly currentError = signal<string | null>(null);
  protected readonly nextError = signal<string | null>(null);
  protected readonly confirmationError = signal<string | null>(null);

  protected async submit(): Promise<void> {
    const { current, next, confirmation } = this.form.getRawValue();
    this.error.set(null);
    this.currentError.set(current ? null : 'Informe a senha atual.');
    this.nextError.set(
      !next
        ? 'Informe a nova senha.'
        : next.length < MIN_LENGTH
          ? messageFor('password_too_short')
          : next.length > MAX_LENGTH
            ? messageFor('password_too_long')
            : null,
    );
    this.confirmationError.set(!confirmation ? 'Confirme a nova senha.' : confirmation !== next ? 'As senhas não coincidem.' : null);
    if (this.focusFirstInvalid()) {
      return;
    }

    this.pending.set(true);
    try {
      await this.session.changePassword(current, next);
      this.toasts.show({ tone: 'success', message: 'Senha alterada.' });
      await this.router.navigateByUrl(safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')));
    } catch (error: unknown) {
      this.showServerError(error);
    } finally {
      this.pending.set(false);
    }
  }

  protected async logout(): Promise<void> {
    this.leaving.set(true);
    await this.session.logout();
    await this.router.navigateByUrl('/entrar');
  }

  private showServerError(error: unknown): void {
    const policy = isApiProblem(error) ? errorCodes(error).find((code) => code.startsWith('password_')) : undefined;
    if (!isApiProblem(error)) {
      this.error.set(messageFor('unexpected'));
    } else if (error.code === 'invalid_current_password') {
      this.currentError.set(messageFor(error.code));
    } else if (policy) {
      this.nextError.set(messageFor(policy));
    } else {
      this.error.set(messageFor(error.code));
    }
    this.focusFirstInvalid();
  }

  /** Moves focus to the first field with an error; false when there is none. */
  private focusFirstInvalid(): boolean {
    const fields: [string | null, ElementRef<HTMLInputElement>][] = [
      [this.currentError(), this.currentInput()],
      [this.nextError(), this.nextInput()],
      [this.confirmationError(), this.confirmationInput()],
    ];
    const invalid = fields.find(([message]) => !!message);
    invalid?.[1].nativeElement.focus();
    return !!invalid;
  }
}
