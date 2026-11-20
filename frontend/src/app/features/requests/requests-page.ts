import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isApiProblem } from '../../core/http/api-problem';
import { EngineApi, InstanceStatus, InstanceSummary } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';
import { FormField } from '../../ui/form-field/form-field';
import { Input } from '../../ui/form-field/input';
import { STATUS_LABEL } from './status';

/** The user's requests, or every request they can see, by status (requests-ui.md §5). */
@Component({
  selector: 'chain-requests-page',
  imports: [Alert, Button, DatePipe, FormField, Input, RouterLink],
  templateUrl: './requests-page.html',
  styleUrl: './requests-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestsPage {
  private readonly api = inject(EngineApi);
  private loads = 0;

  protected readonly scope = signal<'mine' | 'visible'>('mine');
  protected readonly status = signal<InstanceStatus | ''>('');
  protected readonly requests = signal<readonly InstanceSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statuses = Object.entries(STATUS_LABEL) as [InstanceStatus, string][];

  constructor() {
    effect(() => {
      const [scope, status] = [this.scope(), this.status()];
      untracked(() => this.load(scope, status));
    });
  }

  protected load(scope = this.scope(), status = this.status()): void {
    const load = ++this.loads; // only the latest answer counts when the filters change quickly
    this.error.set(null);
    this.api.requests(scope, status || null).subscribe({
      next: (requests) => {
        if (load === this.loads) {
          this.requests.set(requests);
        }
      },
      error: (error: unknown) => {
        if (load === this.loads) {
          this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected'));
        }
      },
    });
  }

  protected chooseStatus(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value as InstanceStatus | '');
  }
}
