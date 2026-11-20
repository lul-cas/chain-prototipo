import { HttpClient, HttpHeaders, HttpParams, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** A credential's metadata (automation.md §4.2): no response carries its value, which is write-only (ADR-0012). */
export interface Secret {
  readonly name: string;
  readonly description: string | null;
  readonly allowedDestinations: readonly string[];
  /** How many values have been set; it says nothing about the value. */
  readonly version: number;
  /** The key that encrypts it, which KEK rotation needs (card #77). */
  readonly keyId: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly updatedAt: string;
}

export interface VersionedSecret extends Secret {
  readonly etag: string;
}

const BASE = '/api/admin/automation/secrets';

/** The credentials of automations (automation.md §4.2), for admins. The value goes only to create and to change it (§4.6). */
@Injectable({ providedIn: 'root' })
export class SecretsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<readonly Secret[]> {
    return this.http.get<Secret[]>(BASE);
  }

  get(name: string): Observable<VersionedSecret> {
    return this.http.get<Secret>(`${BASE}/${encodeURIComponent(name)}`, { observe: 'response' }).pipe(map(versioned));
  }

  create(name: string, description: string | null, value: string, allowedDestinations: readonly string[]): Observable<VersionedSecret> {
    return this.http.post<Secret>(BASE, { name, description, value, allowedDestinations }, { observe: 'response' }).pipe(map(versioned));
  }

  /** The description and the allowed destinations, with `If-Match`; never the value. */
  update(name: string, etag: string, description: string | null, allowedDestinations: readonly string[], force = false): Observable<VersionedSecret> {
    return this.http
      .patch<Secret>(`${BASE}/${encodeURIComponent(name)}`, { description, allowedDestinations }, {
        observe: 'response',
        headers: new HttpHeaders({ 'If-Match': etag }),
        params: force ? new HttpParams().set('force', 'true') : new HttpParams(),
      })
      .pipe(map(versioned));
  }

  /** Trocar valor (§4.4), with `If-Match`. */
  setValue(name: string, etag: string, value: string): Observable<VersionedSecret> {
    return this.http
      .put<Secret>(`${BASE}/${encodeURIComponent(name)}/value`, { value }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(versioned));
  }

  remove(name: string, force = false): Observable<void> {
    return this.http.delete<void>(`${BASE}/${encodeURIComponent(name)}`, { params: force ? new HttpParams().set('force', 'true') : new HttpParams() });
  }
}

function versioned(response: HttpResponse<Secret>): VersionedSecret {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
