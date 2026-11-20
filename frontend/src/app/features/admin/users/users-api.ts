import { HttpClient, HttpHeaders, HttpParams, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** A group the user belongs to, as the user's view names it. */
export interface UserGroup {
  readonly id: string;
  readonly name: string;
}

/** A user as the API shows it (identity.md I2). The list leaves `groups` empty; reading one user fills it. */
export interface User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly isActive: boolean;
  readonly isLocked: boolean;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly version: number;
  readonly groups: readonly UserGroup[];
}

/** A user with its `ETag`, which an edit sends back as `If-Match`. */
export interface VersionedUser extends User {
  readonly etag: string;
}

export interface UserPage {
  readonly items: readonly User[];
  readonly total: number;
}

/** A new user and its temporary password, which the API gives only in this answer. */
export interface CreatedUser {
  readonly user: User;
  readonly temporaryPassword: string;
}

/** What *Editar* changes (admin-ui.md §4.2). */
export interface UserChanges {
  readonly displayName: string;
  readonly isAdmin: boolean;
}

/** The list's page size (admin-ui.md §4.1). */
export const PAGE_SIZE = 50;

const BASE = '/api/admin/users';

/** Users, for admins (identity.md I2; admin-ui.md §4). */
@Injectable({ providedIn: 'root' })
export class UsersApi {
  private readonly http = inject(HttpClient);

  /** A page of users matching the search by name or username; a blank search lists everyone. */
  list(search: string, offset: number): Observable<UserPage> {
    let params = new HttpParams();
    if (search.trim() !== '') {
      params = params.set('search', search.trim());
    }
    params = params.set('limit', PAGE_SIZE).set('offset', offset);
    return this.http.get<UserPage>(BASE, { params });
  }

  get(id: string): Observable<VersionedUser> {
    return this.http.get<User>(path(id), { observe: 'response' }).pipe(map(versioned));
  }

  create(username: string, displayName: string, isAdmin: boolean): Observable<CreatedUser> {
    return this.http.post<CreatedUser>(BASE, { username, displayName, isAdmin });
  }

  update(id: string, etag: string, changes: UserChanges): Observable<VersionedUser> {
    return this.http
      .patch<User>(path(id), changes, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(versioned));
  }

  deactivate(id: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/deactivate`, null);
  }

  activate(id: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/activate`, null);
  }

  unlock(id: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/unlock`, null);
  }

  /** A new temporary password: the old one stops working, the sessions end and the account is unlocked. */
  resetPassword(id: string): Observable<string> {
    return this.http.post<{ temporaryPassword: string }>(`${path(id)}/reset-password`, null).pipe(map((answer) => answer.temporaryPassword));
  }
}

function path(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

function versioned(response: HttpResponse<User>): VersionedUser {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
