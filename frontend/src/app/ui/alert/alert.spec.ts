import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { Alert, AlertTone } from './alert';

describe.each(THEMES)('Alert (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  it.each<[AlertTone, string, string]>([
    ['info', 'status', 'Informação:'],
    ['success', 'status', 'Sucesso:'],
    ['warning', 'status', 'Atenção:'],
    ['danger', 'alert', 'Erro:'],
  ])('%s uses role %s and names its tone in text, not only by color', async (tone, role, prefix) => {
    await render(`<chain-alert [tone]="tone" title="Título">Corpo da mensagem.</chain-alert>`, {
      imports: [Alert],
      componentProperties: { tone },
    });
    const alert = screen.getByRole(role);
    expect(alert.textContent).toContain(prefix);
    expect(alert.textContent).toContain('Título');
    expect(alert.textContent).toContain('Corpo da mensagem.');
    expect(alert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await expectNoAxeViolations();
  });

  it('is not a tab stop between the controls around it', async () => {
    await render(`<button type="button">Antes</button><chain-alert>Seu rascunho foi salvo.</chain-alert><button type="button">Depois</button>`, {
      imports: [Alert],
    });
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Antes' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Depois' }));
  });

  it('defaults to info and works without a title', async () => {
    await render(`<chain-alert>Seu rascunho foi salvo.</chain-alert>`, { imports: [Alert] });
    expect(screen.getByRole('status').textContent).toContain('Informação:');
  });
});
