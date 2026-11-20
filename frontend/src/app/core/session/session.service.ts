import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi, Me } from '../http/auth-api';

/**
 * Who is signed in (ADR-0010 D3; identity.md, UI). The server is the source of truth: the user is whatever `/api/auth/me`
 * last returned, and every change of the session reloads it.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(AuthApi);
  private readonly current = signal<Me | null>(null);

  readonly user = this.current.asReadonly();
  readonly signedIn = computed(() => this.current() !== null);
  readonly mustChangePassword = computed(() => this.current()?.mustChangePassword ?? false);

  /** Loads the signed-in user; any failure, 401 included, means signed out. */
  async load(): Promise<Me | null> {
    try {
      this.current.set(await firstValueFrom(this.api.me()));
    } catch {
      this.current.set(null);
    }
    return this.current();
  }

  /** Logs in and loads the user. A failed login rejects with the API problem. */
  async login(username: string, password: string): Promise<Me> {
    await firstValueFrom(this.api.login(username, password));
    const me = await this.load();
    if (!me) {
      throw new Error('The session was not established after a successful login.');
    }
    return me;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await firstValueFrom(this.api.changePassword(currentPassword, newPassword));
    await this.load();
  }

  /** Ends the session. The user is forgotten even when the server says the session had already ended. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      // Already signed out on the server; nothing else to undo.
    } finally {
      this.clear();
    }
  }

  clear(): void {
    this.current.set(null);
  }
}
