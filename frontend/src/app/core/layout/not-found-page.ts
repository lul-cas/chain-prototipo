import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'chain-not-found-page',
  template: `
    <main class="chain-not-found">
      <p class="chain-eyebrow">404</p>
      <h1>Página não encontrada</h1>
      <p>Esse endereço não corresponde a nenhuma página do Chain.</p>
    </main>
  `,
  styleUrl: './not-found-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {}
