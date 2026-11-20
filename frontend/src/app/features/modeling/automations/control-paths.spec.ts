import { automationProblemText } from './automation-messages';
import { controlFor } from './control-paths';

const CONTROLS = new Set([
  'inputs',
  'inputs[0].key',
  'inputs[0].type',
  'outputs',
  'outputs[0].key',
  'outputs[0].path',
  'request',
  'request.destination',
  'request.method',
  'request.path',
  'request.query.origem',
  'request.headers',
  'request.headers.X-Api.Key',
  'request.auth.password',
  'request.body.keys[1]',
  'response.type',
  'execution.timeoutSeconds',
  'execution.idempotency.header',
]);

describe("a problem's control (automation-ui.md §8.2)", () => {
  it.each([
    ['inputs[0].key', 'inputs[0].key'],
    ['inputs', 'inputs'],
    ['request.headers.X-Api.Key', 'request.headers.X-Api.Key'], // a header whose name has a dot
    ['request.headers.Y', 'request.headers'], // a row the draft lacks: the heading
    ['request.query.origem', 'request.query.origem'],
    ['outputs[0].path[1]', 'outputs[0].path'], // cut from its end
    ['request.body.keys[1]', 'request.body.keys[1]'],
    ['request', 'request'],
    ['execution.idempotency.header', 'execution.idempotency.header'],
  ])('%s → %s', (path, control) => {
    expect(controlFor(path, CONTROLS)).toBe(control);
  });

  it('has none for a problem without a path (AU000) or one nothing holds', () => {
    expect(controlFor(null, CONTROLS)).toBeNull();
    expect(controlFor('schemaVersion', CONTROLS)).toBeNull();
  });
});

describe('the AU texts (automation-ui.md §8.3)', () => {
  it('has a pt-BR text per code, and keeps the server message for a code it lacks', () => {
    expect(automationProblemText('AU101', 'Unknown destination.')).toBe('Escolha um destino que exista.');
    expect(automationProblemText('AU999', 'Something new.')).toBe('Something new.');
    expect(automationProblemText('AU008', 'The password has no control characters (RFC 7617).')).toBe(
      "A autenticação básica precisa de usuário e senha, sem caracteres de controle; o usuário não pode ter ':', e ela não pode vir junto com um cabeçalho Authorization.",
    ); // card #128
    expect(automationProblemText('AU013', 'The password holds a {{secret:…}} credential, not a literal one (ADR-0012).')).toBe(
      'Use uma credencial: a senha e os cabeçalhos Authorization, Cookie e X-Api-Key não podem ter o valor escrito na automação.',
    ); // card #235
  });
});
