import { FormComponent, RelativeBound } from './model';
import { fieldMessage } from './messages';

const field = (type: FormComponent['type'], validate: FormComponent['validate'] = {}): FormComponent => ({ type, key: 'campo', label: 'Campo', validate });

describe('field messages (pt-BR, forms.md F3)', () => {
  it.each([
    ['required', field('text'), 'Preencha este campo.'],
    ['required', field('checkbox'), 'Marque esta opção.'],
    ['required', field('select'), 'Escolha uma opção.'],
    ['type_mismatch', field('number'), 'Digite um número, como 1234,56.'],
    ['type_mismatch', field('date'), 'Data inválida.'],
    ['type_mismatch', field('time'), 'Horário inválido.'],
    ['type_mismatch', field('text'), 'Valor inválido.'],
    ['too_short', field('text', { minLength: 3 }), 'Use pelo menos 3 caracteres.'],
    ['too_short', field('text', { minLength: 1 }), 'Use pelo menos 1 caractere.'],
    ['too_long', field('text', { maxLength: 10 }), 'Use no máximo 10 caracteres.'],
    ['too_small', field('number', { min: 1000.5 }), 'O valor mínimo é 1000,5.'],
    ['too_large', field('number', { max: 10 }), 'O valor máximo é 10.'],
    ['too_many_decimals', field('number', { decimalDigits: 2 }), 'Use no máximo 2 casas decimais.'],
    ['too_many_decimals', field('number', { decimalDigits: 1 }), 'Use no máximo 1 casa decimal.'],
    ['too_many_decimals', field('number', { decimalDigits: 0 }), 'Use um número inteiro.'],
    ['invalid_step', field('number', { step: 0.5 }), 'Use um valor em passos de 0,5.'],
    ['too_early', field('date', { min: '2026-01-31' }), 'A data mínima é 31/01/2026.'],
    ['too_late', field('date', { max: { system: 'currentDate' } }), 'A data máxima é hoje.'],
    ['too_early', field('date', { min: { system: 'currentDate', offset: { amount: -1, unit: 'months' } } }), 'A data mínima é 1 mês antes de hoje.'],
    ['too_late', field('datetime', { max: { system: 'currentDateTime', offset: { amount: 2, unit: 'hours' } } }), 'O máximo é 2 horas depois de agora.'],
    ['too_early', field('time', { min: '08:00' }), 'O horário mínimo é 08:00.'],
    ['invalid_option', field('select'), 'Escolha uma das opções.'],
    ['too_few', field('checklist', { minSelected: 2 }), 'Selecione pelo menos 2 opções.'],
    ['too_many', field('checklist', { maxSelected: 1 }), 'Selecione no máximo 1 opção.'],
    ['too_few', field('dynamicList', { minRows: 1 }), 'Adicione pelo menos 1 linha.'],
    ['too_many', field('dynamicList', { maxRows: 5 }), 'Use no máximo 5 linhas.'],
    ['invalid_format', field('text', { format: 'email' }), 'Digite um e-mail válido.'],
    ['invalid_format', field('text', { format: 'cpf' }), 'CPF inválido.'],
    ['invalid_format', field('text', { format: 'cnpj' }), 'CNPJ inválido.'],
    ['invalid_format', field('text', { format: 'phone' }), 'Telefone inválido.'],
    ['invalid_format', field('text', { format: 'cep' }), 'CEP inválido.'],
    ['invalid_format', field('text', { pattern: '[0-9]+' }), 'Formato inválido.'],
    ['expression_error', field('text'), 'Não foi possível avaliar a regra deste campo.'],
    ['file_invalid', field('file'), 'Arquivo inválido ou já usado.'],
    ['invalid_value', field('textarea'), 'Este campo tem caracteres que não podem ser guardados.'],
    ['mystery_code', field('text'), 'Valor inválido (mystery_code).'],
  ] as const)('%s on %o says %j', (code, component, message) => {
    expect(fieldMessage(code, component)).toBe(message);
  });

  // Card #201: the format and the unit come from the form's document, so a name every object inherits is not one of them.
  it.each(['constructor', 'toString', '__proto__'])('reads a format or a unit named %s as an unknown one', (name) => {
    expect(fieldMessage('invalid_format', field('text', { format: name }))).toBe('Formato inválido.');
    const unit = name as NonNullable<RelativeBound['offset']>['unit'];
    expect(fieldMessage('too_early', field('date', { min: { system: 'currentDate', offset: { amount: 2, unit } } }))).toBe(`A data mínima é 2 ${name} depois de hoje.`);
  });

  it('words errors that belong to the whole form', () => {
    expect(fieldMessage('unexpected_data', null)).toBe('Este passo não recebe dados.');
    expect(fieldMessage('payload_too_large', null)).toBe('Os dados passam de 256 KB.');
    expect(fieldMessage('unknown_field', null)).toBe('O formulário não tem este campo.');
    expect(fieldMessage('invalid_value', null)).toBe('Os dados têm caracteres que não podem ser guardados.');
  });
});
