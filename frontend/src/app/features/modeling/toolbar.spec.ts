import { Component } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { moveInToolbar } from './toolbar';

@Component({
  template: `
    <div role="toolbar" aria-label="Ações" tabindex="-1" (keydown)="move($event)">
      <button type="button" style="display: none">Escondido</button>
      <button type="button">Um</button>
      <button type="button" disabled>Desligado</button>
      <button type="button">Dois</button>
    </div>
  `,
})
class Host {
  protected readonly move = moveInToolbar;
}

describe('moveInToolbar (the ARIA toolbar pattern)', () => {
  it('moves with the arrows, wrapping, past disabled buttons and buttons hidden at this width', async () => {
    await render(Host);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Um' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('Dois');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('Um');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.textContent).toBe('Dois');
  });
});
