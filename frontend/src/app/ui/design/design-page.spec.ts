import { Component } from '@angular/core';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { provideJsdomInteractivity } from '../../../testing/jsdom-interactivity';
import { THEMES, ThemeName, applyTheme } from '../../../testing/themes';
import { ToastRegion } from '../toast/toast-region';
import { DesignPage } from './design-page';

@Component({
  imports: [DesignPage, ToastRegion],
  template: `<chain-design-page /><chain-toast-region />`,
})
class Host {}

describe.each(THEMES)('Design page (%s theme)', (theme: ThemeName) => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('chain.theme', theme);
    applyTheme(theme);
  });

  async function openPage() {
    return render(Host, {
      providers: [provideRouter([]), provideJsdomInteractivity()],
    });
  }

  it('shows the identity inside the app shell', async () => {
    await openPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Sistema de design' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Tema' })).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Nome de usuário/ })).toBeTruthy();
    expect(screen.getByLabelText('Senha', { selector: 'input' })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('moves focus from the skip link through the theme and into a field', async () => {
    await openPage();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Pular para o conteúdo' }));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('main'));

    (document.activeElement as HTMLElement).blur();
    await user.tab();
    await user.tab();
    await user.tab();
    expect((document.activeElement as HTMLInputElement).type).toBe('radio');
    const before = document.documentElement.getAttribute('data-theme');
    await user.keyboard('{ArrowRight}');
    expect(document.documentElement.getAttribute('data-theme')).not.toBe(before);

    const field = screen.getByRole('textbox', { name: /Nome de usuário/ });
    field.focus();
    await user.keyboard('ana silva');
    expect(screen.getByText('O nome de usuário não pode ter espaços.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('opens a dialog from the keyboard and keeps focus inside it', async () => {
    await openPage();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Abrir diálogo' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Arquivar o grupo?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('shows a toast and closes it from the keyboard', async () => {
    const view = await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Aviso de Sucesso/ }));
    view.fixture.detectChanges();
    expect(await screen.findByText('Tarefa concluída.')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Fechar notificação' });
    close.focus();
    await user.keyboard('{Enter}');
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    expect(screen.queryByText('Tarefa concluída.')).toBeNull();
  });
});
