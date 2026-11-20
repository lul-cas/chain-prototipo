import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiProblem } from '../../core/http/api-problem';
import { FieldErrorView, FormDocument } from '../../forms/model';

/** A form a node can reference (workflow-editor.md §10.5). */
export interface FormOption {
  readonly id: string;
  readonly name: string;
  /** Null until the form is first published: a draft references it, and publishing then reports it. */
  readonly latestVersion: number | null;
}

/** A form in the designer's list (form-designer.md §12.1). */
export interface FormSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number | null;
  readonly draftUpdatedAt: string;
}

/** A form with its draft and its `ETag`, which every change sends back as `If-Match`. */
export interface FormDraft extends FormSummary {
  readonly version: number;
  readonly draft: unknown;
  readonly etag: string;
}

/** A published version (forms.md F1). */
export interface FormVersionSummary {
  readonly versionNumber: number;
  readonly publishedAt: string;
}

/** What `validate-submission` says of a test fill: its errors per field, and the values the server would store. */
export interface SubmissionReport {
  readonly valid: boolean;
  readonly errors: readonly FieldErrorView[];
  readonly values: unknown;
}

/** A structural problem the server found (forms.md F1): its code, an English message, and the component's path. */
export interface FormIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string | null;
}

/** The forms endpoints (forms.md F1): for the workflow editor's form picker, and for the form designer. */
@Injectable({ providedIn: 'root' })
export class FormsApi {
  private readonly http = inject(HttpClient);

  /** The forms, by name. */
  list(): Observable<readonly FormOption[]> {
    return this.http.get<FormOption[]>('/api/forms').pipe(
      map((forms) =>
        forms
          .map(({ id, name, latestVersion }) => ({ id, name, latestVersion: latestVersion ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      ),
    );
  }

  /** Every form with its draft's facts, by name (form-designer.md §12.1). */
  summaries(): Observable<readonly FormSummary[]> {
    return this.http
      .get<FormSummary[]>('/api/forms')
      .pipe(map((forms) => [...forms].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))));
  }

  /** Creates an empty form; its id. */
  create(name: string, description: string): Observable<string> {
    return this.http.post<{ id: string }>('/api/forms', { name, description: description.trim() || null }).pipe(map((form) => form.id));
  }

  get(id: string): Observable<FormDraft> {
    return this.http.get<Omit<FormDraft, 'etag'>>(`/api/forms/${id}`, { observe: 'response' }).pipe(map(toDraft));
  }

  rename(id: string, etag: string, name: string, description: string): Observable<FormDraft> {
    return this.http
      .patch<Omit<FormDraft, 'etag'>>(`/api/forms/${id}`, { name, description }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** Saves the draft with `If-Match`. The server only parses it (FM000): a refusal carries its problems (`issuesOf`). */
  saveDraft(id: string, etag: string, document: FormDocument): Observable<FormDraft> {
    return this.http
      .put<Omit<FormDraft, 'etag'>>(`/api/forms/${id}/draft`, { document }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(toDraft));
  }

  /** The problems publishing would find in the draft; empty when it can be published. */
  validate(id: string): Observable<readonly FormIssue[]> {
    return this.http.post<{ errors: FormIssue[] }>(`/api/forms/${id}/validate`, null).pipe(map((report) => report.errors.map(toIssue)));
  }

  /** Publishes the draft: a new version, or the latest one when nothing changed. A refusal carries its problems (`issuesOf`). */
  publish(id: string, etag: string): Observable<{ readonly versionNumber: number; readonly created: boolean }> {
    return this.http
      .post<{ versionNumber: number; created: boolean }>(`/api/forms/${id}/publish`, null, { headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(({ versionNumber, created }) => ({ versionNumber, created })));
  }

  /** The published versions, newest first (§9.7). */
  versions(id: string): Observable<readonly FormVersionSummary[]> {
    return this.http
      .get<FormVersionSummary[]>(`/api/forms/${id}/versions`)
      .pipe(map((versions) => [...versions].sort((a, b) => b.versionNumber - a.versionNumber)));
  }

  /** Copies a version into the draft, with `If-Match`; nothing is published (FD12). */
  restore(id: string, versionNumber: number, etag: string): Observable<FormDraft> {
    return this.http
      .post<Omit<FormDraft, 'etag'>>(`/api/forms/${id}/versions/${versionNumber}/restore`, null, {
        observe: 'response',
        headers: new HttpHeaders({ 'If-Match': etag }),
      })
      .pipe(map(toDraft));
  }

  /** Testar no servidor (§9.7): the renderer's JSON as it is, so decimals stay exact; nothing is stored. */
  validateSubmission(id: string, versionNumber: number, json: string): Observable<SubmissionReport> {
    return this.http.post<SubmissionReport>(`/api/forms/${id}/versions/${versionNumber}/validate-submission`, json, {
      headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
    });
  }

  version(id: string, versionNumber: number): Observable<FormDocument> {
    return this.http.get<{ document: FormDocument }>(`/api/forms/${id}/versions/${versionNumber}`).pipe(map((version) => version.document));
  }
}

/** The problems of a `form_validation_failed` or `invalid_document` answer (forms.md F1). */
export function issuesOf(problem: ApiProblem): FormIssue[] {
  return problem.errors
    .filter((error): error is FormIssue => typeof error === 'object' && error !== null && typeof (error as FormIssue).code === 'string')
    .map(toIssue);
}

/** A problem without a component, such as FM006, has a null path, whether the server sends null or leaves it out. */
function toIssue(issue: FormIssue): FormIssue {
  return { code: issue.code, message: issue.message, path: issue.path ?? null };
}

function toDraft(response: HttpResponse<Omit<FormDraft, 'etag'>>): FormDraft {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
