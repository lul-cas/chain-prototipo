import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { apiProblemInterceptor } from '../../core/http/api-problem';
import { InstanceView } from '../../core/http/engine-api';
import { ToastService } from '../../ui/toast/toast.service';
import { expectNoAxeViolations } from '../../../testing/axe';
import { THEMES, applyTheme } from '../../../testing/themes';
import { RequestComment } from './request-comment';

const INSTANCE = {
  id: 'r-1',
  definitionId: 'd-1',
  definitionName: 'Concessão de Crédito',
  versionNumber: 1,
  status: 'running',
  currentNodeId: 'fill',
  requester: { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' },
  startedAt: '2026-10-16T12:00:00Z',
  endedAt: null,
  openTasks: [],
  participants: [],
  timeline: [],
  data: {},
  incidents: [],
  parent: null,
  children: [],
  version: 8,
} as unknown as InstanceView;

@Component({
  imports: [RequestComment],
  template: `<chain-request-comment [instanceId]="id()" (commented)="views.push($event)" (stale)="stale.push($event)" />`,
})
class Host {
  readonly id = signal('r-1');
  readonly views: InstanceView[] = [];
  readonly stale: (string | null)[] = [];
}

describe('RequestComment (requests-ui.md §6, "Commenting")', () => {
  let backend: HttpTestingController;

  async function open() {
    const view = await render(Host, {
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    backend = TestBed.inject(HttpTestingController);
    return { host: view.fixture.componentInstance, user: userEvent.setup(), view };
  }

  afterEach(() => backend.verify());

  function comment(): TestRequest {
    return backend.expectOne({ method: 'POST', url: '/api/instances/r-1/comments' });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
  }

  async function fail(request: TestRequest, status: number, code: string | null, errors: unknown[] = []): Promise<void> {
    if (status === 0) {
      request.error(new ProgressEvent('error'));
    } else {
      request.flush({ type: 'about:blank', title: 'Erro', status, code, errors }, { status, statusText: 'Erro' });
    }
    await settle();
  }

  it('sends the text and the uploaded files with a key, shows the answer and empties the form', async () => {
    const { host, user } = await open();

    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Segue o comprovante');
    await user.upload(screen.getByLabelText('Anexos'), new File(['%PDF-1.4'], 'comprovante.pdf', { type: 'application/pdf' }));
    backend.expectOne('/api/files/limits').flush({ maxBytes: 25 * 1024 * 1024 }); // read before the first upload (card #195)
    backend.expectOne({ method: 'POST', url: '/api/files' }).flush({ id: 'f-1', name: 'comprovante.pdf', size: 8, contentType: 'application/pdf' });
    await settle();
    await user.click(screen.getByRole('button', { name: 'Comentar' }));

    const request = comment();
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.request.body).toEqual({ text: 'Segue o comprovante', fileIds: ['f-1'] });
    request.flush(INSTANCE);
    await settle();

    expect(host.views).toEqual([INSTANCE]);
    expect(TestBed.inject(ToastService).toasts().map((toast) => toast.message)).toEqual(['Comentário enviado.']);
    expect((screen.getByRole('textbox', { name: 'Comentário' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('link', { name: 'comprovante.pdf' })).toBeNull();
  });

  it('sends a file without text, with the text as null', async () => {
    const { user } = await open();

    await user.upload(screen.getByLabelText('Anexos'), new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }));
    backend.expectOne('/api/files/limits').flush({ maxBytes: 25 * 1024 * 1024 });
    backend.expectOne('/api/files').flush({ id: 'f-1', name: 'a.pdf', size: 8, contentType: 'application/pdf' });
    await settle();
    await user.click(screen.getByRole('button', { name: 'Comentar' }));

    const request = comment();
    expect(request.request.body).toEqual({ text: null, fileIds: ['f-1'] });
    request.flush(INSTANCE);
  });

  it('does not send a comment with neither text nor files', async () => {
    const { user } = await open();

    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));

    expect(screen.getByText('Escreva um comentário ou anexe um arquivo.')).toBeTruthy();
  });

  it('offers "Tentar novamente" after a lost answer, which sends the same comment with the same key', async () => {
    const { host, user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Urgente');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    const first = comment();
    await fail(first, 0, null);

    expect(screen.getByText('Não foi possível falar com o servidor. Verifique a conexão e tente de novo.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    const second = comment();
    expect(second.request.headers.get('Idempotency-Key')).toBe(first.request.headers.get('Idempotency-Key'));
    expect(second.request.body).toEqual({ text: 'Urgente', fileIds: [] });
    second.flush(INSTANCE);
    await settle();
    expect(host.views).toHaveLength(1);
  });

  it.each([
    [400, 'validation_failed', ['comment_empty'], 'Escreva um comentário ou anexe um arquivo.', []],
    [400, 'validation_failed', ['comment_too_long'], 'O comentário pode ter no máximo 1.000 caracteres.', []],
    [400, 'validation_failed', ['too_many_files'], 'Anexe no máximo 10 arquivos.', []],
    [400, 'validation_failed', ['duplicate_file'], 'O mesmo arquivo foi anexado duas vezes.', []],
    [400, 'validation_failed', ['invalid_comment'], 'O comentário tem caracteres que não podem ser guardados.', []],
    [403, 'forbidden', [], 'Você não pode comentar nesta solicitação.', []],
    [409, 'instance_not_running', [], 'A solicitação não está mais em andamento.', ['A solicitação não está mais em andamento.']],
    [422, 'file_invalid', [], 'Um dos arquivos expirou ou já foi usado. Remova-o e anexe de novo.', []],
    [422, 'idempotency_key_reused', [], 'O comentário anterior pode já ter sido registrado. Confira a linha do tempo antes de enviar de novo.', [null]],
  ])('answers %i %s %o with its text', async (status, code, errors, text, stale) => {
    const { host, user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Urgente');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    await fail(comment(), status, code, errors);

    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    expect(host.stale).toEqual(stale);
    expect((screen.getByRole('textbox', { name: 'Comentário' }) as HTMLTextAreaElement).value).toBe('Urgente'); // kept to fix and send again
  });

  it('starts fresh on another request, with a new key', async () => {
    const { host, user, view } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Urgente');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    const lost = comment();
    await fail(lost, 0, null);

    host.id.set('r-2');
    view.fixture.detectChanges();
    await settle();

    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Comentário' }) as HTMLTextAreaElement).value).toBe('');
    await user.type(screen.getByRole('textbox', { name: 'Comentário' }), 'Outro');
    await user.click(screen.getByRole('button', { name: 'Comentar' }));
    const next = backend.expectOne({ method: 'POST', url: '/api/instances/r-2/comments' });
    expect(next.request.headers.get('Idempotency-Key')).not.toBe(lost.request.headers.get('Idempotency-Key'));
    next.flush({ ...INSTANCE, id: 'r-2' });
  });

  describe.each(THEMES)('in the %s theme', (theme) => {
    beforeEach(() => applyTheme(theme));

    it('passes axe, with a message shown', async () => {
      const { user } = await open();
      await user.click(screen.getByRole('button', { name: 'Comentar' }));
      expect(screen.getByText('Escreva um comentário ou anexe um arquivo.')).toBeTruthy();
      await expectNoAxeViolations();
    });
  });
});
