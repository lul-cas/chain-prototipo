import { LocalProblem } from './automation-checks';
import { AutomationDocument } from './automation-document';

const MAX_IDEMPOTENCY_HEADER_LENGTH = 100;
/** An RFC 9110 token: one or more `tchar`. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * The local checks of *Execução* (automation-ui.md §7.9, AS5b), as `AutomationRules.CheckExecution` and `CheckIdempotency`
 * find them, in their order: AU011, then AU012. Each has the server's code and path, and its cause in pt-BR.
 */
export function executionProblems(document: AutomationDocument): LocalProblem[] {
  const problems: LocalProblem[] = [];
  const { timeoutSeconds, retry, idempotency, redirects } = document.execution;
  if (timeoutSeconds < 1 || timeoutSeconds > 300) {
    problems.push({ code: 'AU011', path: 'execution.timeoutSeconds', text: 'O tempo limite vai de 1 a 300 segundos.' });
  }
  if (retry.maxAttempts < 1 || retry.maxAttempts > 10) {
    problems.push({ code: 'AU011', path: 'execution.retry.maxAttempts', text: 'As tentativas vão de 1 a 10.' });
  }
  if (retry.initialDelaySeconds < 1 || retry.initialDelaySeconds > 60) {
    problems.push({ code: 'AU011', path: 'execution.retry.initialDelaySeconds', text: 'A espera vai de 1 a 60 segundos.' });
  }
  if (redirects.follow ? redirects.max < 1 || redirects.max > 3 : redirects.max !== 0) {
    problems.push({ code: 'AU011', path: 'execution.redirects.max', text: 'Seguindo redirecionamentos, o máximo vai de 1 a 3; sem seguir, é 0.' });
  }
  const header = idempotency.header;
  if (idempotency.mode === 'header') {
    if (header !== undefined && (header.length > MAX_IDEMPOTENCY_HEADER_LENGTH || !TOKEN.test(header))) {
      problems.push({ code: 'AU012', path: 'execution.idempotency.header', text: 'O cabeçalho da chave é um token HTTP de até 100 caracteres.' });
    }
  } else if (idempotency.mode === 'none') {
    if (header !== undefined) {
      problems.push({ code: 'AU012', path: 'execution.idempotency.header', text: 'Sem enviar a chave, não há cabeçalho para ela.' });
    }
  } else {
    problems.push({ code: 'AU012', path: 'execution.idempotency.mode', text: 'A chave de idempotência vai num cabeçalho, ou não é enviada.' });
  }
  return problems;
}
