import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../core/http/api-problem';
import { FILE_UPLOADS, FileUploads, formatSize, provideFileUploads } from './uploads';

const MB = 1024 * 1024;

describe('file uploads for form fields (forms.md F3, "File fields"; ADR-0014 §4.3)', () => {
  let uploads: FileUploads;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideFileUploads()],
    });
    uploads = TestBed.inject(FILE_UPLOADS);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  const sized = (name: string, size: number) => {
    const file = new File(['x'], name, { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };
  const outcome = (file: File) => firstValueFrom(uploads.upload(file)).then(() => 'sent', (text: unknown) => text);
  const limits = () => backend.expectOne({ method: 'GET', url: '/api/files/limits' });

  it("reads the server's limit once, then posts each file alone, with a key of its own, and gives back what the server stored", async () => {
    const first = firstValueFrom(uploads.upload(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' })));
    limits().flush({ maxBytes: 25 * MB });
    const one = backend.expectOne({ method: 'POST', url: '/api/files' });
    expect((one.request.body as FormData).get('file')).toBeInstanceOf(File);
    one.flush({ id: 'f-1', name: 'a.pdf', size: 8, contentType: 'application/pdf' }, { status: 201, statusText: 'Created' });
    expect(await first).toEqual({ fileId: 'f-1', name: 'a.pdf', size: '8', contentType: 'application/pdf' });

    void firstValueFrom(uploads.upload(new File(['x'], 'b.txt', { type: 'text/plain' })));
    backend.expectNone('/api/files/limits');
    const two = backend.expectOne({ method: 'POST', url: '/api/files' });
    expect(two.request.headers.get('Idempotency-Key')).toBeTruthy();
    expect(two.request.headers.get('Idempotency-Key')).not.toBe(one.request.headers.get('Idempotency-Key'));
    two.flush({ id: 'f-2', name: 'b.txt', size: 1, contentType: 'text/plain' }, { status: 201, statusText: 'Created' });
  });

  it("refuses a file over the server's limit without sending it, naming the limit (card #195)", async () => {
    const big = outcome(sized('grande.pdf', MB + 1));
    limits().flush({ maxBytes: MB });
    expect(await big).toBe('O arquivo passa de 1 MB.');
    backend.expectNone('/api/files');

    void outcome(sized('limite.pdf', MB));
    backend.expectOne('/api/files').flush({ id: 'f-1', name: 'limite.pdf', size: MB, contentType: 'application/pdf' });
  });

  it('asks for the limit once for files chosen together', async () => {
    void outcome(sized('a.pdf', 10));
    void outcome(sized('b.pdf', 10));
    limits().flush({ maxBytes: MB });

    const posts = backend.match({ method: 'POST', url: '/api/files' });
    expect(posts).toHaveLength(2);
    posts.forEach((post, i) => post.flush({ id: `f-${i}`, name: 'a.pdf', size: 10, contentType: 'application/pdf' }));
  });

  it("sends the file when the limit can't be read, so the server decides, and asks again for the next file", async () => {
    const first = outcome(sized('grande.pdf', 30 * MB));
    limits().error(new ProgressEvent('error'));
    backend.expectOne('/api/files').flush({ type: 'about:blank', title: 'Grande', status: 413, code: 'file_too_large' }, { status: 413, statusText: 'Too Large' });
    expect(await first).toBe('O arquivo passa do tamanho máximo.');

    const second = outcome(sized('grande.pdf', 30 * MB));
    limits().flush({ maxBytes: 25 * MB });
    expect(await second).toBe('O arquivo passa de 25 MB.');
  });

  it('words what the server refuses', async () => {
    const cases: [number, string | null, string][] = [
      [413, 'file_too_large', 'O arquivo passa do tamanho máximo.'],
      [415, 'file_type_not_allowed', 'Tipo de arquivo não permitido.'],
      [0, null, 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.'],
    ];
    for (const [index, [status, code, text]] of cases.entries()) {
      const answer = outcome(new File(['x'], 'a.pdf'));
      if (index === 0) {
        limits().flush({ maxBytes: 25 * MB });
      }
      const request = backend.expectOne('/api/files');
      if (status === 0) {
        request.error(new ProgressEvent('error'));
      } else {
        request.flush({ type: 'about:blank', title: 'Recusado', status, code }, { status, statusText: 'Recusado' });
      }
      expect(await answer).toBe(text);
    }
  });

  it('writes sizes in pt-BR, in bytes, KB or MB', () => {
    expect([1, 1023, 1024, 1536, 1024 * 1024 - 1, 1258291].map(formatSize)).toEqual(['1 byte', '1023 bytes', '1 KB', '1,5 KB', '1.024 KB', '1,2 MB']);
  });
});
