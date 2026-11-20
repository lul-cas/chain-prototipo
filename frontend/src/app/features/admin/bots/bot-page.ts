import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, Subject, takeUntil } from 'rxjs';
import { isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { ToastService } from '../../../ui/toast/toast.service';
import { SecretOnceData, SecretOnceDialog } from '../secret-once-dialog';
import { BotDialog, BotDialogData, BotDialogResult } from './bot-dialog';
import { BOT_FIELD_TEXTS, rateProblem } from './bot-rules';
import { BotToken, BotsApi, CreatedToken, VersionedBot } from './bots-api';
import { TokenDialog, TokenDialogData } from './token-dialog';

/** The most active tokens a bot may hold (identity.md I3). */
const MAX_ACTIVE_TOKENS = 5;

/**
 * A bot's page (admin-ui.md §6.2, A4): the name, **Desativar** or **Ativar**, its groups, **MCP** with the rate, and the tokens.
 * A new token's value shows once, as a temporary password does (§4.3). Each change reads the bot again; a lost answer offers
 * **Tentar de novo**, except for a new token, which a retry would make twice. The page starts afresh on another bot.
 */
@Component({
  selector: 'chain-bot-page',
  imports: [Alert, Button, DatePipe, RouterLink],
  templateUrl: './bot-page.html',
  styleUrls: ['../admin-table.css', './bot-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BotPage {
  readonly id = input.required<string>();
  private readonly api = inject(BotsApi);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly bot = signal<VersionedBot | null>(null);
  protected readonly loadError = signal<{ readonly text: string; readonly retry: boolean } | null>(null);
  /** What the page could not confirm. */
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<{ readonly text: string; readonly retry?: () => void } | null>(null);
  protected readonly busy = signal(false);
  /** *Limite próprio* is chosen, and the number typed for it. */
  protected readonly ownRate = signal(false);
  protected readonly rate = signal('');
  protected readonly rateTried = signal(false);
  protected readonly rateError = computed(() => (this.ownRate() && this.rateTried() && rateProblem(this.rate()) ? BOT_FIELD_TEXTS['invalid_calls_per_minute'] : null));
  protected readonly activeText = computed(() => {
    const active = (this.bot()?.tokens ?? []).filter((token) => token.revokedAt === null).length;
    return active === 0 ? 'Nenhum token ativo.' : active === 1 ? `1 token ativo de ${MAX_ACTIVE_TOKENS}.` : `${active} tokens ativos de ${MAX_ACTIVE_TOKENS}.`;
  });
  /** Ends what was started for the previous bot (card #187). */
  private readonly switched = new Subject<void>();

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.open(id));
    });
    inject(DestroyRef).onDestroy(() => this.switched.next());
  }

  protected load(id: string = this.id()): void {
    this.api
      .get(id)
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: (bot) => this.show(bot),
        error: (error: unknown) => {
          const problem = isApiProblem(error) ? error : null;
          this.loadError.set(problem?.status === 404 ? { text: 'Este bot não existe.', retry: false } : { text: messageFor(problem?.code ?? 'unexpected'), retry: true });
        },
      });
  }

  protected rename(): void {
    const bot = this.bot();
    if (!bot) {
      return;
    }
    this.clearMessages();
    this.dialogs
      .open<BotDialogResult, BotDialogData>(BotDialog, { data: { bot } })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((result) => {
        if (result && 'saved' in result) {
          this.show(result.saved);
          this.toasts.show({ tone: 'success', message: 'Bot salvo.' });
        } else if (result && 'uncertain' in result) {
          this.notice.set(result.uncertain);
          this.load();
        }
      });
  }

  protected switchActive(): void {
    const bot = this.bot();
    if (!bot) {
      return;
    }
    const active = !bot.isActive;
    this.ask(
      `${active ? 'Ativar' : 'Desativar'} ${bot.displayName}?`,
      active ? 'Os tokens ativos deste bot voltam a funcionar.' : 'Os tokens deste bot param de funcionar, na API e no MCP, até ele ser ativado de novo.',
      active ? 'Ativar' : 'Desativar',
      active ? 'primary' : 'danger',
      () =>
        this.run(
          () => this.api.setActive(bot.id, active),
          active ? 'Bot ativado.' : 'Bot desativado.',
          active ? 'Não foi possível confirmar a ativação.' : 'Não foi possível confirmar a desativação.',
        ),
    );
  }

  /** **MCP** (§6.2): switches at once; a refusal puts the box back. */
  protected switchMcp(event: Event): void {
    const box = event.target as HTMLInputElement;
    const enabled = box.checked;
    const id = this.id();
    this.clearMessages();
    this.run(
      () => this.api.setMcp(id, enabled),
      enabled ? 'MCP ligado.' : 'MCP desligado.',
      'Não foi possível confirmar a mudança no MCP.',
      () => (box.checked = this.bot()?.mcpEnabled ?? false),
    );
  }

  protected chooseRate(own: boolean): void {
    this.ownRate.set(own);
    this.rateTried.set(false);
  }

  protected typedRate(event: Event): void {
    this.rate.set((event.target as HTMLInputElement).value);
  }

  /** **Salvar limite**: the number from 1 to 600, or the server's default. */
  protected saveRate(): void {
    this.rateTried.set(true);
    if (this.ownRate() && rateProblem(this.rate()) !== null) {
      return;
    }
    const id = this.id();
    const callsPerMinute = this.ownRate() ? Number(this.rate().trim()) : null;
    this.clearMessages();
    this.run(() => this.api.setRate(id, callsPerMinute), 'Limite salvo.', 'Não foi possível confirmar o limite.');
  }

  protected newToken(): void {
    const bot = this.bot();
    if (!bot) {
      return;
    }
    this.clearMessages();
    this.dialogs
      .open<CreatedToken | 'unconfirmed', TokenDialogData>(TokenDialog, { data: { botId: bot.id } })
      .closed.pipe(takeUntil(this.switched))
      .subscribe((result) => {
        if (!result) {
          return;
        }
        this.load(bot.id);
        if (result === 'unconfirmed') {
          this.notice.set('Não foi possível confirmar se o token foi criado. Se ele aparece abaixo, o valor se perdeu: revogue-o e crie outro.');
        } else {
          this.dialogs.open<void, SecretOnceData>(SecretOnceDialog, {
            data: {
              title: `Token ${result.token.label} de ${bot.name}`,
              label: 'Token',
              value: result.value,
              note: 'Este token aparece só agora. Guarde-o no cofre da integração.',
            },
          });
        }
      });
  }

  protected revoke(token: BotToken): void {
    const id = this.id();
    this.ask(`Revogar o token ${token.label}?`, 'As integrações que usam este token param de funcionar na hora.', 'Revogar', 'danger', () =>
      this.run(() => this.api.revokeToken(id, token.id), 'Token revogado.', 'Não foi possível confirmar a revogação.'),
    );
  }

  private show(bot: VersionedBot): void {
    this.bot.set(bot);
    this.loadError.set(null);
    this.ownRate.set(bot.mcpCallsPerMinute !== null);
    this.rate.set(bot.mcpCallsPerMinute === null ? '' : String(bot.mcpCallsPerMinute));
    this.rateTried.set(false);
  }

  private ask(title: string, message: string, confirmLabel: string, tone: 'primary' | 'danger', then: () => void): void {
    this.clearMessages();
    this.dialogs
      .confirm({ title, message, confirmLabel, tone })
      .pipe(takeUntil(this.switched))
      .subscribe((confirmed) => confirmed && then());
  }

  private run(request: () => Observable<unknown>, done: string, unconfirmed: string, revert?: () => void): void {
    const id = this.id();
    this.busy.set(true);
    this.actionError.set(null);
    request()
      .pipe(takeUntil(this.switched))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toasts.show({ tone: 'success', message: done });
          this.load(id);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          revert?.();
          const problem = isApiProblem(error) ? error : null;
          this.actionError.set(
            problem && offersRetry(problem) ? { text: unconfirmed, retry: () => this.run(request, done, unconfirmed, revert) } : { text: messageFor(problem?.code ?? 'unexpected') },
          );
        },
      });
  }

  private open(id: string): void {
    this.switched.next();
    this.bot.set(null);
    this.loadError.set(null);
    this.busy.set(false);
    this.clearMessages();
    this.load(id);
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
