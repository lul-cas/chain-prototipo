import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterLink, RouterLinkActive, provideRouter } from '@angular/router';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { NavItem } from './nav-item';
import { Shell } from './shell';

@Component({ template: `<h1>Página</h1>` })
class Page {}

@Component({
  imports: [Shell, NavItem, RouterLink, RouterLinkActive],
  template: `
    <chain-shell>
      <span chainShellBrand>Chain</span>
      <button chainShellActions type="button">Sair</button>
      <ng-container chainShellNav>
        <a chainNavItem routerLink="/inbox" routerLinkActive ariaCurrentWhenActive="page">Caixa de entrada</a>
        <a chainNavItem routerLink="/requests" routerLinkActive ariaCurrentWhenActive="page">Solicitações</a>
      </ng-container>
      <p>Conteúdo da página</p>
    </chain-shell>
  `,
})
class ShellHost {}

describe.each(THEMES)('Shell (%s theme)', (theme) => {
  beforeEach(() => {
    applyTheme(theme);
    document.getElementById('chain-test-narrow')?.remove();
    const style = document.createElement('style');
    style.id = 'chain-test-narrow';
    style.textContent = '.chain-shell__menu{display:inline-flex !important}';
    document.head.appendChild(style);
  });

  afterEach(() => document.getElementById('chain-test-narrow')?.remove());

  async function renderShell() {
    return render(ShellHost, {
      providers: [
        provideRouter([
          { path: 'inbox', component: Page },
          { path: 'requests', component: Page },
        ]),
      ],
    });
  }

  it('provides the page landmarks: banner, labelled navigation and main', async () => {
    await renderShell();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeTruthy();
    expect(screen.getByRole('main').textContent).toContain('Conteúdo da página');
    await expectNoAxeViolations();
  });

  it('starts with a skip link that moves focus to the main content', async () => {
    await renderShell();
    const user = userEvent.setup();
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Pular para o conteúdo' });
    expect(document.activeElement).toBe(skip);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('marks the current page in the navigation', async () => {
    const view = await renderShell();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/requests');
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    expect(screen.getByRole('link', { name: 'Solicitações' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Caixa de entrada' }).getAttribute('aria-current')).toBeNull();
  });

  it('has a menu button that opens and closes the navigation on small screens', async () => {
    await renderShell();
    const user = userEvent.setup();
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.getAttribute('aria-controls')).toBe(screen.getByRole('navigation').id);

    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(screen.getByRole('link', { name: 'Solicitações' }), { key: 'Escape', keyCode: 27 });
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(menu);
  });

  it('closes the drawer after navigating', async () => {
    const view = await renderShell();
    const user = userEvent.setup();
    const menu = screen.getByRole('button', { name: 'Menu' });
    await user.click(menu);
    await user.click(screen.getByRole('link', { name: 'Caixa de entrada' }));
    view.fixture.detectChanges();
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
  });
});
