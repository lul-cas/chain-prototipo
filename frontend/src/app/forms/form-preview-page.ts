import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { Button } from '../ui/button/button';
import { FormRenderer } from './form-renderer';
import { FormDocument } from './model';

const path = (...segments: string[]) => ({ kind: 'path', path: segments });
const equalsText = (key: string, value: string) => ({ kind: 'compare', left: path(key), operator: 'equals', right: { kind: 'literal', type: 'text', value } });

/** Every component type, conditions and a computed field: the sample the owner reviews (development only). */
const SAMPLE: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'heading', text: 'Proposta de crédito' },
    { type: 'paragraph', text: 'Os campos mudam conforme o tipo de cliente.' },
    {
      type: 'radio',
      key: 'tipo',
      label: 'Tipo de cliente',
      validate: { required: true },
      options: [
        { value: 'pf', label: 'Pessoa física' },
        { value: 'pj', label: 'Pessoa jurídica' },
      ],
    },
    { type: 'text', key: 'cpf', label: 'CPF', placeholder: '000.000.000-00', validate: { format: 'cpf' }, visibleWhen: equalsText('tipo', 'pf'), requiredWhen: equalsText('tipo', 'pf') },
    { type: 'text', key: 'cnpj', label: 'CNPJ', placeholder: '00.000.000/0000-00', validate: { format: 'cnpj' }, visibleWhen: equalsText('tipo', 'pj'), requiredWhen: equalsText('tipo', 'pj') },
    { type: 'number', key: 'quantidade', label: 'Parcelas', validate: { min: 1, max: 60, decimalDigits: 0 } },
    { type: 'number', key: 'parcela', label: 'Valor da parcela', validate: { min: 100, decimalDigits: 2 } },
    { type: 'computed', key: 'total', label: 'Total', expression: { kind: 'arithmetic', op: 'multiply', left: path('quantidade'), right: path('parcela') } },
    { type: 'separator' },
    {
      type: 'select',
      key: 'modalidade',
      label: 'Modalidade',
      options: [
        { value: 'giro', label: 'Capital de giro' },
        { value: 'invest', label: 'Investimento' },
      ],
    },
    {
      type: 'checklist',
      key: 'documentos',
      label: 'Documentos entregues',
      validate: { minSelected: 1 },
      options: [
        { value: 'rg', label: 'RG' },
        { value: 'cnh', label: 'CNH' },
        { value: 'comprovante', label: 'Comprovante de endereço' },
      ],
    },
    { type: 'date', key: 'inicio', label: 'Início', validate: { min: { system: 'currentDate' } } },
    { type: 'time', key: 'horario', label: 'Horário para contato' },
    { type: 'datetime', key: 'reuniao', label: 'Reunião' },
    { type: 'textarea', key: 'observacoes', label: 'Observações', validate: { maxLength: 500 } },
    { type: 'text', key: 'protocolo', label: 'Protocolo', readOnly: true },
    { type: 'file', key: 'contrato', label: 'Contrato assinado' },
    {
      type: 'group',
      key: 'endereco',
      label: 'Endereço',
      components: [
        { type: 'text', key: 'cep', label: 'CEP', validate: { required: true, format: 'cep' } },
        { type: 'text', key: 'logradouro', label: 'Logradouro' },
      ],
    },
    {
      type: 'dynamicList',
      key: 'socios',
      label: 'Sócios',
      visibleWhen: equalsText('tipo', 'pj'),
      validate: { minRows: 1, maxRows: 5 },
      components: [
        { type: 'text', key: 'nome', label: 'Nome', validate: { required: true } },
        { type: 'text', key: 'email', label: 'E-mail', validate: { format: 'email' } },
      ],
    },
    { type: 'checkbox', key: 'aceite', label: 'Li e aceito os termos', validate: { required: true } },
  ],
};

/** A sample form for reviewing the renderer (forms.md F3). Registered in dev-routes.ts only, like /_design. */
@Component({
  selector: 'chain-form-preview-page',
  imports: [Button, FormRenderer],
  template: `
    <main class="chain-form-preview">
      <h1>Formulário de exemplo</h1>
      <p>Esta página existe só no ambiente de desenvolvimento, para revisar o formulário antes da tela de tarefa.</p>
      <h2>Dados da tarefa</h2>
      <chain-form-renderer [document]="sample" [prefill]="prefill" (submitted)="sent.set($event.json)">
        <button chainButton type="submit">Concluir</button>
      </chain-form-renderer>
      @if (sent()) {
        <h2>Enviaria</h2>
        <pre class="chain-mono" aria-label="Dados enviados">{{ sent() }}</pre>
      }
    </main>
  `,
  styles: `
    .chain-form-preview {
      max-width: var(--chain-size-measure);
      margin: 0 auto;
      padding: var(--chain-space-6) var(--chain-space-4);
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormPreviewPage {
  protected readonly sample = SAMPLE;
  protected readonly prefill = { protocolo: 'P-2026-000123' };
  protected readonly sent = signal<string | null>(null);
}
