import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LucideCheck, LucideX } from '@lucide/angular';
import { Alert } from '../alert/alert';
import { TONE_LABEL, Tone } from '../alert/tone';
import { BrandMark } from '../brand/brand-mark';
import { Button } from '../button/button';
import { DialogService } from '../dialog/dialog.service';
import { FormField } from '../form-field/form-field';
import { Input } from '../form-field/input';
import { PasswordField } from '../form-field/password-field';
import { NavItem } from '../shell/nav-item';
import { Shell } from '../shell/shell';
import { ThemeSwitch } from '../theme/theme-switch';
import { ToastService } from '../toast/toast.service';

@Component({
  selector: 'chain-design-page',
  imports: [
    Shell,
    NavItem,
    BrandMark,
    ThemeSwitch,
    Button,
    FormField,
    Input,
    PasswordField,
    Alert,
    LucideCheck,
    LucideX,
  ],
  template: `
    <chain-shell>
      <a chainShellBrand href="#topo">
        <chain-brand-mark wordmark />
      </a>
      <chain-theme-switch chainShellActions />
      <ng-container chainShellNav>
        @for (item of nav; track item.href) {
          <a chainNavItem [href]="item.href">{{ item.label }}</a>
        }
      </ng-container>

      <div class="chain-design" id="topo">
        <header class="chain-design__intro">
          <p class="chain-eyebrow">Identidade</p>
          <h1 class="chain-design__title">Sistema de design</h1>
          <p>
            Papel quente, tinta ultramarina e um fio de tinta no topo da janela. Esta página existe só no
            ambiente de desenvolvimento, para revisar a identidade antes das telas de entrada.
          </p>
        </header>

        <section class="chain-design__section" id="temas" aria-labelledby="temas-titulo">
          <h2 id="temas-titulo">Temas</h2>
          <p>O tema segue o sistema e pode ser trocado aqui. A faixa abaixo mostra os dois ao mesmo tempo.</p>
          <div class="chain-design__themes" aria-hidden="true">
            <div class="chain-design__pane" data-theme="light">
              <p class="chain-eyebrow">Claro</p>
              <p>Texto sobre papel.</p>
              <p class="chain-design__muted">Texto secundário para dicas e metadados.</p>
              <span class="chain-design__fake">Ação</span>
            </div>
            <div class="chain-design__pane" data-theme="dark">
              <p class="chain-eyebrow">Escuro</p>
              <p>Texto sobre grafite.</p>
              <p class="chain-design__muted">Texto secundário para dicas e metadados.</p>
              <span class="chain-design__fake">Ação</span>
            </div>
          </div>
        </section>

        <section class="chain-design__section" id="cores" aria-labelledby="cores-titulo">
          <h2 id="cores-titulo">Cores</h2>
          <p>Uma rampa neutra quente e uma rampa de tinta. As demais servem a estado e a tipo de nó.</p>
          @for (ramp of ramps; track ramp.id) {
            <div>
              <p class="chain-eyebrow">{{ ramp.label }}</p>
              <div class="chain-design__ramp">
                @for (step of steps; track step) {
                  <div class="chain-design__swatch">
                    <div
                      class="chain-design__chip"
                      [style.background]="'var(--chain-color-' + ramp.id + '-' + step + ')'"
                    ></div>
                    <span class="chain-design__step">{{ step }}</span>
                  </div>
                }
              </div>
            </div>
          }
        </section>

        <section class="chain-design__section" id="tipo" aria-labelledby="tipo-titulo">
          <h2 id="tipo-titulo">Tipografia</h2>
          <div class="chain-design__stack">
            @for (step of typeSteps; track step.id) {
              <p
                [style.font-size]="'var(--chain-font-size-' + step.id + ')'"
                [style.line-height]="'var(--chain-line-height-' + step.id + ')'"
              >
                <span class="chain-design__step">{{ step.id }}</span>
                {{ step.sample }}
              </p>
            }
            <p class="chain-mono">solicitacao-1842 · grupo.financeiro</p>
          </div>
        </section>

        <section class="chain-design__section" id="espaco" aria-labelledby="espaco-titulo">
          <h2 id="espaco-titulo">Espaço, raio e sombra</h2>
          <div class="chain-design__row">
            @for (radius of radii; track radius) {
              <div
                class="chain-design__radius"
                [style.border-radius]="'var(--chain-radius-' + radius + ')'"
              >
                <span class="chain-design__step">{{ radius }}</span>
              </div>
            }
          </div>
          <div class="chain-design__grid">
            <div class="chain-design__shadow chain-design__shadow--raised">Cartão</div>
            <div class="chain-design__shadow chain-design__shadow--popover">Menu</div>
            <div class="chain-design__shadow chain-design__shadow--dialog">Diálogo</div>
          </div>
        </section>

        <section class="chain-design__section" id="botoes" aria-labelledby="botoes-titulo">
          <h2 id="botoes-titulo">Botões</h2>
          <div class="chain-design__row">
            <button chainButton type="button">Salvar</button>
            <button chainButton variant="secondary" type="button">Cancelar</button>
            <button chainButton variant="ghost" type="button">Voltar</button>
            <button chainButton variant="danger" type="button">Excluir</button>
            <button chainButton variant="secondary" size="sm" type="button">Pequeno</button>
            <button chainButton type="button" disabled>Indisponível</button>
            <button chainButton type="button" [loading]="busy()">Concluir</button>
            <button chainButton variant="secondary" type="button" (click)="busy.set(!busy())">Alternar espera</button>
          </div>
        </section>

        <section class="chain-design__section" id="campos" aria-labelledby="campos-titulo">
          <h2 id="campos-titulo">Campos</h2>
          <div class="chain-design__stack">
            <chain-form-field
              label="Nome de usuário"
              hint="Letras minúsculas, números, ponto, _ e -."
              [error]="usernameError()"
              required
            >
              <input chainInput type="text" autocomplete="username" (input)="onUsername($event)" />
            </chain-form-field>
            <chain-form-field label="Senha" hint="No mínimo 12 caracteres." required>
              <chain-password-field>
                <input chainInput type="password" autocomplete="current-password" />
              </chain-password-field>
            </chain-form-field>
            <chain-form-field label="Identificador">
              <input chainInput class="chain-mono" type="text" value="solicitacao-1842" disabled />
            </chain-form-field>
          </div>
        </section>

        <section class="chain-design__section" id="mensagens" aria-labelledby="mensagens-titulo">
          <h2 id="mensagens-titulo">Mensagens</h2>
          <div class="chain-design__stack">
            <chain-alert tone="info" title="Rascunho salvo">Você pode continuar depois.</chain-alert>
            <chain-alert tone="success" title="Tarefa concluída">A solicitação seguiu para o próximo grupo.</chain-alert>
            <chain-alert tone="warning" title="Prazo próximo">Esta tarefa vence hoje.</chain-alert>
            <chain-alert tone="danger" title="Não foi possível salvar">Verifique os campos e tente de novo.</chain-alert>
          </div>
        </section>

        <section class="chain-design__section" id="dialogo" aria-labelledby="dialogo-titulo">
          <h2 id="dialogo-titulo">Diálogo e avisos</h2>
          <div class="chain-design__row">
            <button chainButton type="button" (click)="ask()">Abrir diálogo</button>
            @for (tone of tones; track tone) {
              <button chainButton variant="secondary" type="button" (click)="notify(tone)">
                Aviso de {{ toneLabel[tone] }}
              </button>
            }
          </div>
        </section>

        <section class="chain-design__section" id="fluxo" aria-labelledby="fluxo-titulo">
          <h2 id="fluxo-titulo">Fluxo</h2>
          <p>Cada tipo de nó tem uma cor. O caminho verdadeiro e o falso também levam um sinal.</p>
          <div class="chain-design__row">
            @for (kind of nodeKinds; track kind.id) {
              <span
                class="chain-design__node"
                [style.background]="'var(--color-node-' + kind.id + '-bg)'"
                [style.color]="'var(--color-node-' + kind.id + '-fg)'"
                >{{ kind.label }}</span
              >
            }
          </div>
          <div class="chain-design__row">
            <span class="chain-design__flow" [style.color]="'var(--color-flow)'">Sequência</span>
            <span class="chain-design__flow" [style.color]="'var(--color-flow-true)'">
              <svg lucideCheck aria-hidden="true"></svg>
              Verdadeiro
            </span>
            <span class="chain-design__flow" [style.color]="'var(--color-flow-false)'">
              <svg lucideX aria-hidden="true"></svg>
              Falso
            </span>
          </div>
          <div
            class="chain-design__lane"
            [style.background]="'var(--color-node-lane-bg)'"
            [style.border-color]="'var(--color-node-lane-border)'"
          >
            <span
              class="chain-design__lane-band"
              [style.background]="'var(--color-node-lane-band)'"
              [style.color]="'var(--color-node-lane-band-fg)'"
              >Financeiro</span
            >
            <span class="chain-design__handle" [style.background]="'var(--color-handle)'"></span>
          </div>
        </section>

        <section class="chain-design__section" id="icones" aria-labelledby="icones-titulo">
          <h2 id="icones-titulo">Ícones</h2>
          <p>Lucide, um ícone por importação. O significado está no texto, não só no desenho.</p>
          <div class="chain-design__row">
            <span class="chain-design__flow"><svg lucideCheck aria-hidden="true"></svg> Confirmar</span>
            <span class="chain-design__flow"><svg lucideX aria-hidden="true"></svg> Fechar</span>
          </div>
        </section>
      </div>
    </chain-shell>
  `,
  styleUrl: './design-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignPage {
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);

  protected readonly busy = signal(false);
  protected readonly usernameError = signal<string | null>(null);
  protected readonly toneLabel = TONE_LABEL;
  protected readonly tones: readonly Tone[] = ['info', 'success', 'warning', 'danger'];
  protected readonly steps = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '850', '900', '950'] as const;
  protected readonly ramps = [
    { id: 'neutral', label: 'Neutro' },
    { id: 'ink', label: 'Tinta' },
    { id: 'green', label: 'Verde' },
    { id: 'amber', label: 'Âmbar' },
    { id: 'red', label: 'Vermelho' },
    { id: 'sky', label: 'Céu' },
    { id: 'plum', label: 'Ameixa' },
  ] as const;
  protected readonly typeSteps = [
    { id: 'xs', sample: 'Metadado' },
    { id: 'sm', sample: 'Dica de campo' },
    { id: 'md', sample: 'Texto de leitura' },
    { id: 'lg', sample: 'Título de diálogo' },
    { id: 'xl', sample: 'Título de seção' },
    { id: '2xl', sample: 'Título de página' },
    { id: '3xl', sample: 'Chain' },
  ] as const;
  protected readonly radii = ['none', 'sm', 'md', 'lg', 'full'] as const;
  protected readonly nav = [
    { href: '#cores', label: 'Cores' },
    { href: '#tipo', label: 'Tipografia' },
    { href: '#espaco', label: 'Espaço' },
    { href: '#botoes', label: 'Botões' },
    { href: '#campos', label: 'Campos' },
    { href: '#mensagens', label: 'Mensagens' },
    { href: '#dialogo', label: 'Diálogo' },
    { href: '#fluxo', label: 'Fluxo' },
  ] as const;
  protected readonly nodeKinds = [
    { id: 'start', label: 'Início' },
    { id: 'task', label: 'Etapa' },
    { id: 'automatic', label: 'Etapa automática' },
    { id: 'subworkflow', label: 'Subprocesso' },
    { id: 'gateway', label: 'Condicional' },
    { id: 'end', label: 'Fim' },
    { id: 'lane', label: 'Área' },
  ] as const;

  protected onUsername(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.usernameError.set(/\s/.test(value) ? 'O nome de usuário não pode ter espaços.' : null);
  }

  protected ask(): void {
    this.dialogs
      .confirm({
        title: 'Arquivar o grupo?',
        message: 'O grupo deixa de aparecer nas listas. As tarefas já atribuídas continuam com ele.',
        confirmLabel: 'Arquivar',
        cancelLabel: 'Voltar',
        tone: 'danger',
      })
      .subscribe();
  }

  protected notify(tone: Tone): void {
    const messages: Record<Tone, string> = {
      info: 'Rascunho salvo.',
      success: 'Tarefa concluída.',
      warning: 'Esta tarefa vence hoje.',
      danger: 'Não foi possível salvar.',
    };
    this.toasts.show({ tone, message: messages[tone] });
  }
}
