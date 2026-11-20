import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { FieldValidation, FormComponent } from '../../../forms/model';
import { ValidationFields } from './validation-fields';

describe('ValidationFields: Validação (form-designer.md §8.1, N3d)', () => {
  async function open(component: FormComponent) {
    const changes: (FieldValidation | undefined)[] = [];
    const view = await render(ValidationFields, { inputs: { component }, on: { changed: (v: FieldValidation | undefined) => changes.push(v) } });
    const apply = (validate: FieldValidation | undefined) => {
      view.fixture.componentRef.setInput('component', { ...component, validate });
      view.fixture.detectChanges();
    };
    return { changes, apply, last: () => changes[changes.length - 1] };
  }
  const box = (name: string | RegExp) => screen.getByRole('textbox', { name });
  const user = () => userEvent.setup();

  it('text: lengths, the format, and a pattern with FM005 at its field', async () => {
    const { last, apply } = await open({ type: 'text', key: 'cpf', label: 'CPF', validate: { required: true } });
    const u = user();

    await u.type(box('Comprimento máximo'), '14');
    await u.tab();
    expect(last()).toEqual({ required: true, maxLength: 14 });
    apply(last());

    await u.type(box('Comprimento mínimo'), '20');
    await u.tab();
    expect(last()).toEqual({ required: true, maxLength: 14, minLength: 20 });
    apply(last());
    expect(screen.getByText('O máximo não pode ser menor que o mínimo.')).toBeTruthy();

    await u.selectOptions(screen.getByRole('combobox', { name: 'Formato' }), 'CPF');
    expect(last()).toMatchObject({ format: 'cpf' });
    apply(last());

    await u.selectOptions(screen.getByRole('combobox', { name: 'Formato' }), 'Padrão');
    expect(last()).not.toHaveProperty('format');
    apply(last());
    await u.type(box('Padrão'), '[[0-9]'); // user-event types [[ as one [
    await u.tab();
    expect(last()).toMatchObject({ pattern: '[0-9]' });
    apply(last());
    await u.clear(box('Padrão'));
    await u.type(box('Padrão'), '([[0-9]');
    await u.tab();
    expect(last()).toMatchObject({ pattern: '([0-9]' }); // it applies, and FM005 shows at the field
    apply(last());
    expect(screen.getByText(/O padrão não pode ser usado/)).toBeTruthy();

    await u.clear(box('Padrão'));
    await u.type(box('Padrão'), '\\d{{3}');
    await u.tab();
    apply(last());
    expect(screen.getByText('O padrão não pode usar \\d: use [0-9].')).toBeTruthy(); // the allowlist names the construct (card #149)
  });

  it('refuses a length that is not a whole number, and clears one left empty', async () => {
    const { changes, last, apply } = await open({ type: 'textarea', key: 'obs', label: 'Obs', validate: { maxLength: 500 } });
    const u = user();

    await u.clear(box('Comprimento máximo'));
    await u.type(box('Comprimento máximo'), '1,5');
    await u.tab();
    expect(changes).toHaveLength(0);
    expect(screen.getByText('Use um número inteiro, 0 ou maior.')).toBeTruthy();

    await u.clear(box('Comprimento máximo'));
    await u.tab();
    expect(last()).toBeUndefined();
    apply(last());
    expect(screen.queryByRole('combobox', { name: 'Formato' })).toBeNull(); // a format is for text fields
  });

  it('number: limits with a decimal comma, decimals and step', async () => {
    const { last, apply, changes } = await open({ type: 'number', key: 'valor', label: 'Valor' });
    const u = user();

    await u.type(box('Mínimo'), '1,5');
    await u.tab();
    expect(last()).toEqual({ min: 1.5 });
    apply(last());
    await u.type(box('Máximo'), 'muito');
    await u.tab();
    expect(changes).toHaveLength(1);
    expect(screen.getByText('Use um número, com vírgula antes das casas decimais.')).toBeTruthy();

    await u.type(box('Casas decimais'), '11');
    await u.tab();
    expect(screen.getByText('Use de 0 a 10.')).toBeTruthy();
    await u.clear(box('Casas decimais'));
    await u.type(box('Casas decimais'), '2');
    await u.tab();
    expect(last()).toEqual({ min: 1.5, decimalDigits: 2 });
    apply(last());

    await u.type(box('Incremento'), '0');
    await u.tab();
    expect(screen.getByText('Use um número maior que zero.')).toBeTruthy();
    await u.clear(box('Incremento'));
    await u.type(box('Incremento'), '0,5');
    await u.tab();
    expect(last()).toEqual({ min: 1.5, decimalDigits: 2, step: 0.5 });
  });

  it('date: a relative minimum and a fixed maximum (§8.1)', async () => {
    const { last, apply } = await open({ type: 'date', key: 'inicio', label: 'Início' });
    const u = user();
    const minimum = within(screen.getByRole('group', { name: 'Mínimo' }));

    await u.selectOptions(minimum.getByRole('combobox', { name: 'Mínimo: limite' }), 'Hoje');
    expect(last()).toEqual({ min: { system: 'currentDate' } });
    apply(last());
    await u.selectOptions(minimum.getByRole('combobox', { name: 'Ajuste' }), 'mais');
    await u.type(minimum.getByRole('textbox', { name: 'Quantidade' }), '2');
    expect(last()).toEqual({ min: { system: 'currentDate', offset: { amount: 2, unit: 'days' } } });
    apply(last());

    const maximum = within(screen.getByRole('group', { name: 'Máximo' }));
    await u.selectOptions(maximum.getByRole('combobox', { name: 'Máximo: limite' }), 'Data fixa');
    const date = maximum.getByLabelText('Máximo: valor');
    await u.type(date, '2026-12-31');
    await u.tab();
    expect(last()).toEqual({ min: { system: 'currentDate', offset: { amount: 2, unit: 'days' } }, max: '2026-12-31' });
  });

  it('datetime: a fixed limit is entered in UTC−03:00, and a time has fixed limits only', async () => {
    const { last } = await open({ type: 'datetime', key: 'reuniao', label: 'Reunião' });
    const u = user();
    const maximum = within(screen.getByRole('group', { name: 'Máximo' }));

    await u.selectOptions(maximum.getByRole('combobox', { name: 'Máximo: limite' }), 'Data e hora fixa');
    await u.type(maximum.getByLabelText('Máximo: valor'), '2026-01-31T10:00');
    await u.tab();

    expect(last()).toEqual({ max: '2026-01-31T10:00-03:00' });
  });

  it('time: no relative limit', async () => {
    await open({ type: 'time', key: 'hora', label: 'Hora' });

    const options = Array.from((screen.getByRole('combobox', { name: 'Mínimo: limite' }) as HTMLSelectElement).options).map((option) => option.text);
    expect(options).toEqual(['Sem limite', 'Hora fixa']);
  });

  it('checklist, list and file limits, and the accepted types by family', async () => {
    const checklist = await open({ type: 'checklist', key: 'docs', label: 'Docs', options: [{ value: 'a', label: 'A' }] });
    const u = user();
    await u.type(box('Seleções mínimas'), '1');
    await u.tab();
    expect(checklist.last()).toEqual({ minSelected: 1 });
    expect(screen.getByRole('checkbox', { name: 'Obrigatório' })).toBeTruthy();
  });

  it('a list counts its rows', async () => {
    const list = await open({ type: 'dynamicList', key: 'socios', label: 'Sócios', components: [] });
    const u = user();
    await u.type(box('Linhas máximas'), '5');
    await u.tab();
    expect(list.last()).toEqual({ maxRows: 5 });
    expect(screen.queryByRole('checkbox', { name: 'Obrigatório' })).toBeNull();
  });

  it('a file field limits its files and types', async () => {
    const file = await open({ type: 'file', key: 'rg', label: 'RG' });
    const u = user();

    await u.type(box('Máximo de arquivos'), '11');
    await u.tab();
    expect(screen.getByText('Use de 1 a 10.')).toBeTruthy();

    await u.click(screen.getByRole('checkbox', { name: 'PDF' }));
    file.apply(file.last());
    await u.click(screen.getByRole('checkbox', { name: 'Imagens' }));
    expect(file.last()).toEqual({ accept: ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'] });
    file.apply(file.last());

    await u.click(screen.getByRole('checkbox', { name: 'PDF' }));
    file.apply(file.last());
    await u.click(screen.getByRole('checkbox', { name: 'Imagens' }));
    expect(file.last()).toBeUndefined(); // none checked: every allowed type
  });

  it('toggles Obrigatório, keeping the other rules', async () => {
    const { last } = await open({ type: 'number', key: 'valor', label: 'Valor', validate: { min: 1 } });

    await user().click(screen.getByRole('checkbox', { name: 'Obrigatório' }));

    expect(last()).toEqual({ min: 1, required: true });
  });
});
