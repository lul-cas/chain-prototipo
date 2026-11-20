import { Usage } from '../in-use';
import { InUseData } from '../in-use-dialog';

/** *A credencial erp_key está em uso* (automation-ui.md §4.5), for deleting it or for a change that breaks versions (§4.3). */
export function secretInUse(name: string, usage: Usage, action: 'delete' | 'save'): InUseData {
  return {
    title: `A credencial ${name} está em uso`,
    sections: [{ title: 'Automações publicadas que a usam', items: usage.automations, note: 'Rascunhos não contam.' }],
    versions: usage.versions,
    consequence:
      action === 'delete'
        ? 'Se excluir mesmo assim, as etapas automáticas dessas automações falham, porque a credencial não existe mais.'
        : 'Se salvar mesmo assim, essas versões falham quando chamarem os destinos retirados, até serem publicadas de novo.',
    forceLabel: action === 'delete' ? 'Excluir mesmo assim' : 'Salvar mesmo assim',
  };
}
