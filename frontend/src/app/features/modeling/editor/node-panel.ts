import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild } from '@angular/core';
import { Observable } from 'rxjs';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { FormOption, FormsApi } from '../forms-api';
import { NodeType, WorkflowDocument, WorkflowNode } from '../workflow-document';
import { AutomationStep } from './automation-step';
import { SubprocessStep } from './subprocess-step';
import { ConditionBuilder } from './condition-builder';
import { CatalogEntry, Group, toJson, toRows } from './conditions';
import { NodeProperties, invalidExits } from '../../../diagram/edits';
import { FormPreviewDialog, FormPreviewData } from './form-preview-dialog';
import { KIND_LABEL, Kind, kindOf, labelOf } from '../../../diagram/names';

export interface NodePanelData {
  readonly node: WorkflowNode;
  readonly document: WorkflowDocument;
  /** The data at this node in the saved draft, for the condition builder; null when the saved draft lacks the node. */
  readonly catalog: () => Observable<readonly CatalogEntry[] | null>;
  /** Whether the editor has changes the saved draft, and so the catalog, doesn't have. */
  readonly unsaved: boolean;
  /** The process being edited, which a sub-workflow step can't call (WF106). */
  readonly workflowId: string;
}

/** WF012: a label's length. */
const LABEL_LIMIT = 120;
/** What *Tipo* offers (§9, §10.9, §10.10). */
const KINDS: readonly Kind[] = ['start', 'task', 'automatic', 'subworkflow', 'gateway', 'end'];
const NODE_TYPE: Readonly<Record<Kind, NodeType>> = {
  start: 'start',
  task: 'task',
  automatic: 'task',
  subworkflow: 'task',
  gateway: 'gateway',
  end: 'end',
};

/**
 * "Propriedades" (workflow-editor.md §5, §10.5): a node's type, label and form, and a person's gateway with its question and
 * its true and false steps. It closes with the properties on "Aplicar", after asking when the new type removes flows (E8),
 * or with nothing.
 */
@Component({
  selector: 'chain-node-panel',
  imports: [Alert, AutomationStep, Button, ConditionBuilder, DialogLayout, FormField, Input, NgTemplateOutlet, SubprocessStep],
  template: `
    <chain-dialog title="Propriedades">
      <form id="chain-node-panel" class="chain-node-panel" (submit)="apply($event)">
        <chain-form-field label="Tipo">
          <select chainInput [value]="kind()" (change)="changeKind(chosen($event))">
            @for (option of kinds; track option) {
              <option [value]="option" [selected]="option === kind()">{{ kindLabel[option] }}</option>
            }
          </select>
        </chain-form-field>

        <chain-form-field label="Rótulo" required [error]="labelError()">
          <input chainInput type="text" [maxLength]="labelLimit" [value]="label()" (input)="label.set(chosen($event)); labelError.set(null)" />
        </chain-form-field>

        @if (takesForm()) {
          <div class="chain-node-panel__form">
            <chain-form-field label="Formulário">
              <select chainInput [disabled]="forms() === null" (change)="formId.set(chosen($event) || null)">
                <option value="" [selected]="formId() === null">{{ forms() === null ? 'Carregando…' : 'Nenhum' }}</option>
                @for (form of forms() ?? []; track form.id) {
                  <option [value]="form.id" [selected]="form.id === formId()">
                    {{ form.latestVersion === null ? form.name + ' (nunca publicado)' : form.name }}
                  </option>
                }
              </select>
            </chain-form-field>
            <button chainButton variant="secondary" size="sm" type="button" [disabled]="!previewable()" [loading]="previewing()" (click)="preview()">
              Visualizar
            </button>
          </div>
          @if (formsError(); as message) {
            <chain-alert tone="danger">{{ message }}</chain-alert>
          }
        }

        @if (kind() === 'automatic') {
          <div class="chain-node-panel__condition">
            <ng-container *ngTemplateOutlet="catalogNotes" />
            @if (catalog() === undefined) {
              <p class="chain-node-panel__loading">Carregando os dados…</p>
            } @else {
              <chain-automation-step [stored]="storedAutomation" [catalog]="catalog() ?? []" />
            }
            @if (stepError(); as message) {
              <p class="chain-node-panel__error">{{ message }}</p>
            }
          </div>
        }

        @if (kind() === 'subworkflow') {
          <div class="chain-node-panel__condition">
            <ng-container *ngTemplateOutlet="catalogNotes" />
            @if (catalog() === undefined) {
              <p class="chain-node-panel__loading">Carregando os dados…</p>
            } @else {
              <chain-subprocess-step [stored]="storedWorkflow" [catalog]="catalog() ?? []" [exclude]="data.workflowId" />
            }
            @if (stepError(); as message) {
              <p class="chain-node-panel__error">{{ message }}</p>
            }
          </div>
        }

        @if (type() === 'gateway') {
          <chain-form-field label="Modo de decisão" hint="Humano: uma pessoa responde à pergunta. Automático: a condição decide.">
            <select chainInput (change)="changeMode(chosen($event))">
              <option value="human" [selected]="decisionMode() === 'human'">Humano</option>
              <option value="automatic" [selected]="decisionMode() === 'automatic'">Automático</option>
            </select>
          </chain-form-field>
          @if (decisionMode() === 'human') {
            <chain-form-field label="Pergunta" required hint="O que perguntar a quem decide." [error]="questionError()">
              <input chainInput type="text" [value]="question()" (input)="question.set(chosen($event)); questionError.set(null)" />
            </chain-form-field>
          } @else {
            <div class="chain-node-panel__condition">
              <ng-container *ngTemplateOutlet="catalogNotes" />
              @if (catalog() === undefined) {
                <p class="chain-node-panel__loading">Carregando os dados…</p>
              } @else {
                <chain-condition-builder [(rows)]="rows" [catalog]="catalog() ?? []" />
              }
              @if (conditionError(); as message) {
                <p class="chain-node-panel__error">{{ message }}</p>
              }
            </div>
          }
          <chain-form-field label="Etapa se verdadeiro">
            <select chainInput (change)="whenTrue.set(chosen($event) || null)">
              <option value="" [selected]="whenTrue() === null">Nenhuma</option>
              @for (target of targets; track target.id) {
                <option [value]="target.id" [selected]="target.id === whenTrue()">{{ target.label }}</option>
              }
            </select>
          </chain-form-field>
          <chain-form-field label="Etapa se falso">
            <select chainInput (change)="whenFalse.set(chosen($event) || null)">
              <option value="" [selected]="whenFalse() === null">Nenhuma</option>
              @for (target of targets; track target.id) {
                <option [value]="target.id" [selected]="target.id === whenFalse()">{{ target.label }}</option>
              }
            </select>
          </chain-form-field>
        }
      </form>
      <!-- Where the data of the builder and of the mappings come from (§10.7). -->
      <ng-template #catalogNotes>
        @if (unsaved) {
          <chain-alert tone="info">Há alterações não salvas: os dados vêm do rascunho salvo.</chain-alert>
        }
        @if (catalogFailed()) {
          <chain-alert tone="danger">Não foi possível ler os dados {{ subject() }}.</chain-alert>
        } @else if (catalog() === null) {
          <chain-alert tone="warning">Salve o rascunho para escolher os dados {{ subject() }}.</chain-alert>
        }
      </ng-template>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-node-panel">Aplicar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-node-panel {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-4);
    }

    .chain-node-panel__form {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: var(--chain-space-2);
    }

    .chain-node-panel__form > chain-form-field {
      flex: 1;
    }

    .chain-node-panel__condition {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-node-panel__loading {
      margin: 0;
      color: var(--color-text-muted);
    }

    .chain-node-panel__error {
      margin: 0;
      color: var(--color-text-danger);
      font-size: var(--chain-font-size-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodePanel {
  protected readonly ref = inject<DialogRef<NodeProperties>>(DialogRef);
  private readonly data = inject<NodePanelData>(DIALOG_DATA);
  private readonly formsApi = inject(FormsApi);
  private readonly dialogs = inject(DialogService);
  private readonly node = this.data.node;

  protected readonly labelLimit = LABEL_LIMIT;
  protected readonly kindLabel = KIND_LABEL;
  /** *Início* only while there is no other start. */
  protected readonly kinds = KINDS.filter(
    (kind) => kind !== 'start' || this.node.type === 'start' || !this.data.document.nodes.some((node) => node.type === 'start'),
  );
  protected readonly unsaved = this.data.unsaved;
  protected readonly targets = this.data.document.nodes
    .filter((node) => node.id !== this.node.id)
    .map((node) => ({ id: node.id, label: labelOf(node) }));

  protected readonly kind = signal<Kind>(kindOf(this.node));
  protected readonly type = computed<NodeType>(() => NODE_TYPE[this.kind()]);
  /** The automatic step's stored reference, which its panel shows and keeps if untouched (§10.9). */
  protected readonly storedAutomation = this.node['automation'];
  /** The sub-workflow step's stored reference (§10.10). */
  protected readonly storedWorkflow = this.node['workflow'];
  private readonly step = viewChild(AutomationStep);
  private readonly subprocessStep = viewChild(SubprocessStep);
  protected readonly stepError = signal<string | null>(null);
  /** Whose data the notes speak of. */
  protected readonly subject = computed(() => (this.kind() === 'gateway' ? 'desta condicional' : 'desta etapa'));
  protected readonly label = signal(this.node.label);
  protected readonly formId = signal<string | null>(((this.node['form'] as { formId?: string } | undefined)?.formId ?? null) || null);
  protected readonly question = signal(typeof this.node['question'] === 'string' ? (this.node['question'] as string) : '');
  protected readonly decisionMode = signal<'human' | 'automatic'>(this.node.type === 'gateway' && this.node.decisionMode === 'automatic' ? 'automatic' : 'human');
  /** The condition being built (§10.7), from the gateway's own, which Aplicar keeps as it is if the builder didn't touch it. */
  private readonly storedRows = toRows(this.node['condition']);
  protected readonly rows = signal<Group>(this.storedRows);
  /** The data at the gateway: undefined until read, null when the saved draft lacks the gateway. */
  protected readonly catalog = signal<readonly CatalogEntry[] | null | undefined>(undefined);
  protected readonly catalogFailed = signal(false);
  private catalogAsked = false;
  protected readonly conditionError = signal<string | null>(null);
  protected readonly whenTrue = signal(this.branchTarget('true'));
  protected readonly whenFalse = signal(this.branchTarget('false'));
  protected readonly labelError = signal<string | null>(null);
  protected readonly questionError = signal<string | null>(null);
  protected readonly forms = signal<readonly FormOption[] | null>(null);
  protected readonly formsError = signal<string | null>(null);
  protected readonly previewing = signal(false);

  protected readonly takesForm = computed(() => this.kind() === 'start' || this.kind() === 'task');
  private readonly chosenForm = computed(() => this.forms()?.find((form) => form.id === this.formId()) ?? null);
  protected readonly previewable = computed(() => (this.chosenForm()?.latestVersion ?? null) !== null);

  constructor() {
    if (this.decisionMode() === 'automatic' || this.kind() === 'automatic' || this.kind() === 'subworkflow') {
      this.readCatalog();
    }
    this.formsApi.list().subscribe({
      next: (forms) => this.forms.set(forms),
      error: () => {
        this.forms.set([]);
        this.formsError.set('Não foi possível carregar os formulários.');
      },
    });
  }

  protected chosen(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  /** Automático builds a condition from the gateway's data, read once from the saved draft (§10.7). */
  protected changeMode(value: string): void {
    const mode = value === 'automatic' ? 'automatic' : 'human';
    this.decisionMode.set(mode);
    this.conditionError.set(null);
    if (mode === 'automatic') {
      this.readCatalog();
    }
  }

  /** A node that becomes a gateway asks, by default, its label as the question (§10.5); an automatic step reads its data (§10.9). */
  protected changeKind(value: string): void {
    const kind = value as Kind;
    if (kind === 'gateway' && this.node.type !== 'gateway' && !this.question()) {
      this.question.set(this.label());
    }
    this.kind.set(kind);
    this.stepError.set(null);
    if (kind === 'automatic' || kind === 'subworkflow') {
      this.readCatalog();
    }
  }

  protected preview(): void {
    const form = this.chosenForm();
    if (!form || form.latestVersion === null) {
      return;
    }
    this.previewing.set(true);
    this.formsApi.version(form.id, form.latestVersion).subscribe({
      next: (document) => {
        this.previewing.set(false);
        this.dialogs.open<unknown, FormPreviewData>(FormPreviewDialog, { data: { name: form.name, document }, size: 'lg' });
      },
      error: () => {
        this.previewing.set(false);
        this.formsError.set('Não foi possível abrir o formulário.');
      },
    });
  }

  protected apply(event: Event): void {
    event.preventDefault();
    const label = this.label().trim();
    const gateway = this.type() === 'gateway';
    const asksPerson = gateway && this.decisionMode() === 'human';
    const written = gateway && !asksPerson ? toJson(this.rows()) : null;
    const step =
      this.kind() === 'automatic'
        ? (this.step()?.result() ?? { reference: this.storedAutomation ?? null })
        : this.kind() === 'subworkflow'
          ? (this.subprocessStep()?.result() ?? { reference: this.storedWorkflow ?? null })
          : null;
    this.labelError.set(!label ? 'Informe o rótulo.' : null);
    this.questionError.set(asksPerson && !this.question().trim() ? 'Informe a pergunta.' : null);
    this.conditionError.set(written && 'incomplete' in written ? 'Complete ou remova as condições incompletas.' : null);
    this.stepError.set(
      step && 'incomplete' in step ? (this.kind() === 'automatic' ? 'Corrija as entradas e as saídas da automação.' : 'Corrija as entradas e as saídas do subprocesso.') : null,
    );
    if (this.labelError() || this.questionError() || this.conditionError() || this.stepError()) {
      return;
    }

    const properties: NodeProperties = {
      type: this.type(),
      taskKind: this.kind() === 'automatic' ? 'automation' : this.kind() === 'subworkflow' ? 'subprocess' : 'human',
      automation: this.kind() === 'automatic' && step && 'reference' in step ? step.reference : null,
      workflow: this.kind() === 'subworkflow' && step && 'reference' in step ? step.reference : null,
      label,
      formId: this.takesForm() ? this.formId() : null,
      decisionMode: this.decisionMode(),
      question: this.question().trim(),
      condition: this.rows() === this.storedRows && this.node['condition'] !== undefined ? this.node['condition'] : written && 'json' in written ? written.json : null,
      whenTrue: this.whenTrue(),
      whenFalse: this.whenFalse(),
    };
    const removed = invalidExits(this.data.document, this.node.id, properties.type).length;
    if (removed === 0) {
      this.ref.close(properties);
      return;
    }
    this.dialogs
      .confirm({
        title: 'Mudar o tipo?',
        message:
          removed === 1
            ? '1 fluxo deixa de valer para o novo tipo e será removido.'
            : `${removed} fluxos deixam de valer para o novo tipo e serão removidos.`,
        confirmLabel: 'Mudar o tipo',
        cancelLabel: 'Voltar',
        tone: 'danger',
      })
      .subscribe((confirmed) => {
        if (confirmed) {
          this.ref.close(properties);
        }
      });
  }

  /** Reads the data once; if they can't be read, the builder has none, so it shows the condition as text and keeps it. */
  private readCatalog(): void {
    if (this.catalogAsked) {
      return;
    }
    this.catalogAsked = true;
    this.data.catalog().subscribe({
      next: (entries) => this.catalog.set(entries),
      error: () => {
        this.catalogFailed.set(true);
        this.catalog.set([]);
      },
    });
  }

  private branchTarget(branch: 'true' | 'false'): string | null {
    return this.data.document.flows.find((flow) => flow.source === this.node.id && flow.branch === branch)?.target ?? null;
  }
}
