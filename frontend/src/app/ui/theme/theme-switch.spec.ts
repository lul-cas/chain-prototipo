import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { ThemeSwitch } from './theme-switch';

describe.each(THEMES)('ThemeSwitch (%s theme)', (theme) => {
  beforeEach(() => {
    localStorage.clear();
    applyTheme(theme);
  });

  it('is a labelled radio group with the current preference checked', async () => {
    await render(ThemeSwitch);
    const group = screen.getByRole('radiogroup', { name: 'Tema' });
    expect(group).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Sistema' }) as HTMLInputElement).checked).toBe(true);
    await expectNoAxeViolations();
  });

  it('switches the theme with the arrow keys', async () => {
    await render(ThemeSwitch);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Sistema' }));
    await user.keyboard('{ArrowRight}');
    expect((screen.getByRole('radio', { name: 'Claro' }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.keyboard('{ArrowRight}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
