import { LucideCircleAlert, LucideCircleCheck, LucideInfo, LucideTriangleAlert } from '@lucide/angular';

export type Tone = 'info' | 'success' | 'warning' | 'danger';

/** Text that names each tone for screen readers, so status is never conveyed by color alone (D2.1). */
export const TONE_LABEL: Record<Tone, string> = {
  info: 'Informação:',
  success: 'Sucesso:',
  warning: 'Atenção:',
  danger: 'Erro:',
};

export const TONE_ICONS = [LucideInfo, LucideCircleCheck, LucideTriangleAlert, LucideCircleAlert] as const;
