import { ActorRef, EventView } from '../../core/http/engine-api';
import { EVALUATION_ZONE_MINUTES, Instant, parseDateTime } from '../../expression';
import { numberFromJson } from '../../expression/decimal';
import { clockDate, clockTime, formatDate, formatTime, toOffset } from '../../expression/temporal';
import { formatNumberInput } from '../../forms/numbers';
import { formatSize } from '../../forms/uploads';
import { incidentText } from './incident-messages';

/** One timeline line: who did it, what happened, and an optional quoted note (requests-ui.md §6). */
export interface EventSentence {
  /** The person's name, whom `what` follows; null for the engine, whose standalone `what` the page shows after "Sistema:". */
  readonly who: string | null;
  readonly what: string;
  readonly note: string | null;
  /** The group the actor acted as. */
  readonly group: string | null;
  /** A request to link to: the child of a sub-workflow. */
  readonly link: string | null;
  /** A file to link to, after `what`: the one an attachment names (card #34, N8b). */
  readonly file: LinkedFile | null;
  /** "via API" or "via MCP" for an action an integration or an AI agent took; null for the web app and the engine (card #83). */
  readonly via: string | null;
}

/** A file the page links to, which downloads it (`GET /api/files/{id}`, ADR-0014 §4.4). */
export interface LinkedFile {
  readonly fileId: string;
  readonly name: string;
  /** Its size in pt-BR, when the event has it. */
  readonly size?: string | null;
}

/**
 * The pt-BR sentence for an event. Task events take the task's label from the request's `task.created` events; a
 * take-over names the previous assignee from the request's participants.
 */
export function describeEvent(event: EventView, timeline: readonly EventView[], people: readonly ActorRef[]): EventSentence {
  const details = event.details ?? {};
  const named = taskLabel(event.taskId, timeline);
  const label = named ?? 'uma tarefa';
  const text = (key: string): string | null => (typeof details[key] === 'string' && details[key] ? (details[key] as string) : null);
  const base = { who: event.actor?.displayName ?? null, note: null, group: event.actedAsGroup?.name ?? null, link: null, file: null, via: via(event) };
  const yesNo = (key: string) => (details[key] === true ? 'Sim' : 'Não');

  switch (event.type) {
    case 'instance.started':
      return { ...base, what: 'iniciou a solicitação' };
    case 'instance.completed':
      return { ...base, what: 'A solicitação foi concluída.' };
    case 'instance.cancelled':
      return { ...base, what: 'encerrou a solicitação', note: text('justification') };
    case 'instance.faulted': {
      const [code, step] = [text('code'), text('label')]; // the step's label, recorded since card #219
      return { ...base, what: step ? `A solicitação parou com uma falha em ${step}.` : 'A solicitação parou com uma falha.', note: code && (incidentText(code) ?? code) };
    }
    case 'instance.resumed':
      return { ...base, what: base.who ? 'retomou a solicitação' : 'A solicitação foi retomada.' };
    case 'task.created':
      return { ...base, what: `${details['kind'] === 'decision' ? 'Nova decisão' : 'Nova tarefa'}: ${text('label') ?? label}` };
    case 'task.assigned':
      return { ...base, what: `começou a trabalhar em ${label}` };
    case 'task.taken_over': {
      const from = people.find((person) => person.id === details['from'])?.displayName;
      return { ...base, what: from ? `assumiu ${label} de ${from}` : `assumiu ${label}` };
    }
    case 'task.completed':
      return { ...base, what: `concluiu ${label}`, note: text('comment') };
    case 'task.cancelled':
      if (!base.who) {
        return { ...base, what: `Tarefa cancelada: ${label}` };
      }
      return { ...base, what: named ? `cancelou a tarefa ${named}` : 'cancelou uma tarefa' }; // closing records the closer
    case 'gateway.decided':
      return { ...base, what: `respondeu ${label}: ${yesNo('outcome')}`, note: text('justification') };
    case 'gateway.evaluated': {
      const gateway = text('label'); // the gateway's label, recorded since card #219
      return { ...base, what: `Decisão automática${gateway ? ` ${gateway}` : ''}: ${yesNo('outcome')}` };
    }
    case 'form.submitted':
      return { ...base, what: 'enviou os dados do formulário' };
    case 'comment.added':
      return { ...base, what: 'comentou', note: text('text') };
    case 'attachment.added': {
      const [fileId, name] = [text('fileId'), text('name')];
      if (fileId && name) {
        return { ...base, what: 'anexou', file: { fileId, name, size: typeof details['size'] === 'number' ? formatSize(details['size']) : null } };
      }
      return { ...base, what: `anexou ${name ?? 'um arquivo'}` };
    }
    case 'subprocess.started':
      return { ...base, what: `Subsolicitação iniciada: ${text('definitionName') ?? ''}`.trim(), link: text('childId') };
    case 'subprocess.completed':
      return { ...base, what: 'Subsolicitação concluída', link: text('childId') };
    case 'data.corrected': {
      const changes = Array.isArray(details['changes']) ? (details['changes'] as { key?: unknown }[]) : [];
      const keys = changes.map((change) => change.key).filter((key): key is string => typeof key === 'string');
      return { ...base, what: keys.length ? `corrigiu os dados: ${keys.join(', ')}` : 'corrigiu os dados', note: text('justification') };
    }
    case 'automation.requested':
      return { ...base, what: `${automationStep(text('label'))} iniciada` };
    case 'automation.succeeded': {
      const attempts = attemptsOf(details);
      const succeeded = `${automationStep(text('label'))} concluída`;
      return { ...base, what: attempts.length > 1 ? `${succeeded} em ${attempts.length} tentativas` : succeeded };
    }
    case 'automation.failed':
      return { ...base, what: automationFailure(automationStep(text('label')), text('errorClass'), attemptsOf(details)) };
    case 'automation.timed_out':
      return { ...base, what: `${automationStep(text('label'))} sem resultado no prazo` };
    case 'automation.cancelled': {
      const label = text('label');
      return { ...base, what: base.who ? `cancelou a etapa automática${label ? ` ${label}` : ''}` : `${automationStep(label)} cancelada` };
    }
    default:
      return { ...base, what: event.type };
  }
}

/** Why an automation step failed, by the error class of automation-contract.md §6, to follow "falhou: " (requests-ui.md §6.1). */
const AUTOMATION_FAILURES: Readonly<Record<string, string>> = {
  http_status: 'o sistema de destino respondeu com erro',
  timeout: 'o sistema de destino não respondeu a tempo',
  connect_error: 'não foi possível conectar ao sistema de destino',
  tls_error: 'a conexão segura com o sistema de destino falhou',
  invalid_response: 'o sistema de destino respondeu em um formato inesperado',
  response_too_large: 'a resposta passou do tamanho máximo',
  redirect_not_allowed: 'o sistema de destino pediu um redirecionamento não permitido',
  destination_denied: 'o endereço chamado não pertence ao destino configurado',
  ssrf_blocked: 'o endereço do sistema de destino é bloqueado por segurança',
  request_too_large: 'a chamada passou do tamanho máximo',
  secret_missing: 'uma credencial da automação não existe',
  secret_not_allowed: 'uma credencial da automação não pode ser usada com este destino',
  deadline_passed: 'o prazo da etapa acabou antes da chamada',
  invalid_request: 'a chamada montada pela automação é inválida',
  internal_error: 'houve um erro interno no serviço de automação',
  output_invalid: 'a resposta não trouxe os dados esperados',
};

/** The attempts an automation event lists (automation-contract.md §4.2). */
function attemptsOf(details: Readonly<Record<string, unknown>>): readonly unknown[] {
  return Array.isArray(details['attempts']) ? details['attempts'] : [];
}

/** "Etapa automática", then the step's label, which the events record since card #139 (requests-ui.md §6.1); none before. */
function automationStep(label: string | null): string {
  return label ? `Etapa automática ${label}` : 'Etapa automática';
}

/** "{step} falhou", with the attempts when there was more than one, and the reason for the error class. */
function automationFailure(step: string, errorClass: string | null, attempts: readonly unknown[]): string {
  const failed = attempts.length > 1 ? `${step} falhou após ${attempts.length} tentativas` : `${step} falhou`;
  if (errorClass === null) {
    return failed;
  }
  if (!Object.hasOwn(AUTOMATION_FAILURES, errorClass)) {
    return `${failed} (código: ${errorClass})`;
  }
  const last = attempts.at(-1);
  const status = typeof last === 'object' && last !== null ? (last as { status?: unknown }).status : null;
  const reason = AUTOMATION_FAILURES[errorClass];
  return errorClass === 'http_status' && typeof status === 'number' ? `${failed}: ${reason} HTTP ${status}` : `${failed}: ${reason}`;
}

/** The way in an event shows: only the HTTP API and MCP, since most events come from the web app (requests-ui.md §6). */
function via(event: EventView): string | null {
  switch (event.channel) {
    case 'api':
      return 'via API';
    case 'mcp':
      return 'via MCP';
    default:
      return null;
  }
}

/** The task's label from the request's `task.created` events; null when the timeline doesn't name the task. */
function taskLabel(taskId: string | null, timeline: readonly EventView[]): string | null {
  const created = timeline.find((event) => event.type === 'task.created' && event.taskId === taskId && taskId !== null);
  const label = created?.details?.['label'];
  return typeof label === 'string' && label ? label : null;
}

/** A data value as the request page shows it: text, labeled entries (groups) or items (lists of rows). */
export type DataNode =
  | { readonly text: string }
  | { readonly hidden: true }
  | { readonly files: readonly LinkedFile[] }
  | { readonly entries: readonly (readonly [string, DataNode])[] }
  | { readonly items: readonly DataNode[] };

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** pt-BR text for stored data: Sim or Não, numbers with a comma, dates as dd/mm/aaaa, datetimes in UTC−03:00. */
export function describeValue(value: unknown): DataNode {
  if (value === null || value === undefined) {
    return { text: '—' };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'Sim' : 'Não' };
  }
  if (typeof value === 'number') {
    return { text: formatNumberInput(numberFromJson(value)) };
  }
  if (typeof value === 'string') {
    return { text: readableText(value) };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { text: '—' };
    }
    if (value.every(isFile)) {
      return { files: value.map(({ fileId, name }) => ({ fileId, name })) };
    }
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return { text: value.map((item) => (describeValue(item) as { text: string }).text).join(', ') };
    }
    return { items: value.map(describeValue) };
  }
  if (typeof value === 'object') {
    return { entries: Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, describeValue(item)] as const) };
  }
  return { text: String(value) };
}

function readableText(value: string): string {
  if (DATE.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
  }
  const instant = parseDateTime(value);
  const zoned = instant && inEvaluationZone(instant);
  if (zoned) {
    const [year, month, day] = formatDate(clockDate(zoned)).split('-');
    return `${day}/${month}/${year} ${formatTime(clockTime(zoned)).slice(0, 5)}`;
  }
  return value;
}

/** The instant on the clock of UTC−03:00, where the pages show times (NFR-005, ADR-0010 D8); null before year 1 there. */
function inEvaluationZone(instant: Instant): Instant | null {
  try {
    return toOffset(instant, EVALUATION_ZONE_MINUTES);
  } catch {
    return null;
  }
}

function isFile(value: unknown): value is LinkedFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { fileId, name } = value as Record<string, unknown>;
  return typeof fileId === 'string' && typeof name === 'string';
}
