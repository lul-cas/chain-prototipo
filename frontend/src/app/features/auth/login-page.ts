import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { isApiProblem } from '../../core/http/api-problem';
import { messageFor } from '../../core/http/messages';
import { safeReturnUrl } from '../../core/session/return-url';
import { SessionService } from '../../core/session/session.service';
import { Alert } from '../../ui/alert/alert';
import { BrandMark } from '../../ui/brand/brand-mark';
import { Button } from '../../ui/button/button';
import { FormField } from '../../ui/form-field/form-field';
import { Input } from '../../ui/form-field/input';
import { PasswordField } from '../../ui/form-field/password-field';

/** Login (identity.md, UI): one generic message for every failed login, as the API gives. */
@Component({
  selector: 'chain-login-page',
  imports: [ReactiveFormsModule, Alert, BrandMark, Button, FormField, Input, PasswordField],
  template: `
    <main class="chain-auth">
      <div class="chain-auth__panel">
        <div class="chain-auth__header">
          <chain-brand-mark wordmark />
          <h1>Entrar</h1>
          <p class="chain-auth__lead">Use o seu usuário e a sua senha do Chain.</p>
        </div>
        @if (error()) {
          <chain-alert tone="danger">{{ error() }}</chain-alert>
        }
        <form class="chain-auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <chain-form-field label="Usuário" required [error]="usernameError()">
            <input
              #username
              chainInput
              type="text"
              formControlName="username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
            />
          </chain-form-field>
          <chain-form-field label="Senha" required [error]="passwordError()">
            <chain-password-field>
              <input #password chainInput type="password" formControlName="password" autocomplete="current-password" />
            </chain-password-field>
          </chain-form-field>
          <div class="chain-auth__actions">
            <button chainButton type="submit" [loading]="pending()">Entrar</button>
          </div>
        </form>
      </div>
    </main>
  `,
  styleUrl: './auth-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly usernameInput = viewChild.required<ElementRef<HTMLInputElement>>('username');
  private readonly passwordInput = viewChild.required<ElementRef<HTMLInputElement>>('password');

  protected readonly form = new FormGroup({
    username: new FormControl('', { nonNullable: true }),
    password: new FormControl('', { nonNullable: true }),
  });
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly usernameError = signal<string | null>(null);
  protected readonly passwordError = signal<string | null>(null);

  protected async submit(): Promise<void> {
    const username = this.form.controls.username.value.trim();
    const password = this.form.controls.password.value;
    this.error.set(null);
    this.usernameError.set(username ? null : 'Informe o usuário.');
    this.passwordError.set(password ? null : 'Informe a senha.');
    if (!username || !password) {
      (username ? this.passwordInput() : this.usernameInput()).nativeElement.focus();
      return;
    }

    this.pending.set(true);
    try {
      const me = await this.session.login(username, password);
      const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
      await this.router.navigateByUrl(
        me.mustChangePassword
          ? this.router.createUrlTree(['/trocar-senha'], { queryParams: returnUrl === '/' ? {} : { returnUrl } })
          : returnUrl,
      );
    } catch (error: unknown) {
      this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected'));
    } finally {
      this.pending.set(false);
    }
  }
}
