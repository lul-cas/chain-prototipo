import { Component, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { InsertChoice, InsertMenu } from './insert-menu';

@Component({
  imports: [InsertMenu],
  template: `<chain-insert-menu label="Inserir entrada" target="Caminho" [choices]="choices()" empty="Nenhuma entrada cabe aqui." (chosen)="chosen.push($event)" />`,
})
class Host {
  readonly choices = signal<readonly InsertChoice[]>([
    { value: 'cpf', label: 'cpf', hint: 'texto' },
    { value: 'itens', label: 'itens', refusal: 'Uma lista não cabe no caminho.' },
    { value: 'valor', label: 'valor', hint: 'número' },
  ]);
  readonly chosen: string[] = [];
}

describe('InsertMenu (automation-ui.md §7.3, §7.8)', () => {
  async function setup() {
    const view = await render(Host);
    return { user: userEvent.setup(), host: view.fixture.componentInstance, view };
  }
  const trigger = () => screen.getByRole('button', { name: 'Inserir entrada em Caminho' });

  it('opens a menu of the choices, with their hints and reasons, and emits the one chosen', async () => {
    const { user, host } = await setup();
    expect(trigger().getAttribute('aria-haspopup')).toBe('true'); // ARIA reads true as a menu
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['cpf, texto', 'itens. Uma lista não cabe no caminho.', 'valor, número']);
    expect(items[1].getAttribute('aria-disabled')).toBe('true');

    await user.click(items[2]);
    expect(host.chosen).toEqual(['valor']);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('does not emit a refused choice', async () => {
    const { user, host } = await setup();

    await user.click(trigger());
    await user.click(screen.getAllByRole('menuitem')[1]);

    expect(host.chosen).toEqual([]);
  });

  it('works with the keyboard: Enter opens, the arrows move, Enter chooses, Escape closes', async () => {
    const { user, host } = await setup();

    trigger().focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement?.textContent).toContain('cpf');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(host.chosen).toEqual(['valor']);

    trigger().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('says when there is nothing to choose', async () => {
    const { user, view } = await setup();
    view.fixture.componentInstance.choices.set([]);
    view.fixture.detectChanges();

    await user.click(trigger());

    expect(screen.getByRole('menuitem').textContent?.trim()).toBe('Nenhuma entrada cabe aqui.');
  });
});
