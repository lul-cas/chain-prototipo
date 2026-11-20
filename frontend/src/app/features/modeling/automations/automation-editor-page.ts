import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { ToastService } from '../../../ui/toast/toast.service';
import { AutomationDraft, AutomationIssue, AutomationResources, AutomationsApi, issuesOf } from '../automations-api';
import { CanLeave } from '../can-leave';
import { DraftJsonDialog } from '../editor/draft-json-dialog';
import { NAME_LIMIT, invalidNameText } from '../process-name';
import { moveInToolbar } from '../toolbar';
import { readDocument } from './automation-document';
import { AutomationDraftEditor } from './automation-draft-editor';
import { EditorDraft, documentOf, repeatedName } from './automation-edits';
import { automationProblemText } from './automation-messages';
import { AutomationSections } from './automation-sections';
import { AutomationVersionsData, AutomationVersionsPanel, VersionChoice } from './automation-versions-panel';
import { controlFor, controlsOf } from './control-paths';

const DESCRIPTION_LIMIT = 500;

/** The editor's texts for codes whose app-wide text names no item (ADR-0010 D4, card #166). */
const EDITOR_MESSAGES: Readonly<Record<string, string>> = {
  version_mismatch: 'A automação mudou desde que você a abriu.',
};
/** After a retry whose answer could mean that the first attempt was applied (§8.1). */
const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';

/** Why an action failed: a stale `ETag` (412) offers Recarregar, an unknown outcome Tentar de novo (§8.1). */
interface Refusal {
  readonly message: string;
  readonly reload: boolean;
  /** Sends the same request again, with the same `If-Match`. */
  readonly retry?: () => void;
}

/**
 * The automation editor (automation-ui.md §7.1, §12.3 AS3, §12.4 AS4a): the header, the toolbar with its status line, the
 * server's problems at their controls (§8.2), the five sections, the call preview, and the footer. The draft is edited in
 * `AutomationDraftEditor`, saved with the `ETag`, and saved first when it is validated or published, since the server checks
 * the saved draft (§8.1).
 */
@Component({
  selector: 'chain-automation-editor-page',
  imports: [Alert, AutomationSections, Button, DatePipe, FormField, Input, RouterLink],
  templateUrl: './automation-editor-page.html',
  styleUrls: ['../editor-frame.css'],
  providers: [AutomationDraftEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationEditorPage implements CanLeave {
  private readonly api = inject(AutomationsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  protected readonly editor = inject(AutomationDraftEditor);

  protected readonly nameLimit = NAME_LIMIT;
  protected readonly descriptionLimit = DESCRIPTION_LIMIT;
  protected readonly messageFor = messageFor;
  protected readonly moveInToolbar = moveInToolbar;
  protected readonly automation = signal<AutomationDraft | null>(null);
  protected readonly resources = signal<AutomationResources | null>(null);
  protected readonly loadError = signal<ApiProblem | null>(null);
  /** The draft being edited, as the sections draw it. */
  protected readonly document = computed(() => readDocument(documentOf(this.editor.draft())));
  /** The input keys of the latest published version, for the rename warning (§7.2); null when none was published. */
  protected readonly published = signal<ReadonlySet<string> | null>(null);
  /** The server's problems; null until it validates or refuses a save or a publish. */
  protected readonly problems = signal<readonly AutomationIssue[] | null>(null);
  protected readonly problemsLabel = computed(() => {
    const count = this.problems()?.length ?? 0;
    return count === 1 ? '1 problema' : `${count} problemas`;
  });
  protected readonly actionError = signal<Refusal | null>(null);
  /** What the page says after a reload it made itself (§8.1). */
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal<'save' | 'validate' | 'publish' | null>(null);
  protected readonly editing = signal(false);
  protected readonly savingHeader = signal(false);
  protected readonly nameDraft = signal('');
  protected readonly descriptionDraft = signal('');
  protected readonly nameError = signal<string | null>(null);
  protected readonly descriptionError = signal<string | null>(null);
  private publishedVersion: number | null = null;

  constructor() {
    this.load();
    this.api.resources().subscribe({ next: (resources) => this.resources.set(resources), error: () => this.resources.set(null) });
  }

  /** Reads the automation and its `ETag`. The draft goes into the editor on opening and on Recarregar, not after a publish. */
  protected load(intoEditor = true, notice: string | null = null): void {
    this.api.get(this.id).subscribe({
      next: (automation) => {
        this.loadError.set(null);
        this.actionError.set(null);
        this.notice.set(notice);
        this.automation.set(automation);
        if (intoEditor) {
          this.editor.load(automation.draft);
        }
        this.loadPublished(automation.latestVersion);
      },
      error: (error: unknown) => {
        if (this.automation() === null) {
          this.loadError.set(isApiProblem(error) ? error : null);
        } else {
          this.fail(error);
        }
      },
    });
  }

  /** Recarregar: reads the automation again, after asking when it would drop unsaved changes. */
  protected reload(notice: string | null = null, ask = this.editor.dirty()): void {
    if (!ask) {
      this.load(true, notice);
      return;
    }
    this.dialogs
      .confirm({
        title: 'Recarregar a automação?',
        message: 'As alterações que você não salvou serão perdidas.',
        confirmLabel: 'Recarregar',
        cancelLabel: 'Cancelar',
        tone: 'danger',
      })
      .subscribe((confirmed) => confirmed && this.load(true, notice));
  }

  protected problemText(problem: AutomationIssue): string {
    return automationProblemText(problem.code, problem.message);
  }

  /** The control a problem names, or null when it names none (AU000) (§8.2). */
  protected controlOf(problem: AutomationIssue): string | null {
    return controlFor(problem.path, controlsOf(this.document()));
  }

  /** Moves the focus to a problem's control, which scrolls it into view (§8.2). */
  protected show(problem: AutomationIssue): void {
    const control = this.controlOf(problem);
    const element = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-control]')).find((candidate) => candidate.dataset['control'] === control);
    element?.focus();
  }

  protected discard(): void {
    this.dialogs
      .confirm({
        title: 'Descartar as alterações?',
        message: 'A automação volta a ser o rascunho salvo.',
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
    this.saveThen('publish', () => this.sendPublish(this.automation()!.etag, false));
  }

  /** Versões (§8.4): the panel; a version chosen to restore is restored after asking. */
  protected showVersions(): void {
    this.dialogs
      .open<VersionChoice, AutomationVersionsData>(AutomationVersionsPanel, { data: { automationId: this.id, resources: this.resources() }, size: 'side' })
      .closed.subscribe((choice) => choice && this.restore(choice.restore));
  }

  protected showJson(): void {
    this.dialogs.open(DraftJsonDialog, { data: JSON.stringify(documentOf(this.editor.draft()), null, 2), size: 'lg' });
  }

  protected downloadJson(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(documentOf(this.editor.draft()), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.automation()!.name}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected edit(): void {
    const automation = this.automation()!;
    this.nameDraft.set(automation.name);
    this.descriptionDraft.set(automation.description ?? '');
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
    this.sendHeader(this.automation()!.etag, name, this.descriptionDraft(), false);
  }

  protected typed(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** Leaving with unsaved changes asks first (§8.1). */
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

  /** Closing or reloading the page with unsaved changes asks first, in the browser's own words (§8.1). */
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
    this.notice.set(null);
    if (!this.editor.dirty()) {
      then();
      return;
    }
    const repeated = repeatedName(this.editor.draft());
    if (repeated !== null) {
      this.busy.set(null);
      this.editor.refuse(repeated); // the JSON can't hold both rows (§7.3)
      return;
    }
    this.sendDraft(action, this.editor.draft(), this.automation()!.etag, then, false);
  }

  /** The draft as it was when sent, with the `ETag` of that moment; a retry sends both again (§8.1). */
  private sendDraft(action: 'save' | 'validate' | 'publish', sent: EditorDraft, etag: string, then: () => void, retried: boolean): void {
    this.api.saveDraft(this.id, etag, documentOf(sent)).subscribe({
      next: (saved) => {
        this.automation.set(saved);
        this.editor.markSaved(sent);
        then();
      },
      error: (error: unknown) => {
        if (isApiProblem(error) && error.code === 'invalid_document') {
          this.busy.set(null);
          this.problems.set(issuesOf(error));
          return;
        }
        this.fail(error, {
          retried,
          retry: () => this.again(action, () => this.sendDraft(action, sent, etag, then, true)),
          // The server may hold what was sent: reloading loses nothing unless there were edits after it.
          unconfirmed: () => this.reload(UNCONFIRMED, this.editor.draft() !== sent),
        });
      },
    });
  }

  private sendPublish(etag: string, retried: boolean): void {
    this.api.publish(this.id, etag).subscribe({
      next: ({ versionNumber, created }) => {
        this.busy.set(null);
        this.problems.set(null);
        this.toasts.show({ tone: 'success', message: created ? `Versão ${versionNumber} publicada.` : `Nada mudou desde a versão ${versionNumber}.` });
        this.load(false); // the latest version and the ETag changed; the editor keeps its draft
      },
      error: (error: unknown) => {
        if (isApiProblem(error) && error.code === 'automation_validation_failed') {
          this.busy.set(null);
          this.problems.set(issuesOf(error));
          return;
        }
        this.fail(error, { retried, retry: () => this.again('publish', () => this.sendPublish(etag, true)), unconfirmed: () => this.load(false, UNCONFIRMED) });
      },
    });
  }

  private sendHeader(etag: string, name: string, description: string, retried: boolean): void {
    this.savingHeader.set(true);
    this.actionError.set(null);
    this.api.rename(this.id, etag, name, description).subscribe({
      next: (renamed) => {
        this.savingHeader.set(false);
        this.automation.set(renamed);
        this.editing.set(false);
        this.toasts.show({ tone: 'success', message: 'Automação atualizada.' });
      },
      error: (error: unknown) => {
        this.savingHeader.set(false);
        const problem = isApiProblem(error) ? error : null;
        const codes = problem ? errorCodes(problem) : [];
        if (problem?.code === 'automation_name_taken') {
          this.nameError.set(messageFor(problem.code));
        } else if (codes.includes('invalid_name')) {
          this.nameError.set(invalidNameText(name));
        } else if (codes.includes('description_too_long')) {
          this.descriptionError.set(`A descrição pode ter no máximo ${DESCRIPTION_LIMIT} caracteres.`);
        } else if (codes.includes('invalid_description')) {
          this.descriptionError.set(messageFor('invalid_description'));
        } else {
          this.fail(error, {
            retried,
            retry: () => this.sendHeader(etag, name, description, true),
            unconfirmed: () => {
              this.editing.set(false);
              this.load(false, UNCONFIRMED);
            },
          });
        }
      },
    });
  }

  /** Copies a version into the draft after asking, and says when unsaved changes would be lost; nothing is published (§8.4). */
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
      .subscribe((confirmed) => confirmed && this.sendRestore(versionNumber, this.automation()!.etag, false));
  }

  private sendRestore(versionNumber: number, etag: string, retried: boolean): void {
    this.actionError.set(null);
    this.notice.set(null);
    this.api.restore(this.id, versionNumber, etag).subscribe({
      next: (restored) => {
        this.automation.set(restored);
        this.editor.load(restored.draft);
        this.problems.set(null);
        this.toasts.show({ tone: 'success', message: `Versão ${versionNumber} restaurada no rascunho.` });
      },
      error: (error: unknown) =>
        this.fail(error, { retried, retry: () => this.sendRestore(versionNumber, etag, true), unconfirmed: () => this.load(true, UNCONFIRMED) }),
    });
  }

  /** Tentar de novo: the action is busy again while the same request goes. */
  private again(action: 'save' | 'validate' | 'publish', send: () => void): void {
    this.busy.set(action);
    this.actionError.set(null);
    send();
  }

  /** Reads the input keys of the latest published version once per version, for the rename warning (§7.2). */
  private loadPublished(version: number | null): void {
    if (version === this.publishedVersion) {
      return;
    }
    this.publishedVersion = version;
    if (version === null) {
      this.published.set(null);
      return;
    }
    this.api.contract(this.id, version).subscribe({
      next: (contract) => this.published.set(new Set(contract.inputs.map((input) => input.key))),
      error: () => this.published.set(null),
    });
  }

  /**
   * Says why an action failed. An answer that leaves the outcome open offers Tentar de novo; after a retry, a 412 can mean
   * that the first attempt was applied, so the page reloads and says so (§8.1).
   */
  private fail(error: unknown, retrying?: { retried: boolean; retry: () => void; unconfirmed: () => void }): void {
    this.busy.set(null);
    const problem = isApiProblem(error) ? error : null;
    if (problem && retrying && offersRetry(problem)) {
      this.actionError.set({ message: 'Não foi possível confirmar o envio.', reload: false, retry: retrying.retry });
      return;
    }
    if (problem?.status === 412 && retrying?.retried) {
      retrying.unconfirmed();
      return;
    }
    const code = problem ? problem.code : 'unexpected';
    this.actionError.set({ message: messageFor(code, EDITOR_MESSAGES), reload: code === 'version_mismatch' });
  }
}
