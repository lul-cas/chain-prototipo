import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Tab, TabContent, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { RouterLink } from '@angular/router';
import { isApiProblem } from '../../core/http/api-problem';
import { EngineApi, InboxItem, InboxView } from '../../core/http/engine-api';
import { messageFor } from '../../core/http/messages';
import { SessionService } from '../../core/session/session.service';
import { Alert } from '../../ui/alert/alert';
import { Button } from '../../ui/button/button';

interface InboxTab {
  readonly value: 'mine' | 'group' | 'others';
  readonly label: string;
  readonly items: readonly InboxItem[];
  readonly empty: string;
}

/** The open tasks the user may work on, in three tabs (requests-ui.md §3). */
@Component({
  selector: 'chain-inbox-page',
  imports: [Alert, Button, DatePipe, RouterLink, Tab, TabContent, TabList, TabPanel, Tabs],
  templateUrl: './inbox-page.html',
  styleUrl: './inbox-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InboxPage {
  private readonly api = inject(EngineApi);
  protected readonly session = inject(SessionService);

  protected readonly inbox = signal<InboxView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = signal<string | undefined>(undefined);
  protected readonly tabs = computed<readonly InboxTab[]>(() => {
    const inbox = this.inbox();
    return inbox
      ? [
          { value: 'mine', label: 'Minhas', items: inbox.assignedToMe, empty: 'Nenhuma tarefa com você.' },
          { value: 'group', label: 'Do grupo', items: inbox.unassigned, empty: 'Nenhuma tarefa esperando o grupo.' },
          { value: 'others', label: 'Com outros', items: inbox.assignedToOthers, empty: 'Nenhuma tarefa com outras pessoas.' },
        ]
      : [];
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.error.set(null);
    this.api.inbox().subscribe({
      next: (inbox) => {
        this.inbox.set(inbox);
        // The first tab with tasks, so the work is in view; Minhas when there is none.
        this.selected.set(this.tabs().find((tab) => tab.items.length > 0)?.value ?? 'mine');
      },
      error: (error: unknown) => this.error.set(messageFor(isApiProblem(error) ? error.code : 'unexpected')),
    });
  }
}
