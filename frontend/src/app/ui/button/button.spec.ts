import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { Button } from './button';

describe.each(THEMES)('Button (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  it('is a native button with its label as accessible name', async () => {
    await render(`<button chainButton type="button">Salvar</button>`, { imports: [Button] });
    const button = screen.getByRole('button', { name: 'Salvar' });
    expect(button).toHaveProperty('type', 'button');
    await expectNoAxeViolations();
  });

  it('is activated with the keyboard', async () => {
    const clicked = vi.fn();
    await render(`<button chainButton type="button" (click)="clicked()">Salvar</button>`, {
      imports: [Button],
      componentProperties: { clicked },
    });
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Salvar' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it('applies the variant and size', async () => {
    await render(`<button chainButton variant="danger" size="sm" type="button">Excluir</button>`, { imports: [Button] });
    const button = screen.getByRole('button', { name: 'Excluir' });
    expect(button.classList).toContain('chain-button--danger');
    expect(button.classList).toContain('chain-button--sm');
  });

  describe('while loading', () => {
    it('stays focusable, says it is busy and keeps its name', async () => {
      await render(`<button chainButton type="button" [loading]="true">Concluir</button>`, { imports: [Button] });
      const button = screen.getByRole('button', { name: /Concluir/ });
      expect(button).not.toHaveProperty('disabled', true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.textContent).toContain('processando');
      await expectNoAxeViolations();
    });

    it('ignores clicks, so a pending command is not sent twice', async () => {
      const clicked = vi.fn();
      await render(`<button chainButton type="button" [loading]="true" (click)="clicked()">Concluir</button>`, {
        imports: [Button],
        componentProperties: { clicked },
      });
      await userEvent.setup().click(screen.getByRole('button', { name: /Concluir/ }));
      expect(clicked).not.toHaveBeenCalled();
    });

    it('does not submit its form', async () => {
      const submitted = vi.fn();
      await render(
        `<form (submit)="$event.preventDefault(); submitted()"><button chainButton type="submit" [loading]="true">Entrar</button></form>`,
        { imports: [Button], componentProperties: { submitted } },
      );
      await userEvent.setup().click(screen.getByRole('button', { name: /Entrar/ }));
      expect(submitted).not.toHaveBeenCalled();
    });
  });

  it('can style a link', async () => {
    await render(`<a chainButton variant="secondary" href="/inbox">Abrir caixa</a>`, { imports: [Button] });
    expect(screen.getByRole('link', { name: 'Abrir caixa' }).classList).toContain('chain-button--secondary');
  });
});
