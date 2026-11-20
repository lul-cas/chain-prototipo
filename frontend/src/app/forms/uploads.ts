import { InjectionToken, Provider, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay, switchMap, take, throwError } from 'rxjs';
import { isApiProblem } from '../core/http/api-problem';
import { FilesApi } from '../core/http/files-api';
import { messageFor } from '../core/http/messages';

/** A file a form field holds (forms.md F4): as stored, with its size as text, as the controls hold their values. */
export type FieldFile = { readonly fileId: string; readonly name: string; readonly size: string; readonly contentType: string };

/** A file on its way to the server, held in its field's value until the server answers (forms.md F3, "File fields"). */
export type PendingUpload = { readonly uploadId: string; readonly name: string };

/** How a page uploads the files chosen in a form (forms.md F3, "File fields"). A refusal errors with the text to show. */
export interface FileUploads {
  upload(file: File): Observable<FieldFile>;
}

/** The renderer calls no API: the pages that submit forms provide uploads, and a preview doesn't. */
export const FILE_UPLOADS = new InjectionToken<FileUploads>('FILE_UPLOADS');

const REFUSALS: Readonly<Record<string, string>> = {
  file_too_large: 'O arquivo passa do tamanho máximo.',
  file_type_not_allowed: 'Tipo de arquivo não permitido.',
};

/**
 * Uploads through `POST /api/files`, each file with an idempotency key of its own (ADR-0014 §4.3). A file over the server's
 * limit isn't sent: far over it, the browser may see a reset connection instead of `file_too_large`. The limit is read once,
 * before the first upload (card #195); if it can't be read, the file is sent and the server decides.
 */
export function provideFileUploads(): Provider {
  return {
    provide: FILE_UPLOADS,
    useFactory: (): FileUploads => {
      const api = inject(FilesApi);
      let limit: Observable<number | null> | null = null;
      const maxBytes = () =>
        (limit ??= api.limits().pipe(
          map(({ maxBytes }) => maxBytes),
          catchError(() => {
            limit = null; // not kept: the next upload asks again
            return of(null);
          }),
          shareReplay(1),
        ));
      return {
        upload: (file) =>
          maxBytes().pipe(
            take(1),
            switchMap((max) =>
              max !== null && file.size > max
                ? throwError(() => `O arquivo passa de ${formatSize(max)}.`)
                : api.upload(file, crypto.randomUUID()).pipe(
                    map(({ fileId, name, size, contentType }) => ({ fileId, name, size: String(size), contentType })),
                    catchError((error: unknown) => throwError(() => messageFor(isApiProblem(error) ? error.code : 'network_error', REFUSALS))),
                  ),
            ),
          ),
      };
    },
  };
}

/** A stored file, as prefill or as a field's value holds it; the size may be a number or its text. */
export function toFieldFile(value: unknown): FieldFile | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { fileId, name, size, contentType } = value as Record<string, unknown>;
  return typeof fileId === 'string' && typeof name === 'string' && (typeof size === 'number' || typeof size === 'string') && typeof contentType === 'string'
    ? { fileId, name, size: String(size), contentType }
    : null;
}

export function isPendingUpload(value: unknown): value is PendingUpload {
  return typeof value === 'object' && value !== null && typeof (value as Partial<PendingUpload>).uploadId === 'string';
}

/** A file's size in pt-BR: "8 bytes", "1,5 KB", "1,2 MB". */
export function formatSize(bytes: number): string {
  const number = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) {
    return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  }
  return bytes < 1024 * 1024 ? `${number(bytes / 1024)} KB` : `${number(bytes / (1024 * 1024))} MB`;
}
