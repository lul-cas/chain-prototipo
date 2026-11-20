import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** A bot's API token, without its value, which only its creation answers with (identity.md I3). */
export interface BotToken {
  readonly id: string;
  readonly label: string;
  /** The public part of the value, `chn_<prefix>_…`. */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** A bot as the API shows it (identity.md I3). The list leaves `tokens` and `groups` empty, but counts the active tokens (S-A3). */
export interface Bot {
  readonly id: string;
  /** The identifier, with the username rules. */
  readonly name: string;
  readonly displayName: string;
  readonly isActive: boolean;
  readonly mcpEnabled: boolean;
  /** Its own MCP rate, or null for the server's default (mcp.md §5). */
  readonly mcpCallsPerMinute: number | null;
  readonly createdAt: string;
  readonly version: number;
  readonly activeTokenCount: number;
  readonly tokens: readonly BotToken[];
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

/** A bot with its `ETag`, which a rename sends back as `If-Match`. */
export interface VersionedBot extends Bot {
  readonly etag: string;
}

/** A new token and its value, which the API gives only in this answer. */
export interface CreatedToken {
  readonly token: BotToken;
  readonly value: string;
}

const BASE = '/api/admin/bots';

/** Bots, their MCP access and their tokens, for admins (identity.md I3; admin-ui.md §6). */
@Injectable({ providedIn: 'root' })
export class BotsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<readonly Bot[]> {
    return this.http.get<Bot[]>(BASE);
  }

  get(id: string): Observable<VersionedBot> {
    return this.http.get<Bot>(path(id), { observe: 'response' }).pipe(map(versioned));
  }

  create(name: string, displayName: string): Observable<Bot> {
    return this.http.post<Bot>(BASE, { name, displayName });
  }

  update(id: string, etag: string, displayName: string): Observable<VersionedBot> {
    return this.http
      .patch<Bot>(path(id), { displayName }, { observe: 'response', headers: new HttpHeaders({ 'If-Match': etag }) })
      .pipe(map(versioned));
  }

  setActive(id: string, active: boolean): Observable<void> {
    return this.http.post<void>(`${path(id)}/${active ? 'activate' : 'deactivate'}`, null);
  }

  /** Lets AI agents use the bot's tokens at `/mcp`, or stops them (mcp.md §5). */
  setMcp(id: string, enabled: boolean): Observable<void> {
    return this.http.post<void>(`${path(id)}/mcp/${enabled ? 'enable' : 'disable'}`, null);
  }

  /** The bot's own MCP rate, 1 to 600 calls a minute, or null for the server's default. */
  setRate(id: string, callsPerMinute: number | null): Observable<Bot> {
    return this.http.put<Bot>(`${path(id)}/mcp/rate`, { callsPerMinute });
  }

  createToken(id: string, label: string): Observable<CreatedToken> {
    return this.http.post<CreatedToken>(`${path(id)}/tokens`, { label });
  }

  revokeToken(id: string, tokenId: string): Observable<void> {
    return this.http.post<void>(`${path(id)}/tokens/${encodeURIComponent(tokenId)}/revoke`, null);
  }
}

function path(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

function versioned(response: HttpResponse<Bot>): VersionedBot {
  return { ...response.body!, etag: response.headers.get('ETag') ?? '' };
}
