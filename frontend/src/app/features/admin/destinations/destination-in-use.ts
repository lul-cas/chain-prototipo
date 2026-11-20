import { Usage } from '../in-use';
import { InUseData } from '../in-use-dialog';

/** *O destino erp está em uso* (automation-ui.md §3.3), for deleting it or for saving a change that breaks versions. */
export function destinationInUse(name: string, usage: Usage, action: 'delete' | 'save'): InUseData {
  return {
    title: `O destino ${name} está em uso`,
    sections: [
      { title: 'Credenciais que o permitem', items: usage.secrets },
      { title: 'Automações publicadas que o chamam', items: usage.automations, note: 'Rascunhos não contam.' },
    ],
    versions: usage.versions,
    consequence:
      action === 'delete'
        ? 'Se excluir mesmo assim, ele sai da lista dessas credenciais, e as etapas automáticas dessas automações falham ao começar (O destino da etapa automática não existe mais.).'
        : 'Se salvar mesmo assim, essas versões falham quando forem chamadas, até serem publicadas de novo com o destino como ficou.',
    forceLabel: action === 'delete' ? 'Excluir mesmo assim' : 'Salvar mesmo assim',
  };
}
