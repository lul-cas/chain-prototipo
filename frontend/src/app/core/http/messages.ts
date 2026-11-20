/**
 * The pt-BR text for the API's problem codes (ADR-0010 D4; identity.md, UI). A code without an entry is shown as is, so a
 * new backend code never surfaces as English or as an invented message. A text here fits every page that gets the code; a
 * page that can say more passes its own text for that code to {@link messageFor}.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: 'Usuário ou senha inválidos.',
  invalid_current_password: 'A senha atual está incorreta.',
  password_too_short: 'A nova senha precisa ter pelo menos 12 caracteres.',
  password_too_long: 'A senha pode ter no máximo 128 caracteres.',
  password_equals_username: 'A nova senha não pode ser igual ao nome de usuário.',
  network_error: 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
  not_found: 'Não encontramos o que você procurava.',
  forbidden: 'Você não tem permissão para fazer isso.',
  task_not_open: 'Esta tarefa já foi concluída ou cancelada.',
  task_assigned: 'Outra pessoa assumiu esta tarefa.',
  instance_not_running: 'A solicitação não está mais em andamento.',
  concurrency_conflict: 'A tarefa mudou enquanto você trabalhava. Carregue de novo.',
  comment_too_long: 'O comentário pode ter no máximo 1.000 caracteres.',
  justification_too_long: 'A justificativa pode ter no máximo 1.000 caracteres.',
  justification_required: 'Escreva uma justificativa.',
  // Text PostgreSQL cannot store: the NUL character or half of a UTF-16 pair (identity.md I1).
  invalid_comment: 'O comentário tem caracteres que não podem ser guardados.',
  invalid_justification: 'A justificativa tem caracteres que não podem ser guardados.',
  invalid_description: 'A descrição tem caracteres que não podem ser guardados.',
  submission_invalid: 'Corrija os campos indicados.',
  workflow_not_startable: 'Este fluxo não pode ser iniciado agora.',
  // Any page that sends If-Match can get it, even for the user's own first attempt after a lost answer (card #166).
  version_mismatch: 'Este item mudou desde que você o abriu. Carregue a página de novo.',
  workflow_name_taken: 'Já existe um processo com este nome.',
  form_name_taken: 'Já existe um formulário com este nome.',
  automation_name_taken: 'Já existe uma automação com este nome.',
  destination_name_taken: 'Já existe um destino com este nome.',
  secret_name_taken: 'Já existe uma credencial com este nome.',
  secrets_unavailable: 'O servidor não tem uma chave de criptografia ativa, então credenciais não podem ser criadas nem trocadas agora. Fale com quem opera o Chain.',
  unknown_destination: 'Um dos destinos escolhidos não existe mais.',
  // Users, groups and bots (admin-ui.md §9).
  username_taken: 'Este identificador já está em uso.',
  last_admin: 'O Chain precisa de pelo menos um administrador ativo.',
  cannot_deactivate_self: 'Você não pode desativar a própria conta.',
  group_name_taken: 'Já existe um grupo com este nome.',
  group_archived: 'O grupo está arquivado.',
  token_limit_reached: 'Um bot pode ter até 5 tokens ativos. Revogue um antes.',
};

/** The text for a code: the page's own, when it gives one, or the app's. */
export function messageFor(code: string, page: Readonly<Record<string, string>> = {}): string {
  return textIn(page, code) ?? textIn(MESSAGES, code) ?? `Algo deu errado (código: ${code}). Tente de novo.`;
}

/** A table's own text for a code. A name every object inherits, such as `constructor`, is not one (card #188). */
function textIn(table: Readonly<Record<string, string>>, code: string): string | undefined {
  return Object.hasOwn(table, code) ? table[code] : undefined;
}
