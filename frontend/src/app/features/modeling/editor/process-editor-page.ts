import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { ToastService } from '../../../ui/toast/toast.service';
import { CanLeave } from '../can-leave';
import { NAME_LIMIT, invalidNameText } from '../process-name';
import { moveInToolbar } from '../toolbar';
import { problemText } from '../validation-messages';
import { DraftProblem, NodeType, ProcessDraft } from '../workflow-document';
import { WorkflowsApi, problemsOf } from '../workflows-api';
import { DraftEditor } from '../../../diagram/draft-editor';
import { DraftJsonDialog } from './draft-json-dialog';
import { VersionDialog, VersionDialogData } from './version-dialog';
import { VersionsPanel, VersionsPanelData } from './versions-panel';
import { LaneProperties, NodeProperties, withLayout } from '../../../diagram/edits';
import { LanePanel, LanePanelData } from './lane-panel';
import { NodePanel, NodePanelData } from './node-panel';
import { PermissionsPanel, PermissionsPanelData, PermissionsResult } from './permissions-panel';
import { describeSelection, labelOf } from '../../../diagram/names';
import { WorkflowCanvas } from '../../../diagram/workflow-canvas';

const DESCRIPTION_LIMIT = 500;

/** The editor's texts for codes whose app-wide text names no item (workflow-editor.md §10.1, card #166). */
const EDITOR_MESSAGES: Readonly<Record<string, string>> = {
  version_mismatch: 'O processo mudou desde que você o abriu. Carregue a página de novo.',
};

/** The palette (workflow-editor.md §2): what each button adds. */
const PALETTE: readonly { readonly type: NodeType; readonly label: string }[] = [
  { type: 'start', label: '+ Início' },
  { type: 'task', label: '+ Etapa' },
  { type: 'gateway', label: '+ Condicional' },
  { type: 'end', label: '+ Fim' },
];

/**
 * The workflow editor page (workflow-editor.md §2, §10). It shows the header with the name and description, the toolbar,
 * the server's problems, the canvas and the footer. The draft is edited on the canvas by click and keyboard (§10.2), saved
 * with the `ETag`, validated and published; validating and publishing save unsaved changes first, since the server checks
 * the saved draft.
 */
@Component({
  selector: 'chain-process-editor-page',
  imports: [Alert, Button, DatePipe, FormField, Input, RouterLink, WorkflowCanvas],
  providers: [DraftEditor],
  templateUrl: './process-editor-page.html',
  styleUrls: ['../editor-frame.css', './process-editor-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessEditorPage implements CanLeave {
  private readonly api = inject(WorkflowsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  private readonly canvas = viewChild(WorkflowCanvas);
  protected readonly editor = inject(DraftEditor);

  protected readonly palette = PALETTE;
  protected readonly nameLimit = NAME_LIMIT;
  protected readonly descriptionLimit = DESCRIPTION_LIMIT;
  protected readonly process = signal<ProcessDraft | null>(null);
  protected readonly loadError = signal<ApiProblem | null>(null);
  /** The server's problems with the draft; null until it is validated or a publish or save is refused. */
  protected readonly problems = signal<readonly DraftProblem[] | null>(null);
  protected readonly problemIds = computed(() => new Set((this.problems() ?? []).flatMap((problem) => problem.elementId ?? [])));
  protected readonly problemsLabel = computed(() => {
    const count = this.problems()?.length ?? 0;
    return count === 1 ? '1 problema' : `${count} problemas`;
  });
  /** A problem in pt-BR, shown before its code (§10.1). */
  protected readonly problemText = problemText;
  protected readonly moveInToolbar = moveInToolbar;
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal<'save' | 'validate' | 'publish' | null>(null);
  protected readonly editing = signal(false);
  protected readonly savingHeader = signal(false);
  protected readonly nameDraft = signal('');
  protected readonly descriptionDraft = signal('');
  protected readonly nameError = signal<string | null>(null);
  protected readonly descriptionError = signal<string | null>(null);

  /** The status line: why the last action could not be done, what to do next, or what is selected. */
  protected readonly status = computed(() => {
    const document = this.editor.document();
    const pending = this.editor.pending();
    if (this.editor.notice()) {
      return this.editor.notice()!;
    }
    if (pending) {
      const source = document.nodes.find((node) => node.id === pending.source);
      const branch = pending.branch === 'true' ? ', se verdadeiro' : pending.branch === 'false' ? ', se falso' : '';
      return `Escolha o destino do fluxo que sai de “${source ? labelOf(source) : pending.source}”${branch}. Esc cancela.`;
    }
    const selection = this.editor.selection();
    const described = describeSelection(document, selection);
    // The keyboard ways to resize a lane (§10.3) and to move a flow's bend (§10.4).
    if (selection.size === 1 && document.lanes.some((lane) => selection.has(lane.id))) {
      return `${described} — Alt e as setas mudam o tamanho.`;
    }
    return this.routable() ? `${described} — as setas movem a dobra.` : described;
  });

  /** The one selected node or lane, for Propriedades… */
  protected readonly inspectable = computed(() => {
    const selection = this.editor.selection();
    const [id] = selection;
    const document = this.editor.document();
    const known = [...document.nodes, ...document.lanes].some((element) => element.id === id);
    return selection.size === 1 && !this.editor.pending() && known ? id : null;
  });

  /** The one selected flow, for Alternar rota. */
  protected readonly routable = computed(() => {
    const selection = this.editor.selection();
    const [id] = selection;
    return selection.size === 1 && this.editor.document().flows.some((flow) => flow.id === id) ? id : null;
  });

  /** The one selected node a flow can start from, for the Ligar buttons. */
  protected readonly connectable = computed(() => {
    const selection = this.editor.selection();
    if (selection.size !== 1 || this.editor.pending()) {
      return null;
    }
    const [id] = selection;
    const node = this.editor.document().nodes.find((candidate) => candidate.id === id);
    return node && node.type !== 'end' ? { id: node.id, gateway: node.type === 'gateway' } : null;
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loadError.set(null);
    this.api.get(this.id).subscribe({
      next: (process) => {
        const first = this.process() === null;
        this.process.set(process);
        if (first) {
          this.editor.load(process.draft);
          afterNextRender(() => this.canvas()?.fit(), { injector: this.injector });
        }
      },
      error: (error: unknown) => this.loadError.set(isApiProblem(error) ? error : null),
    });
  }

  protected loadMessage(problem: ApiProblem): string {
    return messageFor(problem.code);
  }

  /** Adds a node at the middle of the view, then gives it the focus so the arrow keys move it. */
  protected add(type: NodeType): void {
    const id = this.editor.add(type, this.canvas()?.viewCenter() ?? { x: 0, y: 0 });
    if (id) {
      this.focusSoon(id);
    }
  }

  protected addLane(): void {
    this.focusSoon(this.editor.addLane());
  }

  /** Starts a flow from the selected node; the focus goes to it, so Tab and Enter choose the target, and Esc cancels. */
  protected connectFrom(source: string, branch?: 'true' | 'false'): void {
    this.editor.startConnecting(source, branch);
    if (this.editor.pending()) {
      this.focusSoon(source);
    }
  }

  /** Opens a node's or a lane's properties (§10.5, §10.6); "Aplicar" applies them as one change. */
  protected openProperties(elementId: string): void {
    const document = this.editor.document();
    const node = document.nodes.find((candidate) => candidate.id === elementId);
    const lane = document.lanes.find((candidate) => candidate.id === elementId);
    if (node) {
      const catalog = () => this.api.catalog(this.id, elementId); // the saved draft's (§10.7)
      this.dialogs
        .open<NodeProperties, NodePanelData>(NodePanel, { data: { node, document, catalog, unsaved: this.editor.dirty(), workflowId: this.id }, size: 'side' })
        .closed.subscribe((properties) => properties && this.editor.applyProperties(elementId, properties));
    } else if (lane) {
      this.dialogs
        .open<LaneProperties, LanePanelData>(LanePanel, { data: { lane }, size: 'side' })
        .closed.subscribe((properties) => properties && this.editor.applyLaneProperties(elementId, properties));
    }
  }

  protected removeSelection(): void {
    const focusWasOnCanvas = document.activeElement?.closest('chain-workflow-canvas') != null;
    this.editor.removeSelection();
    if (focusWasOnCanvas) {
      afterNextRender(() => this.canvas()?.focus(), { injector: this.injector });
    }
  }

  protected clear(): void {
    this.dialogs
      .confirm({
        title: 'Esvaziar o rascunho?',
        message: 'As áreas, etapas e fluxos do rascunho serão removidos. Você pode desfazer.',
        confirmLabel: 'Esvaziar',
        tone: 'danger',
      })
      .subscribe((confirmed) => {
        if (confirmed) {
          this.editor.clear();
        }
      });
  }

  protected save(): void {
    this.saveThen('save', () => {
      this.busy.set(null);
      this.toasts.show({ tone: 'success', message: 'Rascunho salvo.' });
    });
  }

  protected validate(): void {
    this.saveThen('validate', () =>
      this.api.validate(this.id).subscribe({
        next: (problems) => {
          this.busy.set(null);
          this.problems.set(problems);
        },
        error: (error: unknown) => this.fail(error),
      }),
    );
  }

  protected publish(): void {
    this.saveThen('publish', () => {
      const process = this.process()!;
      this.api.publish(process.id, process.etag).subscribe({
        next: ({ versionNumber, created }) => {
          this.busy.set(null);
          this.problems.set(null);
          this.toasts.show({
            tone: 'success',
            message: created ? `Versão ${versionNumber} publicada.` : `Nada mudou desde a versão ${versionNumber}.`,
          });
          this.load(); // the latest version and the ETag changed
        },
        error: (error: unknown) => {
          if (isApiProblem(error) && error.code === 'publish_validation_failed') {
            this.busy.set(null);
            this.problems.set(problemsOf(error));
          } else {
            this.fail(error);
          }
        },
      });
    });
  }

  /** Brings the element of a problem to the middle of the canvas, selected. */
  protected show(problem: DraftProblem): void {
    if (problem.elementId) {
      this.canvas()?.center(problem.elementId);
    }
  }

  protected edit(): void {
    const process = this.process()!;
    this.nameDraft.set(process.name);
    this.descriptionDraft.set(process.description ?? '');
    this.nameError.set(null);
    this.descriptionError.set(null);
    this.editing.set(true);
  }

  protected saveHeader(event: Event): void {
    event.preventDefault();
    const name = this.nameDraft().trim();
    if (!name) {
      this.nameError.set('Informe o nome.');
      return;
    }

    const process = this.process()!;
    this.savingHeader.set(true);
    this.api.rename(process.id, process.etag, name, this.descriptionDraft()).subscribe({
      next: (renamed) => {
        this.savingHeader.set(false);
        this.process.set(renamed);
        this.editing.set(false);
        this.toasts.show({ tone: 'success', message: 'Processo atualizado.' });
      },
      error: (error: unknown) => {
        this.savingHeader.set(false);
        const problem = isApiProblem(error) ? error : null;
        const codes = problem ? errorCodes(problem) : [];
        if (problem?.code === 'workflow_name_taken') {
          this.nameError.set(messageFor(problem.code));
        } else if (codes.includes('invalid_name')) {
          this.nameError.set(invalidNameText(name));
        } else if (codes.includes('description_too_long')) {
          this.descriptionError.set(`A descrição pode ter no máximo ${DESCRIPTION_LIMIT} caracteres.`);
        } else if (codes.includes('invalid_description')) {
          this.descriptionError.set(messageFor('invalid_description'));
        } else {
          this.actionError.set(messageFor(problem?.code ?? 'unexpected', EDITOR_MESSAGES));
        }
      },
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected fit(): void {
    this.canvas()?.fit();
  }

  /** Versões (§10.11): the published versions; one is shown read-only, and can be restored into the draft. */
  protected showVersions(): void {
    this.dialogs
      .open<number, VersionsPanelData>(VersionsPanel, { data: { processId: this.id }, size: 'side' })
      .closed.subscribe((versionNumber) => {
        if (versionNumber !== undefined) {
          this.dialogs
            .open<'restore', VersionDialogData>(VersionDialog, { data: { processId: this.id, versionNumber }, size: 'lg' })
            .closed.subscribe((choice) => {
              if (choice === 'restore') {
                this.restore(versionNumber);
              }
            });
        }
      });
  }

  /**
   * Permissões (admin-ui.md §7): who may start, view, close, comment on and see the sensitive data of the requests. Grants
   * share the process's `ETag`, so the editor takes the new one from the answer and saves its draft next (§8, S-A2).
   */
  protected showPermissions(): void {
    const process = this.process();
    if (!process) {
      return;
    }
    this.actionError.set(null);
    this.dialogs
      .open<PermissionsResult, PermissionsPanelData>(PermissionsPanel, { data: { processId: this.id, etag: process.etag }, size: 'side' })
      .closed.subscribe((result) => {
        if (result && 'etag' in result) {
          this.process.update((current) => (current ? { ...current, etag: result.etag } : current));
          this.toasts.show({ tone: 'success', message: 'Permissões aplicadas.' });
        } else if (result) {
          this.actionError.set(result.uncertain);
        }
      });
  }

  /** Copies a version into the draft, after asking; unsaved changes are lost, and the question says so. */
  private restore(versionNumber: number): void {
    const dirty = this.editor.dirty();
    this.dialogs
      .confirm({
        title: `Restaurar a versão ${versionNumber}?`,
        message: `O rascunho passa a ser uma cópia da versão ${versionNumber}.${dirty ? ' As alterações não salvas serão perdidas.' : ''}`,
        confirmLabel: 'Restaurar',
        cancelLabel: 'Cancelar',
        tone: dirty ? 'danger' : 'primary',
      })
      .subscribe((confirmed) => {
        if (!confirmed) {
          return;
        }
        const process = this.process()!;
        this.actionError.set(null);
        this.api.restore(process.id, versionNumber, process.etag).subscribe({
          next: (restored) => {
            this.process.set(restored);
            this.editor.load(restored.draft);
            this.problems.set(null);
            afterNextRender(() => this.canvas()?.fit(), { injector: this.injector });
            this.toasts.show({ tone: 'success', message: `Versão ${versionNumber} restaurada no rascunho.` });
          },
          error: (error: unknown) => this.fail(error),
        });
      });
  }

  protected showJson(): void {
    this.dialogs.open(DraftJsonDialog, { data: JSON.stringify(this.editor.document(), null, 2), size: 'lg' });
  }

  protected downloadJson(): void {
    const process = this.process()!;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.editor.document(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${process.name}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Leaving with unsaved changes asks first. */
  canLeave(): boolean | Observable<boolean> {
    if (!this.editor.dirty()) {
      return true;
    }
    return this.dialogs.confirm({
      title: 'Sair sem salvar?',
      message: 'As alterações que você não salvou serão perdidas.',
      confirmLabel: 'Sair sem salvar',
      cancelLabel: 'Continuar editando',
      tone: 'danger',
    });
  }

  /** Closing or reloading the page with unsaved changes asks first, in the browser's own words. */
  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent): void {
    if (this.editor.dirty()) {
      event.preventDefault();
    }
  }

  /** The editor's shortcuts (§10.2), anywhere on the page but in text fields, which keep their own. */
  @HostListener('keydown', ['$event'])
  protected shortcut(event: KeyboardEvent): void {
    if (this.process() === null || typing(event.target)) {
      return;
    }
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && key === 'z') {
      if (event.shiftKey) {
        this.editor.redo();
      } else {
        this.editor.undo();
      }
    } else if (command && key === 'a') {
      this.editor.selectAll();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.editor.selection().size > 0) {
      this.removeSelection();
    } else if (event.key === 'Escape' && (this.editor.pending() || this.editor.selection().size > 0)) {
      if (this.editor.pending()) {
        this.editor.cancelConnecting();
      } else {
        this.editor.clearSelection();
      }
    } else {
      return;
    }
    event.preventDefault();
  }

  /** Saves unsaved changes, then goes on; with nothing to save, goes on at once. */
  private saveThen(action: 'save' | 'validate' | 'publish', next: () => void): void {
    this.busy.set(action);
    this.actionError.set(null);
    if (!this.editor.dirty()) {
      next();
      return;
    }

    const document = this.editor.document();
    const process = this.process()!;
    this.api.saveDraft(process.id, process.etag, withLayout(document)).subscribe({
      next: (saved) => {
        this.process.set(saved);
        this.editor.markSaved(document);
        next();
      },
      error: (error: unknown) => {
        if (isApiProblem(error) && error.code === 'invalid_document') {
          this.busy.set(null);
          this.problems.set(problemsOf(error));
        } else {
          this.fail(error);
        }
      },
    });
  }

  private focusSoon(elementId: string): void {
    afterNextRender(() => this.canvas()?.focusElement(elementId), { injector: this.injector });
  }

  private fail(error: unknown): void {
    this.busy.set(null);
    this.actionError.set(messageFor(isApiProblem(error) ? error.code : 'unexpected', EDITOR_MESSAGES));
  }
}

/** Whether a key goes to a field the author types in. */
function typing(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(target.type);
  }
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}
