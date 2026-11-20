import { HttpClient, HttpHeaders, HttpParams, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { Usage } from '../in-use';
import { DestinationSettings } from './destination-rules';

/** A destination as the API shows it (automation.md §3.1); its sizes are always set, the default included. */
export interface Destination extends DestinationSettings {
  readonly name: string;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** A destination with its `ETag`, which an update sends back as `If-Match`. */
export interface VersionedDestination extends Destination {
  readonly etag: string;
}

/** What uses a destination (automation-ui.md §1.1). */
export type DestinationUsage = Usage;

const BASE = '/api/admin/automation/destinations';

/** The destinations of automations (automation.md §3.2), for admins. */
@Injectable({ providedIn: 'root' })
export class DestinationsApi {
  private readonly http = inject(HttpClient);

  /** Every destination, in name order, as the API lists them. */
  list(): Observable<readonly Destination[]> {
    return this.http.get<Destination[]>(BASE);
  }

  get(name: string): Observable<VersionedDestination> {
    return this.http.get<Destination>(`${BASE}/${encodeURIComponent(name)}`, { observe: 'response' }).pipe(map(versioned));
  }

  create(name: string, settings: DestinationSettings): Observable<VersionedDestination> {
    return this.http.post<Destination>(BASE, { name, ...settings }, { observe: 'response' }).pipe(map(versioned));
  }

  /** `PUT` replaces every setting (an absent one goes back to its default), with `If-Match`. */
  update(name: string, etag: string, settings: DestinationSettings, force = false): Observable<VersionedDestination> {
    return this.http
      .put<Destination>(`${BASE}/${encodeURIComponent(name)}`, settings, {
        observe: 'response',
        headers: new HttpHeaders({ 'If-Match': etag }),
        params: forced(force),
      })
      .pipe(map(versioned));
  }

  remove(name: string, force = false): Observable<void> {
    return this.http.delete<void>(`${BASE}/${encodeURIComponent(name)}`, { params: forced(force) });
  }
}

function forced(force: boolean): HttpParams {
  return force ? new HttpParams().set('force', 'true') : new HttpParams();
}

function versioned(response: HttpResponse<Destination>): VersionedDestination {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}

export { usageOf } from '../in-use';
