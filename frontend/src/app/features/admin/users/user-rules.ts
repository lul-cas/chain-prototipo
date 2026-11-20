import { storable } from '../../../core/text/storable';
import { User } from './users-api';

/** The texts of admin-ui.md §9 for the codes a user's fields can get, locally or from the server. */
export const USER_FIELD_TEXTS: Readonly<Record<string, string>> = {
  invalid_username: 'Use de 3 a 64 caracteres: letras minúsculas, dígitos, ponto, hífen ou sublinhado.',
  username_taken: 'Este identificador já está em uso.',
  invalid_display_name: 'Use um nome de 1 a 200 caracteres.',
};

const USERNAME = /^[a-z0-9._-]{3,64}$/;
const MAX_DISPLAY_NAME = 200;

/**
 * *Usuário* as typed (admin-ui.md §4.1): 3–64 characters from `a-z 0-9 . _ -`, around spaces. The server also lowercases
 * what it gets (identity.md I2); the page asks for lowercase instead, so the username shown is the one stored.
 */
export function usernameProblem(text: string): 'invalid_username' | null {
  return USERNAME.test(text.trim()) ? null : 'invalid_username';
}

/** *Nome* (§4.1): 1–200 UTF-16 units around spaces, as the server counts them, of text PostgreSQL can store. */
export function displayNameProblem(text: string): 'invalid_display_name' | null {
  const name = text.trim();
  return name.length >= 1 && name.length <= MAX_DISPLAY_NAME && storable(name) ? null : 'invalid_display_name';
}

/** A user's state in words (admin-ui.md §4.1): *Ativo* or *Inativo*, then *Bloqueado* and *Troca de senha pendente* when they apply. */
export function userStates(user: User): string[] {
  return [user.isActive ? 'Ativo' : 'Inativo', user.isLocked ? 'Bloqueado' : null, user.mustChangePassword ? 'Troca de senha pendente' : null].filter(
    (state): state is string => state !== null,
  );
}
