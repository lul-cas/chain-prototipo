import { EventView } from '../../core/http/engine-api';
import { describeEvent, describeValue } from './timeline';

const ANA = { id: 'u-ana', username: 'ana', displayName: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', username: 'bruno', displayName: 'Bruno Lima' };
const ANALISTAS = { id: 'g-1', name: 'Analistas' };

function event(type: string, details: Record<string, unknown> = {}, overrides: Partial<EventView> = {}): EventView {
  return { type, occurredAt: '2026-10-16T12:00:00Z', actor: null, actedAsGroup: null, taskId: null, details, ...overrides };
}

const TIMELINE: EventView[] = [
  event('task.created', { nodeId: 'analyse', label: 'Analisar proposta', kind: 'task' }, { taskId: 't-1' }),
  event('task.created', { nodeId: 'docs_ok', label: 'Docs ok?', kind: 'decision' }, { taskId: 't-2' }),
];
const PEOPLE = [ANA, BRUNO];

const sentence = (e: EventView) => describeEvent(e, TIMELINE, PEOPLE);

describe('timeline sentences (requests-ui.md §6)', () => {
  it.each([
    [event('instance.started', {}, { actor: ANA }), 'Ana Souza', 'iniciou a solicitação', null],
    [event('instance.completed'), null, 'A solicitação foi concluída.', null],
    [event('instance.cancelled', { justification: 'Cliente desistiu' }, { actor: ANA }), 'Ana Souza', 'encerrou a solicitação', 'Cliente desistiu'],
    [event('instance.faulted', { nodeId: 'risk', code: 'type_mismatch' }), null, 'A solicitação parou com uma falha.', 'A decisão automática usou dados de tipos que não combinam.'],
    [event('instance.faulted', { nodeId: 'risk', code: 'a_new_incident' }), null, 'A solicitação parou com uma falha.', 'a_new_incident'],
    [event('instance.resumed'), null, 'A solicitação foi retomada.', null],
    [event('task.created', { label: 'Analisar proposta', kind: 'task' }, { taskId: 't-1' }), null, 'Nova tarefa: Analisar proposta', null],
    [event('task.created', { label: 'Docs ok?', kind: 'decision' }, { taskId: 't-2' }), null, 'Nova decisão: Docs ok?', null],
    [event('task.assigned', {}, { actor: BRUNO, taskId: 't-1', actedAsGroup: ANALISTAS }), 'Bruno Lima', 'começou a trabalhar em Analisar proposta', null],
    [event('task.taken_over', { from: ANA.id }, { actor: BRUNO, taskId: 't-1' }), 'Bruno Lima', 'assumiu Analisar proposta de Ana Souza', null],
    [event('task.completed', { comment: 'Tudo certo' }, { actor: BRUNO, taskId: 't-1' }), 'Bruno Lima', 'concluiu Analisar proposta', 'Tudo certo'],
    [event('task.cancelled', {}, { taskId: 't-1' }), null, 'Tarefa cancelada: Analisar proposta', null],
    [event('task.cancelled', {}, { actor: ANA, taskId: 't-1' }), 'Ana Souza', 'cancelou a tarefa Analisar proposta', null],
    [event('gateway.decided', { outcome: false, justification: 'Falta o RG' }, { actor: BRUNO, taskId: 't-2' }), 'Bruno Lima', 'respondeu Docs ok?: Não', 'Falta o RG'],
    [event('gateway.evaluated', { nodeId: 'valor_alto', outcome: true }), null, 'Decisão automática: Sim', null],
    [event('form.submitted', { nodeId: 'fill' }, { actor: ANA }), 'Ana Souza', 'enviou os dados do formulário', null],
    [event('comment.added', { text: 'Cliente pediu urgência' }, { actor: ANA }), 'Ana Souza', 'comentou', 'Cliente pediu urgência'],
    [event('attachment.added', { name: 'contrato.pdf' }, { actor: ANA }), 'Ana Souza', 'anexou contrato.pdf', null],
    [event('subprocess.started', { childId: 'r-2', definitionName: 'Análise de risco' }), null, 'Subsolicitação iniciada: Análise de risco', null],
    [event('subprocess.completed', { childId: 'r-2' }), null, 'Subsolicitação concluída', null],
    [event('data.corrected', { justification: 'CPF digitado errado', changes: [{ key: 'cpf' }] }, { actor: ANA }), 'Ana Souza', 'corrigiu os dados: cpf', 'CPF digitado errado'],
    [event('something.new', {}, { actor: ANA }), 'Ana Souza', 'something.new', null],
  ])('%#: %o', (e, who, what, note) => {
    expect(sentence(e)).toMatchObject({ who, what, note });
  });

  it('names the group an action was taken as', () => {
    expect(sentence(event('task.completed', {}, { actor: BRUNO, taskId: 't-1', actedAsGroup: ANALISTAS })).group).toBe('Analistas');
  });

  it('names an attached file with its size, to link to it (card #34, N8b)', () => {
    const attached = event('attachment.added', { fileId: 'f-1', name: 'contrato.pdf', size: 2048, commentId: 'c-1' }, { actor: ANA });
    expect(sentence(attached)).toMatchObject({ who: 'Ana Souza', what: 'anexou', file: { fileId: 'f-1', name: 'contrato.pdf', size: '2 KB' } });
    expect(sentence(event('attachment.added', { name: 'contrato.pdf' }, { actor: ANA }))).toMatchObject({ what: 'anexou contrato.pdf', file: null });
  });

  it('links to the child of a sub-workflow', () => {
    expect(sentence(event('subprocess.started', { childId: 'r-2', definitionName: 'Análise de risco' })).link).toBe('r-2');
  });

  it('marks an action that came through the API or MCP, and no other (card #83, N9b-1)', () => {
    const started = (channel: EventView['channel']) => sentence(event('instance.started', {}, { actor: ANA, channel })).via;
    expect([started('api'), started('mcp'), started('ui'), started(null), started(undefined)]).toEqual(['via API', 'via MCP', null, null, null]);
  });

  it('falls back to "uma tarefa" when the task is unknown', () => {
    expect(sentence(event('task.completed', {}, { actor: BRUNO, taskId: 't-9' })).what).toBe('concluiu uma tarefa');
    expect(sentence(event('task.cancelled', {}, { actor: ANA, taskId: 't-9' })).what).toBe('cancelou uma tarefa');
  });

  // The gateway and fault events above have no label, as those recorded before card #219: they read as they always did.
  describe('naming the gateway of an automatic decision and the step of a fault (workflow-engine.md §8; card #219)', () => {
    it.each([
      [event('gateway.evaluated', { nodeId: 'valor_alto', label: 'Valor alto?', outcome: true }), 'Decisão automática Valor alto?: Sim', null],
      [event('gateway.evaluated', { nodeId: 'valor_alto', label: 'Valor alto?', outcome: false }), 'Decisão automática Valor alto?: Não', null],
      [
        event('instance.faulted', { nodeId: 'consulta', label: 'Consultar CPF', code: 'automation_failed' }),
        'A solicitação parou com uma falha em Consultar CPF.',
        'A etapa automática falhou.',
      ],
      [event('instance.faulted', { nodeId: 'risk', label: 'Análise de risco', code: 'a_new_incident' }), 'A solicitação parou com uma falha em Análise de risco.', 'a_new_incident'],
    ])('%#: %o', (e, what, note) => {
      expect(sentence(e)).toMatchObject({ who: null, what, note });
    });

    it('leaves out a label that is empty or not text', () => {
      expect(sentence(event('gateway.evaluated', { nodeId: 'g', label: '', outcome: true })).what).toBe('Decisão automática: Sim');
      expect(sentence(event('instance.faulted', { nodeId: 'g', label: 7, code: 'x' })).what).toBe('A solicitação parou com uma falha.');
    });
  });
});

describe('automation events (requests-ui.md §6.1)', () => {
  /** An attempt as Elixir reports it (automation-contract.md §4.2), reduced to what the sentences read. */
  const attempt = (outcome: string, status: number | null, errorClass: string | null = null) => ({ number: 1, outcome, errorClass, status });
  const step = { nodeId: 'consulta', requestId: 'w-1' };
  const failed = (errorClass: unknown, attempts: unknown[] = [attempt('permanent_error', null, String(errorClass))]) =>
    sentence(event('automation.failed', { ...step, errorClass, attempts }));

  it.each([
    [event('automation.requested', { ...step, automationId: 'a-1', automationVersion: 2, activation: 1, deadlineAt: '2026-10-16T12:16:30Z' }), null, 'Etapa automática iniciada', null],
    [event('automation.succeeded', { ...step, attempts: [attempt('succeeded', 200)] }), null, 'Etapa automática concluída', null],
    [
      event('automation.succeeded', { ...step, attempts: [attempt('retryable_error', 503, 'http_status'), attempt('succeeded', 200)] }),
      null,
      'Etapa automática concluída em 2 tentativas',
      null,
    ],
    [
      event('automation.failed', { ...step, errorClass: 'http_status', attempts: [attempt('permanent_error', 404, 'http_status')] }),
      null,
      'Etapa automática falhou: o sistema de destino respondeu com erro HTTP 404',
      null,
    ],
    [
      event('automation.failed', { ...step, errorClass: 'timeout', attempts: [1, 2, 3].map(() => attempt('retryable_error', null, 'timeout')) }),
      null,
      'Etapa automática falhou após 3 tentativas: o sistema de destino não respondeu a tempo',
      null,
    ],
    [event('automation.timed_out', step), null, 'Etapa automática sem resultado no prazo', null],
    [event('automation.cancelled', step, { actor: ANA }), 'Ana Souza', 'cancelou a etapa automática', null],
    [event('automation.cancelled', step), null, 'Etapa automática cancelada', null],
  ])('%#: %o', (e, who, what, note) => {
    expect(sentence(e)).toMatchObject({ who, what, note, link: null });
  });

  it.each([
    ['timeout', 'o sistema de destino não respondeu a tempo'],
    ['connect_error', 'não foi possível conectar ao sistema de destino'],
    ['tls_error', 'a conexão segura com o sistema de destino falhou'],
    ['invalid_response', 'o sistema de destino respondeu em um formato inesperado'],
    ['response_too_large', 'a resposta passou do tamanho máximo'],
    ['redirect_not_allowed', 'o sistema de destino pediu um redirecionamento não permitido'],
    ['destination_denied', 'o endereço chamado não pertence ao destino configurado'],
    ['ssrf_blocked', 'o endereço do sistema de destino é bloqueado por segurança'],
    ['request_too_large', 'a chamada passou do tamanho máximo'],
    ['secret_missing', 'uma credencial da automação não existe'],
    ['secret_not_allowed', 'uma credencial da automação não pode ser usada com este destino'],
    ['deadline_passed', 'o prazo da etapa acabou antes da chamada'],
    ['invalid_request', 'a chamada montada pela automação é inválida'],
    ['internal_error', 'houve um erro interno no serviço de automação'],
    ['output_invalid', 'a resposta não trouxe os dados esperados'],
  ])('says why the step failed with %s', (errorClass, reason) => {
    expect(failed(errorClass).what).toBe(`Etapa automática falhou: ${reason}`);
  });

  it('says the target answered with an error when the last attempt has no status', () => {
    expect(failed('http_status').what).toBe('Etapa automática falhou: o sistema de destino respondeu com erro');
  });

  it('takes the status of the last attempt, only for an error status', () => {
    const attempts = [attempt('retryable_error', 503, 'http_status'), attempt('permanent_error', 400, 'http_status')];
    expect(failed('http_status', attempts).what).toBe('Etapa automática falhou após 2 tentativas: o sistema de destino respondeu com erro HTTP 400');
    expect(failed('invalid_response', [attempt('permanent_error', 200, 'invalid_response')]).what).toBe(
      'Etapa automática falhou: o sistema de destino respondeu em um formato inesperado',
    );
  });

  it('shows an unknown class as its code, and says only that the step failed without one', () => {
    expect(failed('new_class').what).toBe('Etapa automática falhou (código: new_class)');
    expect(failed('constructor').what).toBe('Etapa automática falhou (código: constructor)');
    expect(failed(null, [attempt('permanent_error', null), attempt('permanent_error', null)]).what).toBe('Etapa automática falhou após 2 tentativas');
    expect(sentence(event('automation.failed', step)).what).toBe('Etapa automática falhou');
  });

  it('does not count attempts it cannot read', () => {
    expect(sentence(event('automation.succeeded', { ...step, attempts: 'many' })).what).toBe('Etapa automática concluída');
    expect(sentence(event('automation.succeeded', step, { details: null })).what).toBe('Etapa automática concluída');
  });

  // The events above have no label, as those recorded before card #139: they read as they always did.
  describe("naming the step by the label each event records (automation.md §6.6; card #139)", () => {
    const named = { ...step, label: 'Consultar CPF' };

    it.each([
      [event('automation.requested', { ...named, automationId: 'a-1', automationVersion: 2, activation: 1, deadlineAt: '2026-10-16T12:16:30Z' }), null, 'Etapa automática Consultar CPF iniciada'],
      [event('automation.succeeded', { ...named, attempts: [attempt('succeeded', 200)] }), null, 'Etapa automática Consultar CPF concluída'],
      [
        event('automation.succeeded', { ...named, attempts: [attempt('retryable_error', 503, 'http_status'), attempt('succeeded', 200)] }),
        null,
        'Etapa automática Consultar CPF concluída em 2 tentativas',
      ],
      [
        event('automation.failed', { ...named, errorClass: 'http_status', attempts: [attempt('permanent_error', 404, 'http_status')] }),
        null,
        'Etapa automática Consultar CPF falhou: o sistema de destino respondeu com erro HTTP 404',
      ],
      [
        event('automation.failed', { ...named, errorClass: 'timeout', attempts: [1, 2, 3].map(() => attempt('retryable_error', null, 'timeout')) }),
        null,
        'Etapa automática Consultar CPF falhou após 3 tentativas: o sistema de destino não respondeu a tempo',
      ],
      [event('automation.failed', { ...named, errorClass: 'new_class' }), null, 'Etapa automática Consultar CPF falhou (código: new_class)'],
      [event('automation.failed', named), null, 'Etapa automática Consultar CPF falhou'],
      [event('automation.timed_out', named), null, 'Etapa automática Consultar CPF sem resultado no prazo'],
      [event('automation.cancelled', named, { actor: ANA }), 'Ana Souza', 'cancelou a etapa automática Consultar CPF'],
      [event('automation.cancelled', named), null, 'Etapa automática Consultar CPF cancelada'],
    ])('%#: %o', (e, who, what) => {
      expect(sentence(e)).toMatchObject({ who, what, note: null, link: null });
    });

    it('leaves out a label that is empty or not text', () => {
      expect(sentence(event('automation.requested', { ...step, label: '' })).what).toBe('Etapa automática iniciada');
      expect(sentence(event('automation.timed_out', { ...step, label: 42 })).what).toBe('Etapa automática sem resultado no prazo');
      expect(sentence(event('automation.cancelled', { ...step, label: null }, { actor: ANA })).what).toBe('cancelou a etapa automática');
    });
  });
});

describe('readable data values (requests-ui.md §6)', () => {
  it.each([
    [null, '—'],
    [true, 'Sim'],
    [false, 'Não'],
    [1234.5, '1234,5'],
    ['texto livre', 'texto livre'],
    ['2026-10-16', '16/10/2026'],
    [['rg', 'cnh'], 'rg, cnh'],
    [[], '—'],
  ])('%j reads as %j', (value, text) => {
    expect(describeValue(value)).toEqual({ text });
  });

  describe('a datetime, in UTC−03:00 whatever the browser zone (NFR-005, ADR-0010 D8; card #157)', () => {
    beforeEach(() => vi.stubEnv('TZ', 'Asia/Tokyo')); // a browser twelve hours ahead of UTC−03:00, whatever this machine's zone is
    afterEach(() => vi.unstubAllEnvs());

    it.each([
      ['2026-10-16T17:30:00Z', '16/10/2026 14:30'],
      ['2026-10-17T01:00:00Z', '16/10/2026 22:00'],
      ['2026-10-16T23:30:00+02:00', '16/10/2026 18:30'],
      ['2026-10-16T14:30:59.9999999-03:00', '16/10/2026 14:30'],
      ['0001-01-01T01:00:00Z', '0001-01-01T01:00:00Z'], // before year 1 in UTC−03:00: shown as stored
    ])('%j reads as %j', (value, text) => {
      expect(describeValue(value)).toEqual({ text });
    });
  });

  it('nests groups and lists of rows, and names files', () => {
    expect(describeValue({ cep: '01310-100', numero: 10 })).toEqual({ entries: [['cep', { text: '01310-100' }], ['numero', { text: '10' }]] });
    expect(describeValue([{ nome: 'Bruno' }, { nome: 'Carla' }])).toEqual({
      items: [{ entries: [['nome', { text: 'Bruno' }]] }, { entries: [['nome', { text: 'Carla' }]] }],
    });
    expect(describeValue([{ fileId: 'f-1', name: 'contrato.pdf', size: 2048, contentType: 'application/pdf' }])).toEqual({
      files: [{ fileId: 'f-1', name: 'contrato.pdf' }],
    });
  });
});
