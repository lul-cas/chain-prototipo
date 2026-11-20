import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal, viewChild } from '@angular/core';
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
import { DraftJsonDialog } from '../editor/draft-json-dialog';
import { FormDraft, FormIssue, FormsApi, issuesOf } from '../forms-api';
import { NAME_LIMIT, invalidNameText } from '../process-name';
import { moveInToolbar } from '../toolbar';
import { FormDocument } from '../../../forms/model';
import { AddComponentDialog } from './add-component-dialog';
import { FillPreviewData, FillPreviewDialog } from './fill-preview-dialog';
import { checkForm } from './form-checks';
import { FormDraftEditor, nameOf } from './form-draft-editor';
import { DesignerDocument, PaletteType, Place, locate, stepDown, stepUp } from './form-edits';
import { formProblemText } from './form-messages';
import { FormPalettePanel } from './form-palette-panel';
import { FormPropertiesPanel, PropertiesData } from './form-properties-panel';
import { TYPE_NAME } from './form-palette';
import { FormTree } from './form-tree';
import { FormVersionsData, FormVersionsPanel, VersionChoice } from './form-versions-panel';
import { MoveDialog, MoveDialogData } from './move-dialog';

const DESCRIPTION_LIMIT = 500;

/** The designer's texts for codes whose app-wide text names no item, as in the workflow editor (ADR-0010 D4, card #166). */
const DESIGNER_MESSAGES: Readonly<Record<string, string>> = {
  version_mismatch: 'O formulário mudou desde que você o abriu.',
};

/** Why an action failed; a stale `ETag` (412) offers Recarregar (form-designer.md §9.1). */
interface Refusal {
  readonly message: string;
  readonly reload: boolean;
}

/**
 * The form designer (form-designer.md §5, §12.1 N3a, §12.2 N3b): the header, the toolbar with its status line, the server's
 * problems, the palette and the form column, and the footer. The draft is edited in `FormDraftEditor`, saved with the
 * `ETag`, and saved first when it is validated or published, since the server checks the saved draft (§9.1).
 */
@Component({
  selector: 'chain-form-designer-page',
  imports: [Alert, Button, DatePipe, FormField, FormPalettePanel, FormTree, Input, RouterLink],
  providers: [FormDraftEditor],
  templateUrl: './form-designer-page.html',
  styleUrls: ['../editor-frame.css', './form-designer-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FormDesignerPage implements CanLeave {
  private readonly api = inject(FormsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  private readonly tree = viewChild(FormTree);
  protected readonly editor = inject(FormDraftEditor);

  protected readonly nameLimit = NAME_LIMIT;
  protected readonly descriptionLimit = DESCRIPTION_LIMIT;
  protected readonly messageFor = messageFor;
  protected readonly moveInToolbar = moveInToolbar;
  protected readonly form = signal<FormDraft | null>(null);
  protected readonly loadError = signal<ApiProblem | null>(null);
  /** The document being edited, as it would be saved: what the local checks, the preview and the JSON read. */
  protected readonly document = this.editor.saveable;
  /** The server's problems with the draft; null until it is validated or a publish or save is refused. */
  protected readonly problems = signal<readonly FormIssue[] | null>(null);
  /** The components to outline: those the local checks or the server found a problem in. */
  protected readonly outlined = computed(
    () =>
      new Set(
        [...checkForm(this.document()), ...(this.problems() ?? [])].flatMap((problem) => (problem.path === null ? [] : [problem.path])),
      ),
  );
  protected readonly problemsLabel = computed(() => {
    const count = this.problems()?.length ?? 0;
    return count === 1 ? '1 problema' : `${count} problemas`;
  });
  protected readonly selected = computed(() => {
    const id = this.editor.selection();
    return id === null ? null : (locate(this.editor.document(), id)?.component ?? null);
  });
  protected readonly canMoveUp = computed(() => {
    const id = this.editor.selection();
    return id !== null && stepUp(this.editor.document(), id) !== null;
  });
  protected readonly canMoveDown = computed(() => {
    const id = this.editor.selection();
    return id !== null && stepDown(this.editor.document(), id) !== null;
  });
  /** The status line (§5): what the last action did or why it was refused, else what is selected. */
  protected readonly status = computed(() => {
    const selected = this.selected();
    return this.editor.notice() ?? (selected ? `Selecionado: ${nameOf(selected)} (${TYPE_NAME[selected.type].toLocaleLowerCase('pt-BR')}).` : 'Nenhum componente selecionado.');
  });
  protected readonly actionError = signal<Refusal | null>(null);
  protected readonly busy = signal<'save' | 'validate' | 'publish' | null>(null);
  protected readonly editing = signal(false);
  protected readonly savingHeader = signal(false);
  protected readonly nameDraft = signal('');
  protected readonly descriptionDraft = signal('');
  protected readonly nameError = signal<string | null>(null);
  protected readonly descriptionError = signal<string | null>(null);

  constructor() {
    this.load();
  }

  /** Reads the form and its `ETag`. The draft is loaded into the editor on opening and on Recarregar, not after a publish. */
  protected load(intoEditor = true): void {
    this.api.get(this.id).subscribe({
      next: (form) => {
        this.loadError.set(null);
        this.actionError.set(null);
        this.form.set(form);
        if (intoEditor) {
          // The server parsed the draft when it was saved (FM000), so it has the document's shape.
          this.editor.load(form.draft as FormDocument);
        }
      },
      error: (error: unknown) => {
        if (this.form() === null) {
          this.loadError.set(isApiProblem(error) ? error : null);
        } else {
          this.fail(error);
        }
      },
    });
  }

  /** Recarregar after a 412: reads the form again, after asking when there are unsaved changes. */
  protected reload(): void {
    if (!this.editor.dirty()) {
      this.load();
      return;
    }
    this.dialogs
      .confirm({
        title: 'Recarregar o formulário?',
        message: 'As alterações que você não salvou serão perdidas.',
        confirmLabel: 'Recarregar',
        cancelLabel: 'Cancelar',
        tone: 'danger',
      })
      .subscribe((confirmed) => confirmed && this.load());
  }

  /** A problem in pt-BR, shown before its code (§9.4). */
  protected problemText(problem: FormIssue): string {
    return formProblemText(problem.code, problem.message);
  }

  /** A palette entry (§7.3): the new component is selected and gets the focus. */
  protected add(type: PaletteType): void {
    const id = this.editor.add(type);
    if (id !== null) {
      this.tree()?.focus(id);
    }
  }

  /** Adicionar componente (§5): the palette in a dialog, on narrow screens. */
  protected addFromMenu(): void {
    this.dialogs
      .open<PaletteType>(AddComponentDialog)
      .closed.subscribe((type) => type && this.add(type));
  }

  /** Propriedades (§8), in the side panel, as the workflow editor's node panel opens. Changes apply as they are made. */
  protected openProperties(id: string): void {
    this.editor.select(id);
    this.dialogs.open<void, PropertiesData>(FormPropertiesPanel, {
      data: { editor: this.editor, id, published: this.form()?.latestVersion != null },
      size: 'side',
    });
  }

  protected removeSelection(): void {
    this.editor.remove();
    const next = this.editor.selection();
    if (next !== null) {
      this.tree()?.focus(next);
    }
  }

  /** Mover para… (§7.2). */
  protected moveTo(): void {
    const id = this.editor.selection();
    if (id === null) {
      return;
    }
    this.dialogs
      .open<Place, MoveDialogData>(MoveDialog, { data: { document: this.editor.document(), id } })
      .closed.subscribe((place) => {
        if (place) {
          this.editor.moveTo(place);
          this.tree()?.focus(id);
        }
      });
  }

  protected discard(): void {
    this.dialogs
      .confirm({
        title: 'Descartar as alterações?',
        message: 'O formulário volta a ser o rascunho salvo.',
        confirmLabel: 'Descartar',
        cancelLabel: 'Continuar editando',
        tone: 'danger',
      })
      .subscribe((confirmed) => confirmed && this.editor.discard());
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
      const form = this.form()!;
      this.api.publish(form.id, form.etag).subscribe({
        next: ({ versionNumber, created }) => {
          this.busy.set(null);
          this.problems.set(null);
          this.toasts.show({
            tone: 'success',
            message: created ? `Versão ${versionNumber} publicada.` : `Nada mudou desde a versão ${versionNumber}.`,
          });
          this.load(false); // the latest version and the ETag changed; the editor keeps its document
        },
        error: (error: unknown) => {
          if (isApiProblem(error) && error.code === 'form_validation_failed') {
            this.busy.set(null);
            this.problems.set(issuesOf(error));
          } else {
            this.fail(error);
          }
        },
      });
    });
  }

  /** Selects a problem's component and moves the focus to it, which scrolls it into view (§9.3). */
  protected show(path: string): void {
    const id = this.idAt(path);
    if (id !== null) {
      this.editor.select(id);
      this.tree()?.focus(id);
    }
  }

  protected preview(): void {
    const document = this.document();
    this.dialogs.open<void, FillPreviewData>(FillPreviewDialog, {
      data: { name: this.form()!.name, document, problems: checkForm(document) },
      size: 'lg',
    });
  }

  /** Versões (§9.7): view, test or restore a published version. */
  protected showVersions(): void {
    this.dialogs
      .open<VersionChoice, FormVersionsData>(FormVersionsPanel, { data: { formId: this.id }, size: 'side' })
      .closed.subscribe((choice) => choice && this.restore(choice.restore));
  }

  /** Copies a version into the draft after asking, and says when unsaved changes would be lost; nothing is published (FD12). */
  private restore(versionNumber: number): void {
    const dirty = this.editor.dirty();
    this.dialogs
      .confirm({
        title: `Restaurar a versão ${versionNumber}?`,
        message: `O rascunho passa a ser uma cópia da versão ${versionNumber}. Nada é publicado.${dirty ? ' As alterações não salvas serão perdidas.' : ''}`,
        confirmLabel: 'Restaurar',
        cancelLabel: 'Cancelar',
        tone: dirty ? 'danger' : 'primary',
      })
      .subscribe((confirmed) => {
        if (!confirmed) {
          return;
        }
        this.actionError.set(null);
        this.api.restore(this.id, versionNumber, this.form()!.etag).subscribe({
          next: (restored) => {
            this.form.set(restored);
            this.editor.load(restored.draft as FormDocument);
            this.problems.set(null);
            this.toasts.show({ tone: 'success', message: `Versão ${versionNumber} restaurada no rascunho.` });
          },
          error: (error: unknown) => this.fail(error),
        });
      });
  }

  protected showJson(): void {
    this.dialogs.open(DraftJsonDialog, { data: JSON.stringify(this.document(), null, 2), size: 'lg' });
  }

  protected downloadJson(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.document(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.form()!.name}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected edit(): void {
    const form = this.form()!;
    this.nameDraft.set(form.name);
    this.descriptionDraft.set(form.description ?? '');
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

    const form = this.form()!;
    this.savingHeader.set(true);
    this.actionError.set(null);
    this.api.rename(form.id, form.etag, name, this.descriptionDraft()).subscribe({
      next: (renamed) => {
        this.savingHeader.set(false);
        this.form.set(renamed);
        this.editing.set(false);
        this.toasts.show({ tone: 'success', message: 'Formulário atualizado.' });
      },
      error: (error: unknown) => {
        this.savingHeader.set(false);
        const problem = isApiProblem(error) ? error : null;
        const codes = problem ? errorCodes(problem) : [];
        if (problem?.code === 'form_name_taken') {
          this.nameError.set(messageFor(problem.code));
        } else if (codes.includes('invalid_name')) {
          this.nameError.set(invalidNameText(name));
        } else if (codes.includes('description_too_long')) {
          this.descriptionError.set(`A descrição pode ter no máximo ${DESCRIPTION_LIMIT} caracteres.`);
        } else if (codes.includes('invalid_description')) {
          this.descriptionError.set(messageFor('invalid_description'));
        } else {
          this.fail(error);
        }
      },
    });
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** Leaving with unsaved changes asks first (§9.1). */
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

  /** Closing or reloading the page with unsaved changes asks first, in the browser's own words (§9.1). */
  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent): void {
    if (this.editor.dirty()) {
      event.preventDefault();
    }
  }

  /** Saves unsaved changes, then runs the action; with nothing to save, runs it at once. */
  private saveThen(action: 'save' | 'validate' | 'publish', then: () => void): void {
    this.busy.set(action);
    this.actionError.set(null);
    if (!this.editor.dirty()) {
      then();
      return;
    }
    const sent: DesignerDocument = this.editor.document();
    this.api.saveDraft(this.id, this.form()!.etag, this.document()).subscribe({
      next: (saved) => {
        this.form.set(saved);
        this.editor.markSaved(sent);
        then();
      },
      error: (error: unknown) => {
        if (isApiProblem(error) && error.code === 'invalid_document') {
          this.busy.set(null);
          this.problems.set(issuesOf(error));
        } else {
          this.fail(error);
        }
      },
    });
  }

  private fail(error: unknown): void {
    this.busy.set(null);
    const code = isApiProblem(error) ? error.code : 'unexpected';
    this.actionError.set({ message: messageFor(code, DESIGNER_MESSAGES), reload: code === 'version_mismatch' });
  }

  /** The component a problem's path names (forms.md F1), as the tree draws paths. */
  private idAt(path: string): string | null {
    const cards = document.querySelectorAll<HTMLElement>('chain-form-tree [role="treeitem"]');
    return Array.from(cards).find((card) => card.dataset['path'] === path)?.dataset['id'] ?? null;
  }
}
