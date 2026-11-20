import { DraftProblem } from './workflow-document';

/**
 * The pt-BR text for each code workflow publishing can report (workflow-editor.md §10.1): what the rule of
 * workflow-definition.md §2, §5.3 or §6.4 requires. The AU codes of an automation reach the editor as WF107 and WF108.
 */
export const VALIDATION_MESSAGES: Readonly<Record<string, string>> = {
  // The document (§2).
  WF000: 'O documento do processo não pôde ser lido.',
  // Structure (§2).
  WF001: 'O processo precisa de exatamente um início.',
  WF002: 'O processo precisa de pelo menos um fim.',
  WF003: 'Este id é usado por mais de um elemento.',
  WF004: 'A origem ou o destino deste fluxo não existe.',
  WF005: 'Um início ou uma etapa precisa de exatamente uma saída.',
  WF006: 'Uma condicional precisa de exatamente uma saída verdadeira e uma falsa.',
  WF007: 'Um fim não pode ter saídas.',
  WF008: 'Não há caminho do início até este elemento.',
  WF009: 'Não há caminho deste elemento até um fim.',
  WF010: 'Um elemento não pode se ligar a si mesmo.',
  WF011: 'A área deste elemento não existe.',
  WF012: 'O rótulo é obrigatório e pode ter no máximo 120 caracteres.',
  WF013: 'Uma condicional decidida por uma pessoa precisa de uma pergunta, e uma automática, de uma condição válida.',
  WF014: 'Uma etapa automática precisa indicar a sua automação, e um subprocesso, o processo que ele chama.',
  WF015: 'Só as saídas de uma condicional podem ser verdadeiras ou falsas.',
  WF016: 'O processo passa do tamanho máximo: 500 nós, 1.000 fluxos e 50 áreas.',
  WF017: 'Uma área precisa ser dos solicitantes ou de um grupo.',
  WF018: 'Os mapeamentos de entrada e de saída do subprocesso precisam ser válidos.',
  WF019: 'As chaves dos mapeamentos começam com uma letra e usam só letras sem acento, dígitos ou _, com no máximo 64 caracteres.',
  // References, checked against what exists when publishing (§5.3).
  WF101: 'O grupo desta área não existe.',
  WF102: 'O grupo desta área está arquivado.',
  WF103: 'O formulário não existe ou ainda não foi publicado.',
  WF104: 'A automação não existe ou ainda não foi publicada.',
  WF105: 'O processo chamado não existe ou ainda não foi publicado.',
  WF106: 'Um processo não pode chamar a si mesmo.',
  WF107: 'Uma credencial usada pela automação não existe mais.',
  WF108: 'O destino da automação não existe mais, ou não pode receber as credenciais dela.',
  WF109:
    'Os mapeamentos da etapa automática precisam ser válidos, com chaves que começam com uma letra e usam só letras sem acento, dígitos ou _, com no máximo 64 caracteres.',
  WF110: 'As entradas mapeadas precisam ser as da automação, e toda entrada obrigatória precisa ser mapeada.',
  // Types, against the data the process has at that point (§6.4).
  WF201: 'A condição usa dados de tipos que não combinam, como um número comparado a um texto.',
  WF202: 'Um mapeamento de entrada do subprocesso não combina com o formulário inicial dele, ou usa dados de tipos que não combinam.',
  WF203: 'Um mapeamento de saída do subprocesso usa dados de tipos que não combinam.',
  WF204: 'Um mapeamento de entrada da etapa automática não combina com o tipo da entrada na automação, ou usa dados de tipos que não combinam.',
  WF205: 'Um mapeamento de saída da etapa automática usa dados de tipos que não combinam.',
  WF206: 'Um mapeamento de entrada do subprocesso leva arquivos, ou preenche um campo de arquivo do formulário inicial dele: arquivos não passam para um subprocesso.',
  WF207: 'Um campo obrigatório do formulário inicial do subprocesso não tem mapeamento de entrada, ou é um campo de arquivo, que nenhum mapeamento pode preencher.',
  WF208: 'Uma condição ou um campo calculado do formulário lê um dado sigiloso que não é campo desse formulário, e o navegador não pode vê-lo.',
  WF209: 'Um campo calculado lê um dado sigiloso e precisa ser sigiloso também.',
  WF210: 'Um mapeamento leva um dado sigiloso para um dado que não é sigiloso.',
};

/** A problem's pt-BR text; the server's message for a code without one, so a new rule is still explained. */
export function problemText(problem: DraftProblem): string {
  return Object.hasOwn(VALIDATION_MESSAGES, problem.code) ? VALIDATION_MESSAGES[problem.code] : problem.message;
}
