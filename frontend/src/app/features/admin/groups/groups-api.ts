import { HttpClient, HttpHeaders, HttpParams, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** A group as the list shows it (identity.md I2). */
export interface GroupSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isArchived: boolean;
  /** It holds the Modeler grant, which archiving suspends (admin-ui.md §8, S-A1). */
  readonly isModeler: boolean;
  readonly memberCount: number;
}

/** A member: a user or a bot, which the view doesn't tell apart. */
export interface Member {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly isActive: boolean;
}

export interface Group extends GroupSummary {
  readonly version: number;
  readonly members: readonly Member[];
}

/** A group with its `ETag`, which an edit sends back as `If-Match`. */
export interface VersionedGroup extends Group {
  readonly etag: string;
}

/** What *Editar nome e descrição* sends: an empty description clears it (identity.md I2). */
export interface GroupChanges {
  readonly name: string;
  readonly description: string;
}

const BASE = '/api/admin/groups';

/** Groups, their members and the Modeler grant, for admins (identity.md I2; admin-ui.md §5). */
@Injectable({ providedIn: 'root' })
export class GroupsApi {
  private readonly http = inject(HttpClient);

  list(includeArchived: boolean): Observable<readonly GroupSummary[]> {
    const params = includeArchived ? new HttpParams().set('includeArchived', true) : new HttpParams();
    return this.http.get<GroupSummary[]>(BASE, { params });
  }

  get(id: string): Observable<VersionedGroup> {
    return this.http.get<Group>(path(id), { observe: 'response' }).pipe(map(versioned));
  }

  create(name: string, description: string | null): Observable<Group> {
    return this.http.post<Group>(BASE, { name, description });
  }

  update(id: string, etag: string, changes: GroupChanges): Observable<VersionedGroup> {
    return this.http
      .patch<Group>(path(id), changes, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(versioned));
  }

  archive(id: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/archive`, null);
  }

  unarchive(id: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/unarchive`, null);
  }

  /** Grants or revokes Modeler; both are idempotent. */
  setModeler(id: string, granted: boolean): Observable<void> {
    return granted ? this.http.put<void>(`${path(id)}/modeler`, null) : this.http.delete<void>(`${path(id)}/modeler`);
  }

  addMember(id: string, userId: string): Observable<void> {
    return this.http.put<void>(`${path(id)}/members/${encodeURIComponent(userId)}`, null);
  }

  removeMember(id: string, userId: string): Observable<void> {
    return this.http.delete<void>(`${path(id)}/members/${encodeURIComponent(userId)}`);
  }
}

function path(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

function versioned(response: HttpResponse<Group>): VersionedGroup {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
