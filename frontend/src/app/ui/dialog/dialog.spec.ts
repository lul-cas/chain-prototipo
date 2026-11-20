import { Component, inject } from '@angular/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { provideJsdomInteractivity } from '../../../testing/jsdom-interactivity';
import { THEMES, applyTheme } from '../../../testing/themes';
import { DialogLayout } from './dialog-layout';
import { DialogService } from './dialog.service';

@Component({
  template: `<button type="button" (click)="ask()">Cancelar solicitação</button>`,
})
class Host {
  private readonly dialogs = inject(DialogService);
  result: boolean | undefined;

  ask(): void {
    this.dialogs
      .confirm({
        title: 'Cancelar a solicitação?',
        message: 'As tarefas abertas serão encerradas.',
        confirmLabel: 'Cancelar solicitação',
        cancelLabel: 'Voltar',
        tone: 'danger',
      })
      .subscribe((answer) => (this.result = answer));
  }
}

describe.each(THEMES)('DialogService.confirm (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  async function openDialog() {
    const { fixture } = await render(Host, { providers: [provideJsdomInteractivity()] });
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Cancelar solicitação' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar a solicitação?' });
    return { fixture, user, trigger, dialog };
  }

  it('opens a modal dialog named by its title and described by its message', async () => {
    const { dialog } = await openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy && document.getElementById(describedBy)?.textContent).toContain('As tarefas abertas');
    await expectNoAxeViolations(dialog);
  });

  it('puts focus on the least destructive choice', async () => {
    await openDialog();
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Voltar'));
  });

  it('keeps focus inside the dialog while tabbing', async () => {
    const { user, dialog } = await openDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('answers true when confirmed', async () => {
    const { fixture, user, dialog } = await openDialog();
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancelar solicitação');
    await user.click(confirm!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.componentInstance.result).toBe(true);
  });

  it('answers false on Escape and returns focus to the trigger', async () => {
    const { fixture, trigger } = await openDialog();
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Voltar'));
    // user-event does not set keyCode, which the CDK reads; browsers send 27 for Escape.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.componentInstance.result).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('answers false from the close button', async () => {
    const { fixture, user } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.componentInstance.result).toBe(false);
  });
});

@Component({
  template: `<button type="button" (click)="open()">Propriedades</button>`,
})
class SideHost {
  private readonly dialogs = inject(DialogService);

  open(): void {
    this.dialogs.open(SidePanel, { size: 'side' });
  }
}

@Component({ imports: [DialogLayout], template: `<chain-dialog title="Propriedades"><p>Conteúdo</p></chain-dialog>` })
class SidePanel {}

describe('DialogService.open as a side panel (workflow-editor.md §10.5)', () => {
  it('opens the dialog in a pane for the right edge, as a modal dialog named by its title', async () => {
    await render(SideHost, { providers: [provideJsdomInteractivity()] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Propriedades' }));

    const dialog = await screen.findByRole('dialog', { name: 'Propriedades' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('.cdk-overlay-pane')!.classList).toContain('chain-dialog-pane--side');
  });
});

@Component({ imports: [DialogLayout], template: `<chain-dialog title="Versão 1"><p>Detalhe</p></chain-dialog>` })
class DetailPanel {}

@Component({
  template: `<header>Chain</header>
    <main><button type="button" (click)="open()">Versões</button></main>`,
})
class ShellHost {
  private readonly dialogs = inject(DialogService);

  open(): void {
    this.dialogs.open(SidePanel, { size: 'side' });
    this.dialogs.open(DetailPanel, { size: 'lg' });
  }
}

describe('a dialog in the page (card #263)', () => {
  it('adds no banner or contentinfo landmark, alone or stacked', async () => {
    await render(ShellHost, { providers: [provideJsdomInteractivity()] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Versões' }));
    await screen.findByRole('dialog', { name: 'Versão 1' });

    // hidden: true also counts what the dialogs hide from assistive technology, such as the page's own header.
    expect(screen.getAllByRole('banner', { hidden: true })).toHaveLength(1);
    expect(screen.queryAllByRole('contentinfo', { hidden: true })).toHaveLength(0);
    await expectNoAxeViolations();
  });
});
