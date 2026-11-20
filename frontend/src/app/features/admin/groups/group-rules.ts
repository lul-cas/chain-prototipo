import { storable } from '../../../core/text/storable';

/** The texts of admin-ui.md §9 for the codes a group's fields can get, locally or from the server. */
export const GROUP_FIELD_TEXTS: Readonly<Record<string, string>> = {
  invalid_group_name: 'Use um nome de 1 a 100 caracteres.',
  group_name_taken: 'Já existe um grupo com este nome.',
  description_too_long: 'A descrição pode ter no máximo 500 caracteres.',
  invalid_description: 'A descrição tem caracteres que não podem ser guardados.',
};

export const MAX_GROUP_DESCRIPTION = 500;
const MAX_GROUP_NAME = 100;

/** *Nome* (admin-ui.md §5.1): 1–100 UTF-16 units around spaces, as the server counts them, of text it can store. */
export function groupNameProblem(text: string): 'invalid_group_name' | null {
  const name = text.trim();
  return name.length >= 1 && name.length <= MAX_GROUP_NAME && storable(name) ? null : 'invalid_group_name';
}

/** *Descrição* (§5.1): empty, or at most 500 units around spaces, of text the server can store. */
export function groupDescriptionProblem(text: string): 'description_too_long' | 'invalid_description' | null {
  const description = text.trim();
  if (description.length > MAX_GROUP_DESCRIPTION) {
    return 'description_too_long';
  }
  return storable(description) ? null : 'invalid_description';
}
