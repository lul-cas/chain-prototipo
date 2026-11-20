import { TestBed } from '@angular/core/testing';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { DialogService } from '../../ui/dialog/dialog.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { provideJsdomInteractivity } from '../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../testing/themes';
import { SecretOnceData, SecretOnceDialog } from './secret-once-dialog';

const PASSWORD = 'k7Qm-temporaria-Zx9';
const DATA: SecretOnceData = {
  title: 'Senha temporária de ana.souza',
  label: 'Senha temporária',
  value: PASSWORD,
  note: 'Esta senha aparece só agora. Entregue-a ao usuário por um canal seguro; ele vai trocá-la no primeiro acesso.',
};

describe('SecretOnceDialog (admin-ui.md §4.3, §9)', () => {
  function open() {
    TestBed.configureTestingModule({ providers: [provideJsdomInteractivity()] });
    const user = userEvent.setup(); // before opening: user-event puts its own clipboard on the navigator
    const ref = TestBed.inject(DialogService).open(SecretOnceDialog, { data: DATA });
    TestBed.tick();
    return { user, ref, dialog: within(screen.getByRole('dialog', { name: DATA.title })) };
  }

  it('shows the value once, read-only in the monospace face, with its note, and starts on Copiar', async () => {
    const { dialog } = open();

    const value = dialog.getByRole('textbox', { name: 'Senha temporária' }) as HTMLInputElement;
    expect(value.value).toBe(PASSWORD);
    expect(value.readOnly).toBe(true);
    expect(value.classList).toContain('chain-mono');
    expect(dialog.getByText(DATA.note)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'Copiar' })));
  });

  it('copies the value and says so', async () => {
    const { user, dialog } = open();

    await user.click(dialog.getByRole('button', { name: 'Copiar' }));

    expect(await navigator.clipboard.readText()).toBe(PASSWORD);
    await waitFor(() => expect(dialog.getByRole('status').textContent?.trim()).toBe('Copiado.'));
  });

  it('leaves the value selected for the keyboard when the clipboard refuses', async () => {
    const { user, dialog } = open();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Negado', 'NotAllowedError'));

    await user.click(dialog.getByRole('button', { name: 'Copiar' }));

    const value = dialog.getByRole('textbox', { name: 'Senha temporária' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(value));
    expect([value.selectionStart, value.selectionEnd]).toEqual([0, PASSWORD.length]);
    expect(dialog.getByRole('status').textContent?.trim()).toBe('Não foi possível copiar. O valor está selecionado: copie com o teclado.');
  });

  it('closes without asking again', async () => {
    const { user, ref, dialog } = open();
    const closed = vi.fn();
    ref.closed.subscribe(closed);

    await user.click(dialog.getByRole('button', { name: 'Concluir' }));

    expect(closed).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(THEMES)('passes axe in the %s theme', async (theme) => {
    applyTheme(theme);
    open();

    await expectNoAxeViolations(screen.getByRole('dialog'));
  });
});
