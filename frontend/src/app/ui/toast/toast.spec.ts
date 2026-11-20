import { TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { ToastRegion } from './toast-region';
import { TOAST_DURATION_MS, ToastService } from './toast.service';

describe.each(THEMES)('Toasts (%s theme)', (theme) => {
  beforeEach(() => applyTheme(theme));
  async function setup() {
    const view = await render(ToastRegion);
    const toasts = TestBed.inject(ToastService);
    const show = async (...args: Parameters<ToastService['show']>) => {
      const id = toasts.show(...args);
      view.fixture.detectChanges();
      await view.fixture.whenStable();
      return id;
    };
    const flush = async () => {
      view.fixture.detectChanges();
      await view.fixture.whenStable();
    };
    return { ...view, toasts, show, flush };
  }

  afterEach(() => vi.useRealTimers());

  it('renders into a polite live region that is present before any toast', async () => {
    await setup();
    const region = screen.getByRole('region', { name: 'Notificações' });
    expect(within(region).getByRole('status')).toBeTruthy();
  });

  it('shows the message with its tone named in text, and a labelled close button', async () => {
    const { show } = await setup();
    await show({ tone: 'success', message: 'Tarefa concluída.' });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Sucesso:');
    expect(status.textContent).toContain('Tarefa concluída.');
    expect(screen.getByRole('button', { name: 'Fechar notificação' })).toBeTruthy();
    await expectNoAxeViolations();
  });

  it('closes from the keyboard', async () => {
    const { show, flush } = await setup();
    await show({ tone: 'info', message: 'Rascunho salvo.' });
    const user = userEvent.setup();
    await user.tab();
    const close = screen.getByRole('button', { name: 'Fechar notificação' });
    expect(document.activeElement).toBe(close);
    await user.keyboard('{Enter}');
    await flush();
    expect(screen.queryByText('Rascunho salvo.')).toBeNull();
  });

  it('closes from its button', async () => {
    const { show, flush } = await setup();
    await show({ tone: 'info', message: 'Rascunho salvo.' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fechar notificação' }));
    await flush();
    expect(screen.queryByText('Rascunho salvo.')).toBeNull();
  });

  it('dismisses info and success toasts after a while', async () => {
    vi.useFakeTimers();
    const { show, flush } = await setup();
    await show({ tone: 'success', message: 'Salvo.' });
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    await flush();
    expect(screen.queryByText('Salvo.')).not.toBeNull();
    vi.advanceTimersByTime(1);
    await flush();
    expect(screen.queryByText('Salvo.')).toBeNull();
  });

  it('keeps warning and danger toasts until the user closes them', async () => {
    vi.useFakeTimers();
    const { show, flush } = await setup();
    await show({ tone: 'danger', message: 'Não foi possível salvar.' });
    vi.advanceTimersByTime(TOAST_DURATION_MS * 10);
    await flush();
    expect(screen.queryByText('Não foi possível salvar.')).not.toBeNull();
  });

  it('pauses the timer while the pointer or focus is on the toast', async () => {
    vi.useFakeTimers();
    const { show, flush, toasts } = await setup();
    const id = await show({ tone: 'info', message: 'Copiado.' });
    toasts.pause(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    await flush();
    expect(screen.queryByText('Copiado.')).not.toBeNull();
    toasts.resume(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    await flush();
    expect(screen.queryByText('Copiado.')).toBeNull();
  });
});
