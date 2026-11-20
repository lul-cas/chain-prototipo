import { signal } from '@angular/core';
import { ReactiveFormsModule, FormControl, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { FormField } from './form-field';
import { Input } from './input';
import { PasswordField } from './password-field';

const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim());

describe.each(THEMES)('FormField with a text input (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  it('labels the control and describes it with the hint', async () => {
    await render(
      `<chain-form-field label="Nome de usuário" hint="Use letras minúsculas.">
         <input chainInput type="text" autocomplete="username" />
       </chain-form-field>`,
      { imports: [FormField, Input] },
    );
    const input = screen.getByRole('textbox', { name: 'Nome de usuário' });
    expect(describedBy(input)).toEqual(['Use letras minúsculas.']);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    await expectNoAxeViolations();
  });

  it('marks a required field for assistive technology and shows a visual marker', async () => {
    await render(
      `<chain-form-field label="Senha atual" [required]="true"><input chainInput type="text" /></chain-form-field>`,
      { imports: [FormField, Input] },
    );
    const input = screen.getByRole('textbox', { name: /Senha atual/ });
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('obrigatório', { exact: false })).toBeTruthy();
  });

  it('shows an error, marks the control invalid and describes it with the error', async () => {
    const error = signal<string | null>(null);
    const { fixture } = await render(
      `<chain-form-field label="E-mail" hint="Usado para avisos." [error]="error()">
         <input chainInput type="email" />
       </chain-form-field>`,
      { imports: [FormField, Input], componentProperties: { error } },
    );
    const input = screen.getByRole('textbox', { name: 'E-mail' });

    error.set('Informe um e-mail válido.');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(input)).toEqual(['Usado para avisos.', 'Informe um e-mail válido.']);
    await expectNoAxeViolations();

    error.set(null);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(describedBy(input)).toEqual(['Usado para avisos.']);
  });

  it('announces errors through a live region that exists before the error appears', async () => {
    await render(`<chain-form-field label="Nome"><input chainInput /></chain-form-field>`, {
      imports: [FormField, Input],
    });
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('gives every field its own ids', async () => {
    await render(
      `<chain-form-field label="A" hint="a"><input chainInput /></chain-form-field>
       <chain-form-field label="B" hint="b"><input chainInput /></chain-form-field>`,
      { imports: [FormField, Input] },
    );
    const [a, b] = screen.getAllByRole('textbox');
    expect(a.id).not.toBe(b.id);
    expect(a.getAttribute('aria-describedby')).not.toBe(b.getAttribute('aria-describedby'));
  });

  it('focuses the text field from the keyboard', async () => {
    await render(
      `<chain-form-field label="Nome de usuário" hint="Use letras minúsculas.">
         <input chainInput type="text" autocomplete="username" />
       </chain-form-field>`,
      { imports: [FormField, Input] },
    );
    const user = userEvent.setup();
    await user.tab();
    const input = screen.getByRole('textbox', { name: 'Nome de usuário' });
    expect(document.activeElement).toBe(input);
    await user.keyboard('ana');
    expect((input as HTMLInputElement).value).toBe('ana');
  });

  it('works with reactive forms', async () => {
    const control = new FormControl('', { nonNullable: true, validators: Validators.required });
    await render(`<chain-form-field label="Nome"><input chainInput [formControl]="control" /></chain-form-field>`, {
      imports: [FormField, Input, ReactiveFormsModule],
      componentProperties: { control },
    });
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Nome' }), 'Ana');
    expect(control.value).toBe('Ana');
  });
});

describe.each(THEMES)('PasswordField (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  async function renderPassword() {
    await render(
      `<chain-form-field label="Senha">
         <chain-password-field><input chainInput type="password" autocomplete="current-password" /></chain-password-field>
       </chain-form-field>`,
      { imports: [FormField, Input, PasswordField] },
    );
    return {
      input: screen.getByLabelText('Senha', { selector: 'input' }) as HTMLInputElement,
      toggle: screen.getByRole('button', { name: 'Mostrar senha' }),
    };
  }

  it('hides the password by default and offers a toggle button', async () => {
    const { input, toggle } = await renderPassword();
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(input.id);
    expect(toggle.getAttribute('type')).toBe('button');
    await expectNoAxeViolations();
  });

  it('reveals and hides the password from the keyboard, keeping the typed value', async () => {
    const { input, toggle } = await renderPassword();
    const user = userEvent.setup();
    await user.type(input, 'segredo-longo');
    await user.tab();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard('{Enter}');
    expect(input.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(input.value).toBe('segredo-longo');

    await user.keyboard(' ');
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});
