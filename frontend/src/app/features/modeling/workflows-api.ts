import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiProblem } from '../../core/http/api-problem';
import { ContractField } from './automations-api';
import { CatalogEntry } from './editor/conditions';
import { StepContract } from './editor/mappings';
import { DraftProblem, ProcessDraft, ProcessSummary, WorkflowDocument, readDocument } from './workflow-document';

/** A capability a group can hold on a process (workflow-definition.md §5.4; sensitive-data.md §3). */
export type Capability = 'start' | 'view' | 'close' | 'comment' | 'viewSensitive';

/** A group's capabilities on a process, as the server lists them. */
export interface ProcessGrant {
  readonly groupId: string;
  readonly groupName: string;
  readonly capabilities: readonly Capability[];
}

/** A group's capabilities, as **Aplicar** sends them. */
export interface GrantInput {
  readonly groupId: string;
  readonly capabilities: readonly Capability[];
}

interface DefinitionBody extends ProcessSummary {
  readonly draft: unknown;
}

/** The workflow modeling endpoints (workflow-definition.md §5.5), for admins and Modelers. */
@Injectable({ providedIn: 'root' })
export class WorkflowsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<readonly ProcessSummary[]> {
    return this.http.get<ProcessSummary[]>('/api/workflows');
  }

  /** Creates a process and answers its id. */
  create(name: string, description: string): Observable<string> {
    return this.http
      .post<{ id: string }>('/api/workflows', { name, description: description.trim() || null })
      .pipe(map((created) => created.id));
  }

  get(id: string): Observable<ProcessDraft> {
    return this.http.get<DefinitionBody>(`/api/workflows/${id}`, { observe: 'response' }).pipe(map(toDraft));
  }

  rename(id: string, etag: string, name: string, description: string): Observable<ProcessDraft> {
    return this.http
      .patch<DefinitionBody>(
        `/api/workflows/${id}`,
        { name, description: description.trim() || null },
        { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) },
      )
      .pipe(map(toDraft));
  }

  /** The groups a lane can be given: the active ones, by name (workflow-definition.md §5.5). */
  groups(): Observable<readonly { readonly id: string; readonly name: string }[]> {
    return this.http.get<{ id: string; name: string }[]>('/api/workflows/groups');
  }

  /** Who may start, view, close, comment on and see the sensitive data of the process's requests (workflow-definition.md §5.4). */
  grants(id: string): Observable<readonly ProcessGrant[]> {
    return this.http.get<ProcessGrant[]>(`/api/workflows/${id}/grants`);
  }

  /** Replaces every grant with `If-Match`. The change touches the process, so the answer carries its new `ETag` (admin-ui.md §8, S-A2). */
  replaceGrants(id: string, etag: string, grants: readonly GrantInput[]): Observable<{ readonly grants: readonly ProcessGrant[]; readonly etag: string }> {
    return this.http
      .put<ProcessGrant[]>(`/api/workflows/${id}/grants`, grants, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map((response) => ({ grants: response.body ?? [], etag: response.headers.get('ETag') ?? '' })));
  }

  /**
   * The data a node of the **saved** draft can read (workflow-definition.md §6.5), for the condition builder; null when
   * the saved draft has no such node yet.
   */
  catalog(id: string, nodeId: string): Observable<readonly CatalogEntry[] | null> {
    return this.http
      .get<{ nodes: { nodeId: string; entries: CatalogEntry[] }[] }>(`/api/workflows/${id}/data-catalog`)
      .pipe(map((catalog) => catalog.nodes.find((node) => node.nodeId === nodeId)?.entries ?? null));
  }

  /**
   * A version's contract as a sub-workflow (workflow-definition.md §6.5), for the *Subprocesso* panel (workflow-editor.md
   * §10.10): its start form's fields, or null when it takes any keys, and its top-level data at completion; deeper data
   * travel inside their top-level key.
   */
  contract(id: string, versionNumber: number): Observable<StepContract> {
    return this.http
      .get<{ versionNumber: number; inputs: ContractField[] | null; outputs: CatalogEntry[] }>(`/api/workflows/${id}/versions/${versionNumber}/contract`)
      .pipe(
        map((contract) => ({
          version: contract.versionNumber,
          inputs: contract.inputs?.map(({ key, type, required }) => ({ key, type, required })) ?? null,
          outputs: contract.outputs
            .filter((entry) => entry.path.length === 1)
            .map((entry) => ({ key: entry.path[0], type: entry.type, required: entry.presence === 'definite' })),
        })),
      );
  }

  /** The published versions, newest first (workflow-editor.md §10.11). */
  versions(id: string): Observable<readonly { readonly versionNumber: number; readonly publishedAt: string }[]> {
    return this.http
      .get<{ versionNumber: number; publishedAt: string }[]>(`/api/workflows/${id}/versions`)
      .pipe(map((versions) => versions.map(({ versionNumber, publishedAt }) => ({ versionNumber, publishedAt })).sort((a, b) => b.versionNumber - a.versionNumber)));
  }

  /** A published version's document. */
  version(id: string, versionNumber: number): Observable<WorkflowDocument> {
    return this.http.get<{ document: unknown }>(`/api/workflows/${id}/versions/${versionNumber}`).pipe(map((version) => readDocument(version.document)));
  }

  /** Copies a version into the draft (ADR-0004 §6), checked against the draft's `ETag`: the restored draft, with its new one. */
  restore(id: string, versionNumber: number, etag: string): Observable<ProcessDraft> {
    return this.http
      .post<DefinitionBody>(`/api/workflows/${id}/versions/${versionNumber}/restore`, null, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** Stores the draft; drafts are not validated, so work in progress can be saved. A document the server cannot read is
   * refused with its problems (`invalid_document`, read with `problemsOf`). */
  saveDraft(id: string, etag: string, document: WorkflowDocument): Observable<ProcessDraft> {
    return this.http
      .put<DefinitionBody>(`/api/workflows/${id}/draft`, { document }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** The problems publishing would find in the draft; empty when it can be published. */
  validate(id: string): Observable<readonly DraftProblem[]> {
    return this.http
      .post<{ valid: boolean; errors: DraftProblem[] }>(`/api/workflows/${id}/validate`, null)
      .pipe(map((report) => report.errors.map(toProblem)));
  }

  /** Publishes the draft: a new version, or the latest one when nothing changed. A refusal carries its problems (`problemsOf`). */
  publish(id: string, etag: string): Observable<{ readonly versionNumber: number; readonly created: boolean }> {
    return this.http
      .post<{ versionNumber: number; created: boolean }>(`/api/workflows/${id}/publish`, null, {
        headers: new HttpHeaders({ 'If-Match': etag }),
      })
      .pipe(map(({ versionNumber, created }) => ({ versionNumber, created })));
  }
}

/** The problems of a refused publish (`publish_validation_failed`, 422) or draft (`invalid_document`, 400), as the server listed them. */
export function problemsOf(problem: ApiProblem): DraftProblem[] {
  return problem.errors
    .filter((error): error is DraftProblem => typeof error === 'object' && error !== null && typeof (error as DraftProblem).code === 'string')
    .map(toProblem);
}

function toProblem(problem: DraftProblem): DraftProblem {
  return { code: problem.code, message: problem.message, elementId: problem.elementId ?? null };
}

function toDraft(response: HttpResponse<DefinitionBody>): ProcessDraft {
  const body = response.body!;
  return {
    id: body.id,
    name: body.name,
    description: body.description,
    isActive: body.isActive,
    latestVersion: body.latestVersion,
    draftUpdatedAt: body.draftUpdatedAt,
    draft: readDocument(body.draft),
    etag: response.headers.get('ETag') ?? '',
  };
}
