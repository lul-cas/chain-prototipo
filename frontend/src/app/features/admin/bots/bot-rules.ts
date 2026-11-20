import { storable } from '../../../core/text/storable';
import { usernameProblem } from '../users/user-rules';

/** The texts of admin-ui.md §9 for the codes a bot's fields can get, locally or from the server. */
export const BOT_FIELD_TEXTS: Readonly<Record<string, string>> = {
  invalid_name: 'Use de 3 a 64 caracteres: letras minúsculas, dígitos, ponto, hífen ou sublinhado.',
  username_taken: 'Este identificador já está em uso.',
  invalid_display_name: 'Use um nome de 1 a 200 caracteres.',
  invalid_label: 'Use um rótulo de 1 a 100 caracteres.',
  invalid_calls_per_minute: 'Use um número de 1 a 600, ou o padrão do servidor.',
};

const MAX_LABEL = 100;
const MAX_RATE = 600;

/** *Identificador* (admin-ui.md §6.1): the username rules, since bots and users share one namespace (identity.md I3). */
export function botNameProblem(text: string): 'invalid_name' | null {
  return usernameProblem(text) === null ? null : 'invalid_name';
}

/** A token's *Rótulo* (§6.2): 1–100 UTF-16 units around spaces, as the server counts them, of text it can store. */
export function tokenLabelProblem(text: string): 'invalid_label' | null {
  const label = text.trim();
  return label.length >= 1 && label.length <= MAX_LABEL && storable(label) ? null : 'invalid_label';
}

/** *Chamadas por minuto* (§6.2): a whole number from 1 to 600. */
export function rateProblem(text: string): 'invalid_calls_per_minute' | null {
  const rate = text.trim();
  return /^[0-9]{1,3}$/.test(rate) && Number(rate) >= 1 && Number(rate) <= MAX_RATE ? null : 'invalid_calls_per_minute';
}
