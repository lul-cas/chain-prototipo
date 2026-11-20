import { LocalProblem, fieldProblems } from './automation-checks';
import { AutomationDocument } from './automation-document';

const MAX_PATH_SEGMENTS = 20;
const MAX_INDEX = 2_147_483_647;

/**
 * The local checks of *Resposta e saídas* (automation-ui.md §7.9, AS5a), as `AutomationRules` finds them and in its order:
 * AU001 and AU002 of the outputs, then AU010. Each has the server's code and path, and its cause in pt-BR.
 */
export function outputProblems(document: AutomationDocument): LocalProblem[] {
  const problems = fieldProblems(document.outputs, 'outputs', ['saídas', 'outra saída']);
  const response = document.response.type;
  if (response !== 'json' && response !== 'none') {
    problems.push({ code: 'AU010', path: 'response.type', text: 'A resposta é JSON ou nenhuma.' });
  }
  document.outputs.forEach((output, i) => {
    const at = `outputs[${i}]`;
    switch (output.source) {
      case 'body':
        if (output.path === undefined || output.path.length === 0 || output.path.length > MAX_PATH_SEGMENTS) {
          problems.push({ code: 'AU010', path: `${at}.path`, text: `Uma saída do corpo lê um caminho de 1 a ${MAX_PATH_SEGMENTS} nomes ou posições.` });
        } else if (!output.path.every(isSegment)) {
          problems.push({ code: 'AU010', path: `${at}.path`, text: 'Cada trecho do caminho é um nome ou a posição de um item, a partir de 0.' });
        }
        if (response !== 'json') {
          problems.push({ code: 'AU010', path: `${at}.source`, text: 'Saídas lidas do corpo pedem a resposta JSON.' });
        }
        break;
      case 'status':
        if (output.type !== 'number') {
          problems.push({ code: 'AU010', path: `${at}.type`, text: 'O status HTTP é uma saída de número.' });
        }
        if (output.path !== undefined) {
          problems.push({ code: 'AU010', path: `${at}.path`, text: 'Uma saída do status HTTP não tem caminho.' });
        }
        break;
      default:
        problems.push({ code: 'AU010', path: `${at}.source`, text: 'A origem de uma saída é o corpo da resposta ou o status HTTP.' });
    }
  });
  return problems;
}

/** A property name, or a list position from 0 that the server reads as a 32-bit integer (`IsOutputPathSegment`). */
function isSegment(segment: unknown): boolean {
  return (typeof segment === 'string' && segment !== '') || (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0 && segment <= MAX_INDEX);
}
