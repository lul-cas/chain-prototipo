import { readDocument } from './automation-document';
import { executionProblems } from './execution-checks';

function withExecution(execution: object): object {
  return { schemaVersion: 1, kind: 'http', request: { method: 'GET', destination: 'erp', path: '/' }, response: { type: 'none' }, execution };
}

const problems = (execution: object) => executionProblems(readDocument(withExecution(execution)));
const codes = (execution: object) => problems(execution).map((problem) => problem.code);

/** The cases of AutomationDocumentTests.cs (AU011 and AU012). */
describe('the local checks of the execution (automation-ui.md §7.9)', () => {
  it('AU011: the limits are in range', () => {
    const cases: [object, string, string][] = [
      [{ timeoutSeconds: 0 }, 'execution.timeoutSeconds', 'O tempo limite vai de 1 a 300 segundos.'],
      [{ timeoutSeconds: 301 }, 'execution.timeoutSeconds', 'O tempo limite vai de 1 a 300 segundos.'],
      [{ retry: { maxAttempts: 0 } }, 'execution.retry.maxAttempts', 'As tentativas vão de 1 a 10.'],
      [{ retry: { maxAttempts: 11 } }, 'execution.retry.maxAttempts', 'As tentativas vão de 1 a 10.'],
      [{ retry: { initialDelaySeconds: 0 } }, 'execution.retry.initialDelaySeconds', 'A espera vai de 1 a 60 segundos.'],
      [{ retry: { initialDelaySeconds: 61 } }, 'execution.retry.initialDelaySeconds', 'A espera vai de 1 a 60 segundos.'],
      [{ redirects: { follow: true } }, 'execution.redirects.max', 'Seguindo redirecionamentos, o máximo vai de 1 a 3; sem seguir, é 0.'],
      [{ redirects: { follow: true, max: 0 } }, 'execution.redirects.max', 'Seguindo redirecionamentos, o máximo vai de 1 a 3; sem seguir, é 0.'],
      [{ redirects: { follow: true, max: 4 } }, 'execution.redirects.max', 'Seguindo redirecionamentos, o máximo vai de 1 a 3; sem seguir, é 0.'],
      [{ redirects: { follow: false, max: 2 } }, 'execution.redirects.max', 'Seguindo redirecionamentos, o máximo vai de 1 a 3; sem seguir, é 0.'],
    ];
    for (const [execution, path, text] of cases) {
      expect(problems(execution)).toEqual([{ code: 'AU011', path, text }]);
    }
    for (const execution of [
      { timeoutSeconds: 1, retry: { maxAttempts: 1, initialDelaySeconds: 1 } },
      { timeoutSeconds: 300, retry: { maxAttempts: 10, initialDelaySeconds: 60 } },
      { redirects: { follow: true, max: 3 } },
      { redirects: { follow: true, max: 1 } },
      { redirects: { follow: false, max: 0 } },
      {},
    ]) {
      expect(codes(execution)).toEqual([]);
    }
  });

  it('AU012: the idempotency header is a token, used with mode header', () => {
    const cases: [object, string, string][] = [
      [{ mode: 'always' }, 'execution.idempotency.mode', 'A chave de idempotência vai num cabeçalho, ou não é enviada.'],
      [{ mode: 'header', header: 'Idem Key' }, 'execution.idempotency.header', 'O cabeçalho da chave é um token HTTP de até 100 caracteres.'],
      [{ mode: 'header', header: '' }, 'execution.idempotency.header', 'O cabeçalho da chave é um token HTTP de até 100 caracteres.'],
      [{ mode: 'none', header: 'Idempotency-Key' }, 'execution.idempotency.header', 'Sem enviar a chave, não há cabeçalho para ela.'],
      [{ mode: 'header', header: 'X' + 'k'.repeat(100) }, 'execution.idempotency.header', 'O cabeçalho da chave é um token HTTP de até 100 caracteres.'],
    ];
    for (const [idempotency, path, text] of cases) {
      expect(problems({ idempotency })).toEqual([{ code: 'AU012', path, text }]);
    }
    expect(codes({ idempotency: { mode: 'header', header: 'X' + 'k'.repeat(99) } })).toEqual([]);
    expect(codes({ idempotency: { mode: 'none' } })).toEqual([]);
    expect(codes({ idempotency: { mode: 'header' } })).toEqual([]); // the default header
  });
});
