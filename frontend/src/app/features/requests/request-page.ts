import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { ApiProblem, errorCodes, isApiProblem } from '../../core/http/api-problem';
import { CommandKey, offersRetry } from '../../core/http/command-key';
import { EngineApi, InstanceView } from '../../core/http/engine-api';
import { WorkflowCanvas } from '../../diagram/workflow-canvas';
import { WorkflowDocument, readDocument } from '../../diagram/workflow-document';
import { messageFor } from '../../core/http/messages';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { DialogService } from '../../ui/dialog/dialog.service';
import { ToastService } from '../../ui/toast/toast.service';
import { CloseRequestDialog } from './close-request-dialog';
import { incidentText } from './incident-messages';
import { RequestComment } from './request-comment';
import { STATUS_LABEL } from './status';
import { DataNode, LinkedFile, describeEvent, describeValue } from './timeline';

/** One request: its status, open tasks, data, timeline, incidents and children, and closing it (requests-ui.md §6). */
@Component({
  selector: 'chain-request-page',
  imports: [Alert, Button, DatePipe, NgTemplateOutlet, RequestComment, RouterLink, WorkflowCanvas],
  templateUrl: './request-page.html',
  styleUrl: './request-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestPage {
  /** The route's `:id`. */
  readonly id = input.required<string>();

  private readonly api = inject(EngineApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly title = inject(Title);
  /** The close's key; each request starts with a new one (requests-ui.md §6). */
  private key = new CommandKey();
  /** Emits when the router keeps this page for another request, which stops the old one's loads and close (§6). */
  private readonly switched = new Subject<void>();

  protected readonly view = signal<InstanceView | null>(null);
  protected readonly loadError = signal<ApiProblem | null>(null);
  protected readonly commandError = signal<string | null>(null);
  /** Sends the failed request again, when its answer was lost (requests-ui.md §1.5, "Tentar novamente"). */
  protected readonly retry = signal<(() => void) | null>(null);
  protected readonly busy = signal(false);
  protected readonly statusLabel = STATUS_LABEL;
  /** Fluxo (workflow-editor.md §10.11): the diagram, read the first time it is shown. */
  protected readonly flowShown = signal(false);
  protected readonly diagram = signal<{ readonly document: WorkflowDocument; readonly current: string } | null>(null);
  protected readonly diagramFailed = signal(false);

  protected readonly timeline = computed(() => {
    const view = this.view();
    const events = view?.timeline ?? [];
    return events.map((event) => ({ event, sentence: describeEvent(event, events, view?.participants ?? []) }));
  });
  /** The data, then each sensitive key this reader may not see, shown as hidden (sensitive-data.md §5, card #53). */
  protected readonly data = computed<DataNode>(() => {
    const node = describeValue(this.view()?.data ?? {});
    const hidden = (this.view()?.maskedKeys ?? []).map((key) => [key, { hidden: true }] as const);
    return 'entries' in node ? { entries: [...node.entries, ...hidden] } : node;
  });
  protected readonly hasData = computed(() => Object.keys(this.view()?.data ?? {}).length + (this.view()?.maskedKeys?.length ?? 0) > 0);
  /** The open incidents, each with its pt-BR text, or null for a code without one (§6, Incidentes). */
  protected readonly openIncidents = computed(() =>
    (this.view()?.incidents ?? []).filter((incident) => !incident.resolvedAt).map((incident) => ({ incident, text: incidentText(incident.code) })),
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
  }

  protected load(id: string = this.id()): void {
    this.loadError.set(null);
    this.api.instance(id).pipe(takeUntil(this.switched)).subscribe({
      next: (view) => this.show(view),
      error: (error: unknown) => this.loadError.set(isApiProblem(error) ? error : unexpected()),
    });
  }

  protected toggleFlow(): void {
    const shown = !this.flowShown();
    this.flowShown.set(shown);
    if (shown && this.diagram() === null) {
      this.readDiagram();
    }
  }

  private readDiagram(): void {
    this.diagramFailed.set(false);
    this.api.diagram(this.id()).pipe(takeUntil(this.switched)).subscribe({
      next: (diagram) => this.diagram.set({ document: readDocument(diagram.document), current: diagram.currentNodeId }),
      error: () => this.diagramFailed.set(true),
    });
  }

  protected close(): void {
    const id = this.id(); // the close, and its retry, stay with the request it was asked on (requests-ui.md §6)
    this.dialogs
      .open<string>(CloseRequestDialog, { size: 'sm' })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((justification) => {
        if (justification) {
          this.sendClose(id, justification);
        }
      });
  }

  protected loadMessage(problem: ApiProblem): string {
    return messageFor(problem.code);
  }

  protected tryAgain(): void {
    this.retry()?.();
  }

  protected isText(node: DataNode): node is { readonly text: string } {
    return 'text' in node;
  }

  protected isHidden(node: DataNode): node is { readonly hidden: true } {
    return 'hidden' in node;
  }

  protected isFiles(node: DataNode): node is { readonly files: readonly LinkedFile[] } {
    return 'files' in node;
  }

  protected isEntries(node: DataNode): node is { readonly entries: readonly (readonly [string, DataNode])[] } {
    return 'entries' in node;
  }

  protected itemsOf(node: DataNode): readonly DataNode[] {
    return 'items' in node ? node.items : [];
  }

  /** A comment was recorded: the answer has the new timeline (§6, "Commenting"). */
  protected onCommented(view: InstanceView): void {
    this.show(view);
  }

  /** The request changed under the comment: show why, when the comment section may go away, and load it again. */
  protected onStale(message: string | null): void {
    if (message) {
      this.commandError.set(message);
    }
    this.load();
  }

  /**
   * Shows a request as if the page had just opened. The router keeps this page from one request to another, so nothing of
   * the old request stays: its messages, retry, close key and diagram, and its loads and close still running (§6).
   */
  private open(id: string): void {
    this.switched.next();
    this.key = new CommandKey();
    this.view.set(null);
    this.commandError.set(null);
    this.retry.set(null);
    this.busy.set(false);
    this.flowShown.set(false);
    this.diagram.set(null);
    this.diagramFailed.set(false);
    this.load(id);
  }

  private sendClose(id: string, justification: string): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.commandError.set(null);
    this.retry.set(null);
    this.api.close(id, justification, this.key.next()).pipe(takeUntil(this.switched)).subscribe({
      next: (view) => {
        this.key.settle();
        this.busy.set(false);
        this.show(view);
        this.toasts.show({ tone: 'success', message: 'Solicitação encerrada.' });
      },
      error: (error: unknown) => {
        const problem = isApiProblem(error) ? error : unexpected();
        this.key.settle(problem);
        this.busy.set(false);
        if (offersRetry(problem)) {
          this.commandError.set(messageFor('network_error'));
          this.retry.set(() => this.sendClose(id, justification)); // the same request: same request id, justification and key
        } else if (problem.code === 'forbidden') {
          this.commandError.set('Você não pode encerrar esta solicitação.');
        } else if (problem.code === 'validation_failed') {
          this.commandError.set(messageFor(errorCodes(problem)[0] ?? problem.code));
        } else if (problem.code === 'idempotency_key_reused') {
          // Another justification met the key kept after a lost answer (requests-ui.md §6).
          this.commandError.set('A tentativa anterior pode já ter encerrado a solicitação, com a justificativa de antes. Carregue a página de novo para conferir.');
        } else {
          this.commandError.set(messageFor(problem.code));
          if (problem.code === 'instance_not_running') {
            this.load();
          }
        }
      },
    });
  }

  private show(view: InstanceView): void {
    this.view.set(view);
    this.title.setTitle(`${view.definitionName} · Chain`);
  }
}

function unexpected(): ApiProblem {
  return { kind: 'api-problem', status: -1, code: 'unexpected', title: null, errors: [] };
}
