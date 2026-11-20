import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ApiProblem, apiProblemInterceptor, errorCodes, isApiProblem } from './api-problem';
import { messageFor } from './messages';

describe('apiProblemInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule(); // isolates the next test if this one fails with a request pending
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  async function failWith(flush: (request: ReturnType<HttpTestingController['expectOne']>) => void): Promise<ApiProblem> {
    const call = firstValueFrom(http.get('/api/anything'));
    flush(backend.expectOne('/api/anything'));
    const error = await call.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isApiProblem(error)).toBe(true);
    return error as ApiProblem;
  }

  it('turns a problem response into an ApiProblem with its code, title and errors', async () => {
    const problem = await failWith((r) =>
      r.flush(
        { status: 400, title: 'The request is invalid.', code: 'validation_failed', errors: ['password_too_short'] },
        { status: 400, statusText: 'Bad Request' },
      ),
    );

    expect(problem).toMatchObject({ status: 400, code: 'validation_failed', title: 'The request is invalid.' });
    expect(errorCodes(problem)).toEqual(['password_too_short']);
  });

  it('names a response without a problem body by its status', async () => {
    const problem = await failWith((r) => r.flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' }));

    expect(problem).toMatchObject({ status: 502, code: 'http_502', title: null, errors: [] });
  });

  it('marks a request that got no response as a network error', async () => {
    const problem = await failWith((r) => r.error(new ProgressEvent('error'), { status: 0 }));

    expect(problem).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('keeps per-key errors of a submission problem', async () => {
    const problem = await failWith((r) =>
      r.flush({ code: 'submission_invalid', errors: [{ key: 'valor', code: 'too_small' }] }, { status: 422, statusText: 'Unprocessable' }),
    );

    expect(problem.errors).toEqual([{ key: 'valor', code: 'too_small' }]);
    expect(errorCodes(problem)).toEqual([]);
  });

  it("keeps the problem's other members, as a 409 in use names what uses an item (automation-ui.md §12.1)", async () => {
    const problem = await failWith((r) =>
      r.flush(
        { type: 'about:blank', title: 'In use', status: 409, code: 'destination_in_use', secrets: ['erp_key'], automations: ['consulta'] },
        { status: 409, statusText: 'Conflict' },
      ),
    );

    expect(problem.extensions).toEqual({ secrets: ['erp_key'], automations: ['consulta'] });
  });

  it('has no other members for a response without a problem body, or without a response', async () => {
    expect((await failWith((r) => r.flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' }))).extensions).toEqual({});
  });
});

describe('messageFor', () => {
  it.each([
    ['invalid_credentials', 'Usuário ou senha inválidos.'],
    ['invalid_current_password', 'A senha atual está incorreta.'],
    ['password_too_short', 'A nova senha precisa ter pelo menos 12 caracteres.'],
    ['password_too_long', 'A senha pode ter no máximo 128 caracteres.'],
    ['password_equals_username', 'A nova senha não pode ser igual ao nome de usuário.'],
    ['network_error', 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.'],
    // Text PostgreSQL cannot store (identity.md I1, card #155).
    ['invalid_comment', 'O comentário tem caracteres que não podem ser guardados.'],
    ['invalid_justification', 'A justificativa tem caracteres que não podem ser guardados.'],
    ['invalid_description', 'A descrição tem caracteres que não podem ser guardados.'],
  ])('says %s in Portuguese', (code, message) => {
    expect(messageFor(code)).toBe(message);
  });

  it('shows an unknown code rather than inventing a message', () => {
    expect(messageFor('brand_new_code')).toBe('Algo deu errado (código: brand_new_code). Tente de novo.');
  });
});
