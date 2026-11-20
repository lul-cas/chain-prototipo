import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { errorCodes, isApiProblem } from '../../../core/http/api-problem';
import { offersRetry } from '../../../core/http/command-key';
import { messageFor } from '../../../core/http/messages';
import { Alert } from '../../../ui/alert/alert';
import { Button } from '../../../ui/button/button';
import { DialogLayout } from '../../../ui/dialog/dialog-layout';
import { DialogService } from '../../../ui/dialog/dialog.service';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { InUseData, InUseDialog } from '../in-use-dialog';
import { destinationInUse } from './destination-in-use';
import { DEFAULT_MAX_BYTES, DestinationSettings, SizeUnit, addressText, bytesOf, destinationProblems, sizeParts } from './destination-rules';
import { DestinationsApi, VersionedDestination, usageOf } from './destinations-api';

export interface DestinationPanelData {
  /** The destination to edit, or null for a new one. */
  readonly destination: VersionedDestination | null;
}

/** What the panel closes with: the saved destination, or, after a retry it could not confirm, what the list should say. */
export type PanelResult = { readonly saved: VersionedDestination } | { readonly uncertain: string };

type Field = 'name' | 'description' | 'scheme' | 'secretsOverHttp' | 'host' | 'port' | 'pathPrefix' | 'requestSize' | 'responseSize';

/** The API's codes at their fields, in pt-BR (automation-ui.md §3.4). */
const MESSAGES: Readonly<Record<string, readonly [Field, string]>> = {
  invalid_name: ['name', 'Use até 64 caracteres: letras minúsculas sem acento, dígitos, _, . ou -, começando por letra ou dígito.'],
  destination_name_taken: ['name', 'Já existe um destino com este nome.'],
  description_too_long: ['description', 'A descrição pode ter no máximo 500 caracteres.'],
  invalid_description: ['description', 'A descrição tem caracteres que não podem ser guardados.'],
  invalid_scheme: ['scheme', 'Escolha HTTPS ou HTTP.'],
  http_requires_internal: ['scheme', 'HTTP só é permitido em destinos internos.'],
  secrets_over_http_requires_http: ['secretsOverHttp', 'Só se aplica a destinos HTTP.'],
  invalid_host: ['host', 'Use um nome em minúsculas, sem esquema, porta ou caminho, ou *. e um domínio de pelo menos dois níveis. Endereços IP não são aceitos.'],
  invalid_port: ['port', 'Use uma porta de 1 a 65535, ou deixe vazio.'],
  invalid_path_prefix: ['pathPrefix', 'O prefixo começa com /, tem até 500 caracteres e não tem .., ?, #, %2F nem espaços.'],
  invalid_max_request_bytes: ['requestSize', 'Use de 1 KiB a 10 MiB, ou deixe vazio.'],
  invalid_max_response_bytes: ['responseSize', 'Use de 1 KiB a 10 MiB, ou deixe vazio.'],
};
const UNCONFIRMED = 'Não foi possível confirmar a tentativa anterior. Os dados abaixo são os atuais.';

interface Size {
  readonly amount: string;
  readonly unit: SizeUnit;
}

/**
 * Novo destino, or a destination's settings (automation-ui.md §3.2), in the side panel. The rules of automation.md §3.1 are
 * checked as the admin types, and the server's answer wins. An edit sends every setting with `If-Match`, since `PUT` resets
 * an absent one; a change that would break published versions asks before it is forced (Q-AS3 (a)).
 */
@Component({
  selector: 'chain-destination-panel',
  imports: [Alert, Button, DialogLayout, FormField, Input],
  template: `
    <chain-dialog [title]="editing ? 'Destino ' + name() : 'Novo destino'">
      <form id="chain-destination-form" class="chain-destination" (submit)="save($event)">
        <chain-form-field label="Nome" required [hint]="nameHint" [error]="error('name')">
          <input chainInput class="chain-mono" type="text" [value]="name()" [readOnly]="editing" (input)="name.set(text($event))" />
        </chain-form-field>
        <chain-form-field label="Descrição" [hint]="description().length + '/500 caracteres'" [error]="error('description')">
          <textarea chainInput rows="2" [value]="description()" (input)="description.set(text($event))"></textarea>
        </chain-form-field>
        <chain-form-field label="Esquema" [error]="error('scheme')">
          <select chainInput (change)="scheme.set(text($event))">
            <option value="https" [selected]="scheme() === 'https'">HTTPS</option>
            <option value="http" [selected]="scheme() === 'http'">HTTP</option>
          </select>
        </chain-form-field>
        <chain-form-field label="Host" required [hint]="hostHint" [error]="error('host')">
          <input chainInput class="chain-mono" type="text" [value]="host()" (input)="setHost($event)" />
        </chain-form-field>
        <chain-form-field label="Porta" [error]="error('port')">
          <input chainInput type="text" inputmode="numeric" [value]="port()" (input)="port.set(text($event))" />
        </chain-form-field>
        <chain-form-field label="Prefixo do caminho" hint="As automações só chamam caminhos que começam com ele." [error]="error('pathPrefix')">
          <input chainInput class="chain-mono" type="text" [value]="pathPrefix()" (input)="pathPrefix.set(text($event))" />
        </chain-form-field>
        <label class="chain-destination__check">
          <input type="checkbox" [checked]="internal()" (change)="internal.set(checked($event))" />
          Interno
        </label>
        <p class="chain-destination__hint">Permite endereços de rede privada só para este host. Endereços locais (loopback) e de link-local continuam bloqueados.</p>
        @if (scheme() === 'http') {
          <label class="chain-destination__check">
            <input type="checkbox" [checked]="secretsOverHttp()" (change)="secretsOverHttp.set(checked($event))" />
            Aceitar credenciais por HTTP
          </label>
          <p class="chain-destination__warning">As credenciais vão sem criptografia pela rede.</p>
          @if (error('secretsOverHttp'); as message) {
            <p class="chain-destination__error">{{ message }}</p>
          }
        }
        @for (size of sizes; track size.field) {
          <chain-form-field [label]="size.label" hint="De 1 KiB a 10 MiB; vazio é o padrão, 1 MiB." [error]="error(size.field)">
            <span class="chain-destination__size">
              <input chainInput type="text" inputmode="numeric" [value]="size.value().amount" (input)="setAmount(size.field, $event)" />
              <select chainInput [attr.aria-label]="size.label + ': unidade'" (change)="setUnit(size.field, $event)">
                @for (unit of units; track unit) {
                  <option [value]="unit" [selected]="unit === size.value().unit">{{ unit }}</option>
                }
              </select>
            </span>
          </chain-form-field>
        }
        <p class="chain-destination__address">Endereço: <code>{{ address() }}</code></p>
        @if (editing) {
          <p class="chain-destination__hint">As mudanças valem na próxima chamada de toda automação que usa este destino, inclusive as publicadas.</p>
        }
        @if (alert(); as current) {
          <chain-alert tone="danger">
            <span class="chain-destination__alert">
              {{ current.text }}
              @if (current.action === 'reload') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="reload()">Recarregar</button>
              }
              @if (current.action === 'retry') {
                <button chainButton variant="secondary" size="sm" type="button" (click)="retry()">Tentar de novo</button>
              }
            </span>
          </chain-alert>
        }
      </form>
      <div chainDialogActions>
        <button chainButton variant="secondary" type="button" (click)="ref.close()">Cancelar</button>
        <button chainButton type="submit" form="chain-destination-form" [loading]="saving()">Salvar</button>
      </div>
    </chain-dialog>
  `,
  styles: `
    .chain-destination {
      display: flex;
      flex-direction: column;
      gap: var(--chain-space-3);
    }

    .chain-destination__check,
    .chain-destination__alert {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--chain-space-2);
    }

    .chain-destination__hint,
    .chain-destination__warning,
    .chain-destination__error,
    .chain-destination__address {
      margin: 0;
      font-size: var(--chain-font-size-sm);
    }

    .chain-destination__hint {
      color: var(--color-text-muted);
    }

    .chain-destination__warning {
      color: var(--color-status-warning-text);
    }

    .chain-destination__error {
      color: var(--color-text-danger);
    }

    .chain-destination__size {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--chain-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DestinationPanel {
  protected readonly ref = inject<DialogRef<PanelResult>>(DialogRef);
  private readonly data = inject<DestinationPanelData>(DIALOG_DATA);
  private readonly api = inject(DestinationsApi);
  private readonly dialogs = inject(DialogService);

  protected readonly editing = this.data.destination !== null;
  protected readonly nameHint = this.editing
    ? 'Não pode ser trocado.'
    : 'Letras minúsculas sem acento, dígitos, _, . ou -, começando por letra ou dígito; até 64. Não pode ser trocado depois.';
  protected readonly hostHint = 'Só o nome, sem https:// nem caminho: api.erp.example, ou *.erp.example para os subdomínios.';
  protected readonly units: readonly SizeUnit[] = ['bytes', 'KiB', 'MiB'];

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly scheme = signal('https');
  protected readonly host = signal('');
  protected readonly port = signal('');
  protected readonly pathPrefix = signal('');
  protected readonly internal = signal(false);
  protected readonly secretsOverHttp = signal(false);
  private readonly requestSize = signal<Size>({ amount: '', unit: 'MiB' });
  private readonly responseSize = signal<Size>({ amount: '', unit: 'MiB' });
  protected readonly sizes = [
    { field: 'requestSize' as const, label: 'Tamanho máximo do envio', value: this.requestSize },
    { field: 'responseSize' as const, label: 'Tamanho máximo da resposta', value: this.responseSize },
  ];
  private readonly etag = signal(this.data.destination?.etag ?? '');

  protected readonly saving = signal(false);
  protected readonly alert = signal<{ readonly text: string; readonly action?: 'reload' | 'retry' } | null>(null);
  private readonly serverCodes = signal<readonly string[]>([]);
  private pending: (() => void) | null = null;

  /** The settings as `PUT` takes them; a field that can't be read gives a value the rules refuse. */
  private readonly settings = computed<DestinationSettings>(() => ({
    description: this.description().trim() === '' ? null : this.description(),
    scheme: this.scheme(),
    host: this.host().trim(),
    port: this.port().trim() === '' ? null : /^[0-9]{1,5}$/.test(this.port().trim()) ? Number(this.port().trim()) : -1,
    pathPrefix: this.pathPrefix().trim() === '' ? null : this.pathPrefix().trim(),
    internal: this.internal(),
    allowSecretsOverHttp: this.scheme() === 'http' && this.secretsOverHttp(),
    maxRequestBytes: bytes(this.requestSize()),
    maxResponseBytes: bytes(this.responseSize()),
  }));
  private readonly localCodes = computed(() => destinationProblems(this.settings(), this.editing ? undefined : this.name()));
  protected readonly address = computed(() => addressText(this.settings()));

  constructor() {
    if (this.data.destination) {
      this.fill(this.data.destination);
    }
  }

  protected error(field: Field): string | null {
    const code = [...this.serverCodes(), ...this.localCodes()].find((candidate) => MESSAGES[candidate]?.[0] === field);
    return code ? MESSAGES[code][1] : null;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  /** The host is lowercased as it is typed (automation-ui.md §3.2). */
  protected setHost(event: Event): void {
    const input = event.target as HTMLInputElement;
    input.value = input.value.toLowerCase();
    this.host.set(input.value);
  }

  protected setAmount(field: 'requestSize' | 'responseSize', event: Event): void {
    this[field].update((size) => ({ ...size, amount: this.text(event) }));
  }

  protected setUnit(field: 'requestSize' | 'responseSize', event: Event): void {
    this[field].update((size) => ({ ...size, unit: this.text(event) as SizeUnit }));
  }

  protected save(event?: Event, force = false): void {
    event?.preventDefault();
    this.serverCodes.set([]);
    if (this.localCodes().length > 0) {
      return;
    }
    const settings = this.settings();
    const name = this.name();
    const etag = this.etag();
    this.send(() => (this.editing ? this.api.update(name, etag, settings, force) : this.api.create(name, settings)), false);
  }

  /** Tentar de novo (§8.1): the same request, with the same `If-Match`. */
  protected retry(): void {
    this.pending?.();
  }

  /** Recarregar after a 412: the current settings replace what was typed; nothing is overwritten on the server. */
  protected reload(): void {
    this.api.get(this.name()).subscribe({
      next: (destination) => {
        this.fill(destination);
        this.alert.set(null);
      },
      error: (error: unknown) => this.alert.set({ text: messageFor(isApiProblem(error) ? error.code : 'unexpected') }),
    });
  }

  private send(request: () => Observable<VersionedDestination>, retried: boolean): void {
    this.saving.set(true);
    this.alert.set(null);
    this.pending = null;
    request().subscribe({
      next: (saved) => this.ref.close({ saved }),
      error: (error: unknown) => {
        this.saving.set(false);
        const problem = isApiProblem(error) ? error : null;
        if (problem && offersRetry(problem)) {
          this.pending = () => this.send(request, true);
          this.alert.set({ text: 'Não foi possível confirmar o envio.', action: 'retry' });
        } else if (retried && (problem?.status === 412 || problem?.code === 'destination_name_taken')) {
          // The first attempt may have been applied: the list shows what the server has (§8.1).
          this.ref.close({ uncertain: problem.code === 'destination_name_taken' ? `${UNCONFIRMED} Se foi a sua tentativa anterior, ela já criou o item.` : UNCONFIRMED });
        } else if (problem?.code === 'validation_failed') {
          this.serverCodes.set(errorCodes(problem));
        } else if (problem?.code === 'destination_name_taken') {
          this.serverCodes.set([problem.code]);
        } else if (problem?.code === 'destination_in_use') {
          this.askToForce(problem);
        } else if (problem?.status === 412) {
          this.alert.set({ text: 'Este destino foi alterado depois que você o abriu.', action: 'reload' });
        } else {
          this.alert.set({ text: messageFor(problem?.code ?? 'unexpected') });
        }
      },
    });
  }

  /** A change that would break published versions: the versions and their rules, then Salvar mesmo assim (Q-AS3 (a)). */
  private askToForce(problem: Parameters<typeof usageOf>[0]): void {
    this.dialogs
      .open<boolean, InUseData>(InUseDialog, { data: destinationInUse(this.name(), usageOf(problem), 'save') })
      .closed.subscribe((force) => force && this.save(undefined, true));
  }

  private fill(destination: VersionedDestination): void {
    this.name.set(destination.name);
    this.description.set(destination.description ?? '');
    this.scheme.set(destination.scheme);
    this.host.set(destination.host);
    this.port.set(destination.port === null ? '' : String(destination.port));
    this.pathPrefix.set(destination.pathPrefix ?? '');
    this.internal.set(destination.internal);
    this.secretsOverHttp.set(destination.allowSecretsOverHttp);
    this.requestSize.set(sizeOf(destination.maxRequestBytes));
    this.responseSize.set(sizeOf(destination.maxResponseBytes));
    this.etag.set(destination.etag);
  }
}

/** A size's bytes; empty is the default (null), and an amount that isn't a whole number is refused by the rules. */
function bytes(size: Size): number | null {
  const amount = size.amount.trim();
  if (amount === '') {
    return null;
  }
  return /^[0-9]{1,9}$/.test(amount) ? bytesOf(Number(amount), size.unit) : -1;
}

/** A stored size, empty when it is the default. */
function sizeOf(value: number): Size {
  if (value === DEFAULT_MAX_BYTES) {
    return { amount: '', unit: 'MiB' };
  }
  const { amount, unit } = sizeParts(value);
  return { amount: String(amount), unit };
}
