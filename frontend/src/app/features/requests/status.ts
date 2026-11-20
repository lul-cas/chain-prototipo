import { InstanceStatus } from '../../core/http/engine-api';

/** A request's status in words: always shown as text, never by color alone (design-system.md). */
export const STATUS_LABEL: Readonly<Record<InstanceStatus, string>> = {
  running: 'Em andamento',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  faulted: 'Com falha',
};
