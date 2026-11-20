import { render, screen } from '@testing-library/angular';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { NotFoundPage } from './not-found-page';

describe.each(THEMES)('NotFoundPage (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));

  it('names the missing page', async () => {
    await render(NotFoundPage);
    expect(screen.getByRole('heading', { level: 1, name: 'Página não encontrada' })).toBeTruthy();
    await expectNoAxeViolations();
  });
});
