import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../../testing/axe';
import { THEMES, applyTheme } from '../../../../testing/themes';
import { FormPalettePanel } from './form-palette-panel';

describe('FormPalettePanel (form-designer.md §6)', () => {
  async function open() {
    const added: string[] = [];
    await render(FormPalettePanel, { on: { add: (type: string) => added.push(type) } });
    return added;
  }

  it('lists the entries in their groups', async () => {
    await open();

    expect(screen.getByRole('heading', { name: 'Componentes' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent?.trim())).toEqual(['Entrada', 'Seleção', 'Apresentação', 'Contêineres']);
    const entrada = within(screen.getByRole('list', { name: 'Entrada' }));
    expect(entrada.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
      'Campo de texto',
      'Área de texto',
      'Número',
      'Data e hora',
      'Campo calculado',
      'Seletor de arquivo',
    ]);
    expect(screen.getAllByRole('button')).toHaveLength(15);
  });

  it('adds by click and by Enter', async () => {
    const added = await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Grupo de opções' }));
    screen.getByRole('button', { name: 'Lista dinâmica' }).focus();
    await user.keyboard('{Enter}');

    expect(added).toEqual(['radio', 'dynamicList']);
  });

  it('filters by name and by type, ignoring case and accents', async () => {
    await open();
    const user = userEvent.setup();
    const search = screen.getByRole('searchbox', { name: 'Pesquise componentes' });

    await user.type(search, 'area');
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Área de texto']);

    await user.clear(search);
    await user.type(search, 'dynamicList');
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Lista dinâmica']);

    await user.clear(search);
    await user.type(search, 'nada');
    expect(screen.getByText('Nenhum componente com esse nome.')).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe', async () => {
      await open();
      await expectNoAxeViolations();
    });
  });
});
