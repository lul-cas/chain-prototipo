import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** A file the server stored, pending until a command references it (ADR-0014 §4.3). */
export interface UploadedFile {
  readonly fileId: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
}

/** The files endpoint (ADR-0014 §4.3, workflow-engine.md §9). */
@Injectable({ providedIn: 'root' })
export class FilesApi {
  private readonly http = inject(HttpClient);

  /** The server's size limit, configured (ADR-0014 §4.3 and §5; card #195). */
  limits(): Observable<{ readonly maxBytes: number }> {
    return this.http.get<{ maxBytes: number }>('/api/files/limits');
  }

  /** Uploads one file, multipart, with its own idempotency key. */
  upload(file: File, key: string): Observable<UploadedFile> {
    const body = new FormData();
    body.append('file', file, file.name);
    return this.http
      .post<{ id: string; name: string; size: number; contentType: string }>('/api/files', body, { headers: new HttpHeaders({ 'Idempotency-Key': key }) })
      .pipe(map(({ id, name, size, contentType }) => ({ fileId: id, name, size, contentType })));
  }
}
