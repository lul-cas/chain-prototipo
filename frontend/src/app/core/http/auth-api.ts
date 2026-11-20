import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/** The caller, as `GET /api/auth/me` returns it (identity.md, I1 and I2). */
export interface Me {
  readonly id: string;
  readonly kind: 'user' | 'bot';
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly mustChangePassword: boolean;
  /** Admins and Modelers may model workflows (identity.md; workflow-definition.md §5.2). */
  readonly canModel: boolean;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

/** The authentication endpoints (identity.md, I1). The session cookie is the browser's business, never the app's. */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);

  login(username: string, password: string): Observable<void> {
    return this.http.post<void>('/api/auth/login', { username, password });
  }

  logout(): Observable<void> {
    return this.http.post<void>('/api/auth/logout', {});
  }

  me(): Observable<Me> {
    return this.http.get<Me>('/api/auth/me');
  }

  changePassword(currentPassword: string, newPassword: string): Observable<void> {
    return this.http.post<void>('/api/auth/change-password', { currentPassword, newPassword });
  }
}
