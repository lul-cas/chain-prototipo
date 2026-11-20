import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionService } from '../../../core/session/session.service';
import { storable } from '../../../core/text/storable';
import { Button } from '../../../ui/button/button';
import { FormField } from '../../../ui/form-field/form-field';
import { Input } from '../../../ui/form-field/input';
import { AutomationResources } from '../automations-api';
import { typeLabel } from '../editor/type-labels';
import { LocalProblem, isKey } from './automation-checks';
import { AutomationDocument, METHODS } from './automation-document';
import { AutomationDraftEditor } from './automation-draft-editor';
import { EditorRow } from './automation-edits';
import { callProblems } from './call-checks';
import { AuthKind, BodyKind, DestinationView } from './call-edits';
import { InsertChoice, InsertMenu } from './insert-menu';
import { SectionControl } from './section-control';

const SCALAR_TYPES = ['text', 'number', 'boolean', 'date', 'datetime', 'time'];
const WHOLE_TEMPLATE = /^\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}$/;
const PLACEHOLDER = /\{\{secret:([a-z0-9][a-z0-9_.-]{0,63})\}\}/g;
const UNSTORABLE = 'O texto tem caracteres que não podem ser guardados, e não foi gravado.';

/** A query parameter or a header as its row draws it (§7.3). */
interface Row {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly value: string;
  /** The path its problems use: `request.query.{name}` or `request.headers.{name}`. */
  readonly path: string;
  readonly nameProblem: string | null;
  readonly valueProblem: string | null;
}

/** A query row: its value is a fixed text, or an input written as `{chave}`. */
interface QueryRow extends Row {
  readonly kind: 'literal' | 'input';
  /** The input a value of kind `input` names. */
  readonly key: string | null;
  /** Whether that input is one the value can name, so the choice offers it. */
  readonly known: boolean;
}

/** A header row, with the credentials its value names (§7.8). */
interface HeaderRow extends Row {
  readonly credentials: string | null;
}

/**
 * *Chamada* (automation-ui.md §7.3, §7.8, §12.4 AS4b): the destination, the host, the method, the path with **Inserir
 * entrada**, the query, the headers and the authentication with **Inserir credencial**, and the body, edited through
 * `AutomationDraftEditor`. A text field is one change when it loses the focus (§7.7). The local checks show at their controls
 * (§7.9).
 */
@Component({
  selector: 'chain-automation-call',
  imports: [Button, FormField, Input, InsertMenu, RouterLink, SectionControl],
  templateUrl: './automation-call.html',
  styleUrls: ['./automation-sections.css', './automation-call.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationCall {
  readonly document = input.required<AutomationDocument>();
  readonly resources = input<AutomationResources | null>(null);

  protected readonly editor = inject(AutomationDraftEditor);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionService);
  protected readonly isAdmin = computed(() => this.session.user()?.isAdmin === true);
  protected readonly methods = METHODS;
  /**
   * Where each field's caret was when it lost the focus, by field. Writing a committed text back into its field moves the
   * caret to the end, so the Inserir menus read this instead.
   */
  private readonly carets = new Map<string, readonly [number, number]>();
  /** Fields whose last text wasn't written, since the API can't store it (§7.7), by field. */
  private readonly unstorable = signal<ReadonlySet<string>>(new Set());

  protected readonly problems = computed(() => callProblems(this.document(), this.resources()));
  protected readonly destinations = computed(() => this.resources()?.destinations ?? []);
  protected readonly destination = computed(() => this.destinations().find((candidate) => candidate.name === this.document().request.destination) ?? null);
  /** The destination named but not offered: one that no longer exists, while `/resources` is loaded (§7.3). */
  protected readonly missing = computed(() => {
    const name = this.document().request.destination;
    return name !== '' && this.resources() !== null && this.destination() === null;
  });
  protected readonly wildcard = computed(() => this.destination()?.host.startsWith('*.') ?? false);
  protected readonly hostShown = computed(() => this.wildcard() || this.document().request.host !== undefined);
  /** What the path is appended to: the destination's address, with the host the document names for a wildcard. */
  protected readonly address = computed(() => {
    const destination = this.destination();
    if (destination === null) {
      return null;
    }
    const host = this.wildcard() ? (this.document().request.host ?? destination.host) : destination.host;
    return `${destination.scheme}://${host}${destination.port === null ? '' : `:${destination.port}`}`;
  });
  /** The inputs that fit a path or a query value: scalar ones, by well-formed key, first occurrence first (§7.3). */
  protected readonly scalarInputs = computed(() => {
    const seen = new Set<string>();
    return this.document().inputs.filter(({ key, type }) => {
      const fits = isKey(key) && !seen.has(key) && SCALAR_TYPES.includes(type);
      seen.add(key);
      return fits;
    });
  });
  protected readonly pathChoices = computed<readonly InsertChoice[]>(() =>
    this.scalarInputs().map(({ key, type }) => ({ value: key, label: `{${key}}`, hint: typeLabel(type) })),
  );
  /** Inserir credencial (§7.8): every credential, with its description; one that doesn't allow the destination can't be taken. */
  protected readonly credentialChoices = computed<readonly InsertChoice[]>(() => {
    const destination = this.destination();
    if (destination === null) {
      return [];
    }
    return (this.resources()?.secrets ?? []).map((secret) => ({
      value: secret.name,
      label: secret.name,
      hint: secret.description,
      refusal: secret.allowedDestinations.includes(destination.name) ? null : `Não permite o destino ${destination.name}. Peça a um administrador.`,
    }));
  });
  protected readonly credentialEmpty = computed(() => (this.destination() === null ? 'Escolha o destino primeiro.' : 'Nenhuma credencial cadastrada.'));
  protected readonly queryRows = computed<readonly QueryRow[]>(() => {
    const scalar = new Set(this.scalarInputs().map((candidate) => candidate.key));
    return this.rows(this.editor.draft().query, 'request.query', 'Outro parâmetro já tem este nome.').map((row) => {
      const template = WHOLE_TEMPLATE.exec(row.value);
      return { ...row, kind: template !== null ? 'input' : 'literal', key: template?.[1] ?? null, known: template !== null && scalar.has(template[1]) };
    });
  });
  protected readonly headerRows = computed<readonly HeaderRow[]>(() =>
    this.rows(this.editor.draft().headers, 'request.headers', 'Outro cabeçalho já tem este nome.').map((row) => ({
      ...row,
      credentials: this.credentialsIn(row.value),
    })),
  );
  protected readonly authKind = computed<AuthKind | null>(() => {
    const auth = this.document().request.auth;
    return auth === null ? 'none' : auth.type === 'basic' ? 'basic' : null;
  });
  protected readonly bodyKind = computed<BodyKind | null>(() => {
    const body = this.document().request.body;
    return body === null ? 'none' : body.type !== 'json' ? null : body.keys === undefined ? 'all' : 'some';
  });
  /** *Só estas*: the inputs in their order, then the keys the list names that no input has, so they can be unchecked. */
  protected readonly bodyChoices = computed(() => {
    const keys = this.document().request.body?.keys ?? [];
    const inputs = this.document()
      .inputs.map((input) => input.key)
      .filter((key, i, all) => isKey(key) && all.indexOf(key) === i);
    const problems = this.problems();
    return [...inputs, ...keys.filter((key, i) => !inputs.includes(key) && keys.indexOf(key) === i)].map((key) => {
      const index = keys.indexOf(key);
      return {
        key,
        checked: index >= 0,
        path: index >= 0 ? `request.body.keys[${index}]` : null,
        problem: problems.find((problem) => problem.path.startsWith('request.body.keys[') && keys[Number(/\[(\d+)\]/.exec(problem.path)![1])] === key)?.text ?? null,
      };
    });
  });
  /** GET or DELETE with a body (AU003), and a body that isn't JSON (AU009), under Corpo. */
  protected readonly bodyProblem = computed(() => this.joined([this.problemAt('request.body'), this.problemAt('request.body.type')]));
  /** Both fields missing, or beside an Authorization header (AU008), and a type other than basic, under Autenticação. */
  protected readonly authProblem = computed(() => this.joined([this.problemAt('request.auth'), this.problemAt('request.auth.type')]));

  /** Every local problem at a path, as one text; with `field`, also says when its last text wasn't written. */
  protected problemAt(path: string, field?: string): string | null {
    const texts = [field && this.unstorable().has(field) ? UNSTORABLE : null, ...this.problems().filter((problem: LocalProblem) => problem.path === path).map((problem) => problem.text)];
    return this.joined(texts);
  }

  /** Below a field that holds credentials, their names and descriptions (§7.8). */
  protected credentialsIn(text: string): string | null {
    const secrets = this.resources()?.secrets ?? [];
    const named = [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]))].flatMap((name) => {
      const secret = secrets.find((candidate) => candidate.name === name);
      return secret === undefined ? [] : [secret.description ? `Credencial ${name}: ${secret.description}` : `Credencial ${name}.`];
    });
    return named.length > 0 ? named.join(' ') : null;
  }

  protected destinationHint(): string | null {
    return this.destination()?.description ?? null;
  }

  protected hostHint(): string | null {
    const host = this.destination()?.host;
    return host?.startsWith('*.') ? `Um subdomínio de ${host}, como api${host.slice(1)}` : null;
  }

  protected label(destination: DestinationView): string {
    return `${destination.name}: ${destination.scheme}://${destination.host}${destination.port === null ? '' : `:${destination.port}`}`;
  }

  protected setDestination(event: Event): void {
    const name = (event.target as HTMLSelectElement).value;
    this.editor.setDestination(name, this.destinations().find((candidate) => candidate.name === name) ?? null);
  }

  protected setMethod(event: Event): void {
    this.editor.setMethod((event.target as HTMLSelectElement).value);
  }

  protected setHost(event: Event): void {
    this.written('host', (event.target as HTMLInputElement).value, (host) => this.editor.setHost(host));
  }

  protected setPath(event: Event): void {
    this.written('path', (event.target as HTMLInputElement).value, (path) => this.editor.setPath(path));
  }

  /** Remembers a field's caret as it loses the focus, for the Inserir menus. */
  protected keepCaret(field: string, event: Event): void {
    const element = event.target as HTMLInputElement;
    this.carets.set(field, [element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length]);
  }

  /** Inserir entrada (§7.3): `{chave}` in the path. */
  protected insertInPath(key: string): void {
    this.insert('path', `{${key}}`, (path) => this.editor.setPath(path));
  }

  /** Inserir credencial (§7.8): `{{secret:name}}` in a header's value, the username or the password. */
  protected insertCredential(field: string, name: string): void {
    const placeholder = `{{secret:${name}}}`;
    if (field.startsWith('header:')) {
      const id = field.slice('header:'.length);
      this.insert(field, placeholder, (value) => this.editor.setHeaderValue(id, value));
    } else {
      this.insert(field, placeholder, (value) => this.editor.setAuthField(field === 'auth:username' ? 'username' : 'password', value));
    }
  }

  protected addQueryRow(): void {
    const id = this.editor.addQueryRow();
    this.focusAfterRender(`[data-row-name="${id}"]`);
  }

  protected removeQueryRow(id: string): void {
    this.removeRow(this.editor.draft().query, id, '.chain-call__add-query', () => this.editor.removeQueryRow(id));
  }

  protected setQueryName(id: string, event: Event): void {
    this.written(`name:${id}`, (event.target as HTMLInputElement).value, (name) => this.editor.setQueryName(id, name));
  }

  protected setQueryValue(id: string, event: Event): void {
    this.written(`value:${id}`, (event.target as HTMLInputElement | HTMLSelectElement).value, (value) => this.editor.setQueryValue(id, value));
  }

  /** *Texto fixo* starts empty; *Entrada* takes the first input that fits, when there is one (§7.3). */
  protected setQueryKind(id: string, event: Event): void {
    const kind = (event.target as HTMLSelectElement).value;
    if (kind === 'literal') {
      this.editor.setQueryValue(id, '');
      return;
    }
    const first = this.scalarInputs()[0];
    if (first === undefined) {
      this.editor.refuse('Nenhuma entrada cabe na consulta: só entradas de texto, número, sim ou não, data, data e hora ou hora.');
      (event.target as HTMLSelectElement).value = 'literal';
      return;
    }
    this.editor.setQueryValue(id, `{${first.key}}`);
  }

  protected addHeaderRow(): void {
    const id = this.editor.addHeaderRow();
    if (id !== null) {
      this.focusAfterRender(`[data-row-name="${id}"]`);
    }
  }

  protected removeHeaderRow(id: string): void {
    this.removeRow(this.editor.draft().headers, id, '.chain-call__add-header', () => this.editor.removeHeaderRow(id));
  }

  protected setHeaderName(id: string, event: Event): void {
    this.written(`name:${id}`, (event.target as HTMLInputElement).value, (name) => this.editor.setHeaderName(id, name));
  }

  protected setHeaderValue(id: string, event: Event): void {
    this.written(`header:${id}`, (event.target as HTMLInputElement).value, (value) => this.editor.setHeaderValue(id, value));
  }

  protected setAuth(event: Event): void {
    this.editor.setAuth((event.target as HTMLSelectElement).value as AuthKind);
  }

  protected setAuthField(field: 'username' | 'password', event: Event): void {
    this.written(`auth:${field}`, (event.target as HTMLInputElement).value, (value) => this.editor.setAuthField(field, value));
  }

  protected setBody(event: Event): void {
    this.editor.setBody((event.target as HTMLSelectElement).value as BodyKind);
  }

  protected setBodyKey(key: string, event: Event): void {
    this.editor.setBodyKey(key, (event.target as HTMLInputElement).checked);
  }

  /** The rows of the query or the headers, with their problems split between the name and the value. */
  private rows(rows: readonly EditorRow[], prefix: string, repeatedText: string): Row[] {
    const problems = this.problems();
    const unstorable = this.unstorable();
    return rows.map((row, index) => {
      const path = `${prefix}.${row.name}`;
      // The document keeps the last of two rows with one name, so the problems for that name are the last row's.
      const last = !rows.some((other, i) => i > index && other.name === row.name);
      const repeated = rows.findIndex((other) => other.name === row.name) !== index;
      const found = last ? problems.filter((problem) => problem.path === path) : [];
      return {
        id: row.id,
        index,
        name: row.name,
        value: row.value,
        path,
        nameProblem: this.joined([
          unstorable.has(`name:${row.id}`) ? UNSTORABLE : null,
          repeated ? repeatedText : null,
          ...found.filter((problem) => problem.part === 'name').map((problem) => problem.text),
        ]),
        valueProblem: this.joined([
          unstorable.has(`value:${row.id}`) || unstorable.has(`header:${row.id}`) ? UNSTORABLE : null,
          ...found.filter((problem) => problem.part !== 'name').map((problem) => problem.text),
        ]),
      };
    });
  }

  /** Removes a row; the focus goes to the next row's name, else the previous one's, else the add button. */
  private removeRow(rows: readonly EditorRow[], id: string, add: string, remove: () => void): void {
    const index = rows.findIndex((row) => row.id === id);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    remove();
    this.focusAfterRender(neighbour ? `[data-row-name="${neighbour.id}"]` : add);
  }

  /** Puts a text at a field's remembered caret, or in place of its selection, as one change; the caret follows it. */
  private insert(field: string, text: string, write: (value: string) => void): void {
    const element = this.host.nativeElement.querySelector<HTMLInputElement>(`[data-caret="${field}"]`);
    if (element === null) {
      return;
    }
    const [start, end] = this.carets.get(field) ?? [element.value.length, element.value.length];
    const value = element.value.slice(0, start) + text + element.value.slice(end);
    element.value = value;
    write(value);
    afterNextRender(
      () => {
        element.focus();
        element.setSelectionRange(start + text.length, start + text.length);
        this.carets.delete(field);
      },
      { injector: this.injector },
    );
  }

  /** Writes a text field's value, unless the API can't store it: then the field says so and keeps the text (§7.7). */
  private written(field: string, text: string, write: (text: string) => void): void {
    if (!storable(text)) {
      this.unstorable.update((fields) => new Set(fields).add(field));
      this.editor.refuse('O texto não foi gravado: ele tem caracteres que não podem ser guardados.');
      return;
    }
    if (this.unstorable().has(field)) {
      this.unstorable.update((fields) => new Set([...fields].filter((other) => other !== field)));
    }
    write(text);
  }

  private joined(texts: readonly (string | null)[]): string | null {
    return texts.filter((text) => text !== null).join(' ') || null;
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), { injector: this.injector });
  }
}
