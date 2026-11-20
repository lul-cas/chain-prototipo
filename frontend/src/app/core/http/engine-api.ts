import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { FormDocument } from '../../forms/model';

// The engine's views as the API returns them (workflow-engine.md §9 and §13; hand-written, ADR-0010 Q7).

export interface ActorRef {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface GroupInfo {
  readonly id: string;
  readonly name: string;
}

export interface TaskView {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId: string;
  readonly label: string;
  readonly kind: 'task' | 'decision';
  /** The question of a decision. */
  readonly question: string | null;
  /** Null in the requester's lane. */
  readonly group: GroupInfo | null;
  readonly assignee: ActorRef | null;
  readonly createdAt: string;
}

export interface TaskDetail {
  readonly task: TaskView;
  readonly form: { readonly formId: string; readonly version: number; readonly document: FormDocument } | null;
  readonly prefill: Readonly<Record<string, unknown>>;
  /** Sensitive keys left out of `prefill` for this reader (sensitive-data.md §5, card #53). */
  readonly maskedKeys?: readonly string[];
}

export type InstanceStatus = 'running' | 'completed' | 'cancelled' | 'faulted';

/** A timeline event (workflow-engine.md §8): the actor is null for the engine's own steps. */
export interface EventView {
  readonly type: string;
  readonly occurredAt: string;
  readonly actor: ActorRef | null;
  readonly actedAsGroup: GroupInfo | null;
  readonly taskId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  /** The way in of the request that recorded it; null without a caller, or for older events (workflow-engine.md §8). */
  readonly channel?: 'ui' | 'api' | 'mcp' | null;
}

export interface IncidentView {
  readonly id: string;
  readonly nodeId: string;
  readonly code: string;
  /** Null for a reader who may not see the request's sensitive values, since it can quote one (sensitive-data.md §5). */
  readonly message: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export interface ChildView {
  readonly id: string;
  readonly nodeId: string;
  readonly definitionName: string;
  readonly status: InstanceStatus;
}

export interface InstanceView {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionName: string;
  readonly versionNumber: number;
  readonly status: InstanceStatus;
  readonly requester: ActorRef;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly openTasks: readonly TaskView[];
  readonly participants?: readonly ActorRef[];
  readonly timeline?: readonly EventView[];
  readonly data: Readonly<Record<string, unknown>>;
  /** Sensitive keys left out of `data` for this reader (sensitive-data.md §5, card #53). */
  readonly maskedKeys?: readonly string[];
  readonly incidents?: readonly IncidentView[];
  readonly parent?: { readonly id: string; readonly nodeId: string } | null;
  readonly children?: readonly ChildView[];
}

/** A line of the requests list. */
export interface InstanceSummary {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionName: string;
  readonly versionNumber: number;
  readonly status: InstanceStatus;
  readonly requester: ActorRef;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** A workflow the user may start (FR-060). */
export interface StartableWorkflow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number;
}

/** The start form of a workflow's latest version, or `form: null` when it takes no start data (workflow-engine.md §13.1). */
export interface StartFormView {
  readonly workflowId: string;
  readonly versionNumber: number;
  readonly form: { readonly formId: string; readonly version: number; readonly document: FormDocument } | null;
}

/** An inbox card: the task, plus the request it belongs to. */
export interface InboxItem extends TaskView {
  readonly definitionName: string;
  readonly requester: ActorRef;
}

export interface InboxView {
  readonly assignedToMe: readonly InboxItem[];
  readonly unassigned: readonly InboxItem[];
  readonly assignedToOthers: readonly InboxItem[];
}

/** The engine's commands and queries (workflow-engine.md §9). Every command carries the caller's `Idempotency-Key`. */
/** A request's diagram (workflow-engine.md §9): its pinned version, drawing only, and the step it is at. */
export interface InstanceDiagramView {
  readonly definitionId: string;
  readonly versionNumber: number;
  readonly currentNodeId: string;
  readonly document: unknown;
}

@Injectable({ providedIn: 'root' })
export class EngineApi {
  private readonly http = inject(HttpClient);

  startable(): Observable<readonly StartableWorkflow[]> {
    return this.http.get<readonly StartableWorkflow[]>('/api/startable-workflows');
  }

  startForm(workflowId: string): Observable<StartFormView> {
    return this.http.get<StartFormView>(`/api/startable-workflows/${encodeURIComponent(workflowId)}/start-form`);
  }

  /** Starts a request. `dataJson` is the form renderer's JSON, sent as it is (forms.md F3); null without a start form. */
  start(definitionId: string, dataJson: string | null, key: string): Observable<InstanceView> {
    const body = `{"definitionId":${JSON.stringify(definitionId)},"data":${dataJson ?? 'null'}}`;
    return this.http.post<InstanceView>('/api/instances', body, { headers: idempotent(key).set('Content-Type', 'application/json') });
  }

  inbox(): Observable<InboxView> {
    return this.http.get<InboxView>('/api/tasks');
  }

  task(id: string): Observable<TaskDetail> {
    return this.http.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
  }

  /** The user's requests (`mine`) or every request they can see (`visible`), optionally in one status. */
  requests(scope: 'mine' | 'visible', status: InstanceStatus | null): Observable<readonly InstanceSummary[]> {
    const params: Record<string, string> = { scope };
    if (status) {
      params['status'] = status;
    }
    return this.http.get<readonly InstanceSummary[]>('/api/instances', { params });
  }

  diagram(id: string): Observable<InstanceDiagramView> {
    return this.http.get<InstanceDiagramView>(`/api/instances/${id}/diagram`);
  }

  instance(id: string): Observable<InstanceView> {
    return this.http.get<InstanceView>(`/api/instances/${encodeURIComponent(id)}`);
  }

  startWorking(taskId: string, key: string): Observable<TaskView> {
    return this.http.post<TaskView>(`/api/tasks/${encodeURIComponent(taskId)}/start`, {}, { headers: idempotent(key) });
  }

  takeOver(taskId: string, key: string): Observable<TaskView> {
    return this.http.post<TaskView>(`/api/tasks/${encodeURIComponent(taskId)}/take-over`, {}, { headers: idempotent(key) });
  }

  /**
   * Completes a task. `dataJson` is the form renderer's JSON, sent as it is so numbers keep every digit (forms.md F3); null when
   * the step has no form.
   */
  complete(taskId: string, comment: string | null, dataJson: string | null, key: string): Observable<InstanceView> {
    const body = `{"comment":${JSON.stringify(comment)},"data":${dataJson ?? 'null'}}`;
    return this.http.post<InstanceView>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, body, {
      headers: idempotent(key).set('Content-Type', 'application/json'),
    });
  }

  /** Comments on a request, with files already uploaded (workflow-engine.md §17; requests-ui.md §6, "Commenting"). */
  comment(instanceId: string, text: string | null, fileIds: readonly string[], key: string): Observable<InstanceView> {
    return this.http.post<InstanceView>(`/api/instances/${encodeURIComponent(instanceId)}/comments`, { text, fileIds }, { headers: idempotent(key) });
  }

  /** Closes a request early (FR-034): the requester or a holder of `close`, with a justification. */
  close(instanceId: string, justification: string, key: string): Observable<InstanceView> {
    return this.http.post<InstanceView>(`/api/instances/${encodeURIComponent(instanceId)}/close`, { justification }, { headers: idempotent(key) });
  }

  decide(taskId: string, outcome: boolean, justification: string | null, key: string): Observable<InstanceView> {
    return this.http.post<InstanceView>(`/api/tasks/${encodeURIComponent(taskId)}/decide`, { outcome, justification }, { headers: idempotent(key) });
  }
}

function idempotent(key: string): HttpHeaders {
  return new HttpHeaders({ 'Idempotency-Key': key });
}
