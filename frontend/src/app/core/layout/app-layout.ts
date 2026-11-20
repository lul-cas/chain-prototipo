import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionService } from '../session/session.service';
import { BrandMark } from '../../ui/brand/brand-mark';
import { Button } from '../../ui/button/button';
import { NavGroup } from '../../ui/shell/nav-group';
import { NavItem } from '../../ui/shell/nav-item';
import { Shell } from '../../ui/shell/shell';
import { ThemeSwitch } from '../../ui/theme/theme-switch';

/** The frame of every signed-in page (identity.md, UI): the user, the theme switch, "Sair" and the navigation. */
@Component({
  selector: 'chain-app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Shell, NavGroup, NavItem, BrandMark, Button, ThemeSwitch],
  template: `
    <chain-shell>
      <a chainShellBrand routerLink="/"><chain-brand-mark wordmark /></a>
      <div chainShellActions class="chain-app-layout__actions">
        <span class="chain-app-layout__user">{{ session.user()?.displayName }}</span>
        <chain-theme-switch />
        <button chainButton variant="ghost" size="sm" type="button" [loading]="leaving()" (click)="logout()">Sair</button>
      </div>
      <ng-container chainShellNav>
        <a chainNavItem routerLink="/tarefas" routerLinkActive ariaCurrentWhenActive="page">Tarefas</a>
        <a chainNavItem routerLink="/solicitar" routerLinkActive ariaCurrentWhenActive="page">Solicitar</a>
        <a chainNavItem routerLink="/solicitacoes" routerLinkActive ariaCurrentWhenActive="page">Solicitações</a>
        @if (session.user()?.canModel) {
          <a chainNavItem routerLink="/processos" routerLinkActive ariaCurrentWhenActive="page">Processos</a>
          <a chainNavItem routerLink="/formularios" routerLinkActive ariaCurrentWhenActive="page">Formulários</a>
          <a chainNavItem routerLink="/automacoes" routerLinkActive ariaCurrentWhenActive="page">Automações</a>
        }
        @if (session.user()?.isAdmin) {
          <chain-nav-group label="Administração">
            <a chainNavItem routerLink="/administracao/usuarios" routerLinkActive ariaCurrentWhenActive="page">Usuários</a>
            <a chainNavItem routerLink="/administracao/grupos" routerLinkActive ariaCurrentWhenActive="page">Grupos</a>
            <a chainNavItem routerLink="/administracao/bots" routerLinkActive ariaCurrentWhenActive="page">Bots</a>
            <a chainNavItem routerLink="/administracao/destinos" routerLinkActive ariaCurrentWhenActive="page">Destinos</a>
            <a chainNavItem routerLink="/administracao/credenciais" routerLinkActive ariaCurrentWhenActive="page">Credenciais</a>
          </chain-nav-group>
        }
      </ng-container>
      <router-outlet />
    </chain-shell>
  `,
  styleUrl: './app-layout.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppLayout {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly leaving = signal(false);

  protected async logout(): Promise<void> {
    this.leaving.set(true);
    await this.session.logout();
    await this.router.navigateByUrl('/entrar');
  }
}
