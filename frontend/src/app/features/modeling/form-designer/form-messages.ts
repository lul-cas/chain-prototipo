/** The Portuguese text of each structural rule (form-designer.md §9.4); an unknown code shows the server's message. */
const FORM_MESSAGES: Readonly<Record<string, string>> = {
  FM000: 'O rascunho não pôde ser lido como formulário.',
  FM001: 'Dê ao campo uma chave: uma letra seguida de até 63 letras, dígitos ou _.',
  FM002: 'Esta chave se repete no mesmo nível.',
  FM003: 'Dê de 1 a 200 opções, sem valores repetidos.',
  FM004: 'Uma regra deste componente não combina com o tipo dele.',
  FM005: 'O padrão não pode ser usado: ele não compila, passa de 500 caracteres ou usa recursos fora do subconjunto aceito.',
  FM006: 'O formulário passa de 200 componentes ou de 3 níveis de grupos e listas.',
  FM007: 'O campo calculado precisa de uma expressão válida.',
  FM008: 'Uma condição deste componente é inválida.',
  FM009: 'Só campos do primeiro nível, grupos e listas podem ser sensíveis.',
  FM010: 'Um campo de arquivo não pode ser sensível.',
  FM011: 'Dê um rótulo ao campo.',
  FM012: 'A descrição do campo tem no máximo 500 caracteres; títulos e parágrafos não têm descrição.',
};

export function formProblemText(code: string, serverMessage?: string | null): string {
  return Object.hasOwn(FORM_MESSAGES, code) ? FORM_MESSAGES[code] : (serverMessage ?? `Problema ${code}.`);
}
