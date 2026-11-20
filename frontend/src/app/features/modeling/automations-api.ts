import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiProblem } from '../../core/http/api-problem';

/** An automation a step can call (workflow-editor.md §10.9). */
export interface AutomationOption {
  readonly id: string;
  readonly name: string;
  /** Null until it is first published: a draft references it, and publishing then reports it (WF104). */
  readonly latestVersion: number | null;
}

/** A declared input or output of an automation version (automation.md §5.2): its key, its type and whether it is required. */
export interface ContractField {
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
}

/** What an automation version declares, in order: the step maps its inputs and keeps its outputs (§10.9). */
export interface AutomationContract {
  readonly version: number;
  readonly inputs: readonly ContractField[];
  readonly outputs: readonly ContractField[];
}

/** An automation in the list (automation-ui.md §6). */
export interface AutomationSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number | null;
  readonly draftUpdatedAt: string;
}

/** An automation with its draft and `ETag`, which every change sends back as `If-Match`. */
export interface AutomationDraft extends AutomationSummary {
  readonly version: number;
  readonly draft: unknown;
  readonly etag: string;
}

/** A published version in the list (automation-ui.md §8.4); the publisher is a user id, which the panel doesn't show. */
export interface AutomationVersionSummary {
  readonly versionNumber: number;
  readonly publishedAt: string;
}

/** A published version with its document, every default written out. */
export interface AutomationVersion extends AutomationVersionSummary {
  readonly document: unknown;
}

/** A problem the server found (automation.md §5.1): its code, an English message, and its path in the document. */
export interface AutomationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string | null;
}

/** What a Modeler may know of destinations and credentials (automation-ui.md §1.1): never sizes, flags or values. */
export interface AutomationResources {
  readonly destinations: readonly { readonly name: string; readonly description: string | null; readonly scheme: string; readonly host: string; readonly port: number | null; readonly pathPrefix: string | null }[];
  readonly secrets: readonly { readonly name: string; readonly description: string | null; readonly allowedDestinations: readonly string[] }[];
}

/** The automation endpoints (automation.md §5.1): for the workflow editor's step panel, and for the automation editor. */
@Injectable({ providedIn: 'root' })
export class AutomationsApi {
  private readonly http = inject(HttpClient);

  /** The automations, by name. */
  list(): Observable<readonly AutomationOption[]> {
    return this.http.get<AutomationOption[]>('/api/automations').pipe(
      map((automations) =>
        automations
          .map(({ id, name, latestVersion }) => ({ id, name, latestVersion: latestVersion ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      ),
    );
  }

  /** Every automation with its draft's facts, by name (automation-ui.md §6). */
  summaries(): Observable<readonly AutomationSummary[]> {
    return this.http
      .get<AutomationSummary[]>('/api/automations')
      .pipe(map((automations) => [...automations].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))));
  }

  /** Creates an automation with the new draft of automation.md §5.1; its id. */
  create(name: string, description: string): Observable<string> {
    return this.http.post<{ id: string }>('/api/automations', { name, description: description.trim() || null }).pipe(map((automation) => automation.id));
  }

  get(id: string): Observable<AutomationDraft> {
    return this.http.get<Omit<AutomationDraft, 'etag'>>(`/api/automations/${id}`, { observe: 'response' }).pipe(map(toDraft));
  }

  rename(id: string, etag: string, name: string, description: string): Observable<AutomationDraft> {
    return this.http
      .patch<Omit<AutomationDraft, 'etag'>>(`/api/automations/${id}`, { name, description }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** Saves the draft with `If-Match`. The server only parses it (AU000): a refusal is 400 `invalid_document`, with its problems. */
  saveDraft(id: string, etag: string, document: unknown): Observable<AutomationDraft> {
    return this.http
      .put<Omit<AutomationDraft, 'etag'>>(`/api/automations/${id}/draft`, { document }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** Every problem publishing would find; empty when it can be published. */
  validate(id: string): Observable<readonly AutomationIssue[]> {
    return this.http
      .post<{ errors: AutomationIssue[] }>(`/api/automations/${id}/validate`, null)
      .pipe(map((report) => report.errors.map((issue) => ({ code: issue.code, message: issue.message, path: issue.path ?? null }))));
  }

  /** Publishes the draft: a new version, or the latest one when nothing changed. A refusal carries its problems. */
  publish(id: string, etag: string): Observable<{ readonly versionNumber: number; readonly created: boolean }> {
    return this.http
      .post<{ versionNumber: number; created: boolean }>(`/api/automations/${id}/publish`, null, { headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(({ versionNumber, created }) => ({ versionNumber, created })));
  }

  /** The published versions, newest first (automation-ui.md §8.4). */
  versions(id: string): Observable<readonly AutomationVersionSummary[]> {
    return this.http
      .get<AutomationVersionSummary[]>(`/api/automations/${id}/versions`)
      .pipe(map((versions) => versions.map(({ versionNumber, publishedAt }) => ({ versionNumber, publishedAt })).sort((a, b) => b.versionNumber - a.versionNumber)));
  }

  /** One published version, with its document. */
  version(id: string, versionNumber: number): Observable<AutomationVersion> {
    return this.http
      .get<AutomationVersion>(`/api/automations/${id}/versions/${versionNumber}`)
      .pipe(map(({ versionNumber: number, publishedAt, document }) => ({ versionNumber: number, publishedAt, document })));
  }

  /** Copies a version into the draft, with `If-Match`; nothing is published (§8.4). */
  restore(id: string, versionNumber: number, etag: string): Observable<AutomationDraft> {
    return this.http
      .post<Omit<AutomationDraft, 'etag'>>(`/api/automations/${id}/versions/${versionNumber}/restore`, null, {
        observe: 'response',
        headers: new HttpHeaders({ 'If-Match': etag }),
      })
      .pipe(map(toDraft));
  }

  /** The destinations and credentials a Modeler may reference (automation-ui.md §1.1). */
  resources(): Observable<AutomationResources> {
    return this.http.get<AutomationResources>('/api/automations/resources');
  }

  /** The inputs and outputs a version declares. */
  contract(id: string, versionNumber: number): Observable<AutomationContract> {
    return this.http
      .get<{ versionNumber: number; document: { inputs?: unknown; outputs?: unknown } }>(`/api/automations/${id}/versions/${versionNumber}`)
      .pipe(map((version) => ({ version: version.versionNumber, inputs: fields(version.document.inputs), outputs: fields(version.document.outputs) })));
  }
}

/** The problems a refusal carries: a draft that doesn't parse (400 `invalid_document`) or can't be published (422). */
export function issuesOf(problem: ApiProblem): AutomationIssue[] {
  return problem.errors
    .filter((issue): issue is AutomationIssue => typeof issue === 'object' && issue !== null && typeof (issue as AutomationIssue).code === 'string')
    .map((issue) => ({ code: issue.code, message: issue.message, path: issue.path ?? null }));
}

function fields(json: unknown): ContractField[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json
    .filter((field): field is { key: string; type: string; required?: unknown } => typeof field?.key === 'string' && typeof field?.type === 'string')
    .map((field) => ({ key: field.key, type: field.type, required: field.required === true }));
}

function toDraft(response: HttpResponse<Omit<AutomationDraft, 'etag'>>): AutomationDraft {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
