import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { App } from './app';

describe('App', () => {
  it('renders the toast region next to the outlet', async () => {
    await render(App, { providers: [provideRouter([])] });
    expect(screen.getByRole('region', { name: 'Notificações' })).toBeTruthy();
  });
});
