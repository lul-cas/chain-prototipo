import { numberFromJson } from '../expression/decimal';
import { FieldValidation, FormComponent, RelativeBound } from './model';
import { formatNumberInput } from './numbers';
import { toLocalInput } from './values';

/** The pt-BR message for an error code (forms.md F3). `component` is null for errors that belong to the whole form. */
export function fieldMessage(code: string, component: FormComponent | null): string {
  const rules: FieldValidation = component?.validate ?? {};
  const type = component?.type;
  switch (code) {
    case 'required':
      if (type === 'checkbox') {
        return 'Marque esta opção.';
      }
      return type === 'select' || type === 'radio' || type === 'checklist' ? 'Escolha uma opção.' : 'Preencha este campo.';
    case 'type_mismatch':
      return type === 'number'
        ? 'Digite um número, como 1234,56.'
        : type === 'date' || type === 'datetime'
          ? 'Data inválida.'
          : type === 'time'
            ? 'Horário inválido.'
            : 'Valor inválido.';
    case 'too_short':
      return `Use pelo menos ${count(rules.minLength, 'caractere', 'caracteres')}.`;
    case 'too_long':
      return `Use no máximo ${count(rules.maxLength, 'caractere', 'caracteres')}.`;
    case 'too_small':
      return `O valor mínimo é ${decimal(rules.min)}.`;
    case 'too_large':
      return `O valor máximo é ${decimal(rules.max)}.`;
    case 'too_many_decimals':
      return rules.decimalDigits === 0 ? 'Use um número inteiro.' : `Use no máximo ${count(rules.decimalDigits, 'casa decimal', 'casas decimais')}.`;
    case 'invalid_step':
      return `Use um valor em passos de ${decimal(rules.step)}.`;
    case 'too_early':
      return bound('min', type, rules.min);
    case 'too_late':
      return bound('max', type, rules.max);
    case 'invalid_option':
      return 'Escolha uma das opções.';
    case 'too_few':
      return type === 'dynamicList'
        ? `Adicione pelo menos ${count(rules.minRows, 'linha', 'linhas')}.`
        : `Selecione pelo menos ${count(rules.minSelected, 'opção', 'opções')}.`;
    case 'too_many':
      if (type === 'dynamicList') {
        return `Use no máximo ${count(rules.maxRows, 'linha', 'linhas')}.`;
      }
      return type === 'file'
        ? `Envie no máximo ${count(rules.maxFiles ?? 10, 'arquivo', 'arquivos')}.`
        : `Selecione no máximo ${count(rules.maxSelected, 'opção', 'opções')}.`;
    case 'invalid_format':
      return own(FORMAT_MESSAGES, rules.format) ?? 'Formato inválido.';
    case 'expression_error':
      return 'Não foi possível avaliar a regra deste campo.';
    case 'file_invalid':
      return 'Arquivo inválido ou já usado.';
    case 'file_type_not_allowed':
      return 'Tipo de arquivo não permitido.';
    case 'unexpected_data':
      return 'Este passo não recebe dados.';
    case 'payload_too_large':
      return 'Os dados passam de 256 KB.';
    case 'unknown_field':
      return 'O formulário não tem este campo.';
    case 'invalid_value': // text PostgreSQL cannot store (forms.md F1; identity.md I1)
      return component ? 'Este campo tem caracteres que não podem ser guardados.' : 'Os dados têm caracteres que não podem ser guardados.';
    default:
      return `Valor inválido (${code}).`;
  }
}

const FORMAT_MESSAGES: Readonly<Record<string, string>> = {
  email: 'Digite um e-mail válido.',
  cpf: 'CPF inválido.',
  cnpj: 'CNPJ inválido.',
  phone: 'Telefone inválido.',
  cep: 'CEP inválido.',
};

/**
 * A table's own entry for a key taken from the form's document. A name every object inherits, such as `constructor`, has
 * none, so the caller's fallback applies (ADR-0010 D9, card #201).
 */
function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

function count(value: number | undefined, one: string, many: string): string {
  return `${value ?? 0} ${value === 1 ? one : many}`;
}

function decimal(value: unknown): string {
  return typeof value === 'number' ? formatNumberInput(numberFromJson(value)) : String(value);
}

const UNITS: Readonly<Record<string, readonly [string, string]>> = {
  days: ['dia', 'dias'],
  months: ['mês', 'meses'],
  years: ['ano', 'anos'],
  hours: ['hora', 'horas'],
  minutes: ['minuto', 'minutos'],
};

function bound(side: 'min' | 'max', type: FormComponent['type'] | undefined, value: FieldValidation['min']): string {
  const lead = type === 'date' ? (side === 'min' ? 'A data mínima é' : 'A data máxima é') : type === 'time' ? (side === 'min' ? 'O horário mínimo é' : 'O horário máximo é') : side === 'min' ? 'O mínimo é' : 'O máximo é';
  return `${lead} ${describeBound(type, value)}.`;
}

function describeBound(type: FormComponent['type'] | undefined, value: FieldValidation['min']): string {
  if (typeof value === 'object' && value !== null) {
    const relative = value as RelativeBound;
    const anchor = relative.system === 'currentDate' ? 'hoje' : 'agora';
    if (!relative.offset || relative.offset.amount === 0) {
      return anchor;
    }
    const { amount, unit } = relative.offset;
    const [one, many] = own(UNITS, unit) ?? [unit, unit];
    const size = Math.abs(amount);
    return `${size} ${size === 1 ? one : many} ${amount < 0 ? 'antes de' : 'depois de'} ${anchor}`;
  }
  const text = String(value);
  if (type === 'date') {
    const [year, month, day] = text.split('-');
    return `${day}/${month}/${year}`;
  }
  if (type === 'datetime') {
    const local = toLocalInput(text);
    if (local) {
      const [date, time] = local.split('T');
      const [year, month, day] = date.split('-');
      return `${day}/${month}/${year} ${time}`;
    }
  }
  return text;
}
