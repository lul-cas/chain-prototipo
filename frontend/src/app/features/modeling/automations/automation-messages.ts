/** One pt-BR text per AU code (automation-ui.md §8.3, card #111); a code without one shows the server's message. */
const AUTOMATION_MESSAGES: Readonly<Record<string, string>> = {
  AU000: 'O rascunho não pôde ser lido como automação.',
  AU001: 'As chaves de entradas e saídas começam com uma letra e usam só letras sem acento, dígitos ou _, com no máximo 64 caracteres, sem repetir na lista. Cada lista tem no máximo 50 itens.',
  AU002: 'O tipo precisa ser texto, número, sim ou não, data, data e hora, hora, objeto, lista ou desconhecido.',
  AU003: 'O método precisa ser GET, POST, PUT, PATCH ou DELETE, e GET e DELETE não têm corpo.',
  AU004: 'O caminho começa com /, tem no máximo 2.000 caracteres, usa só caracteres de URL e não tem .., ?, # nem credenciais. Cada {entrada} nele precisa ser de texto, número, sim ou não, data ou hora.',
  AU005: 'Cada parâmetro da consulta tem um nome de 1 a 100 caracteres, e o valor é um texto fixo ou exatamente uma {entrada} de texto, número, sim ou não, data ou hora. Credenciais não entram na consulta.',
  AU006: 'Use no máximo 30 cabeçalhos, com nomes válidos e sem repetir, fora os que o cliente HTTP define (como Host) e o da chave de idempotência. Os valores usam só caracteres ASCII visíveis, espaços e tabulações, e não usam entradas.',
  AU007: 'Credenciais se escrevem {{secret:nome}} e só podem aparecer nos valores dos cabeçalhos e na autenticação básica.',
  AU008: "A autenticação básica precisa de usuário e senha, sem caracteres de controle; o usuário não pode ter ':', e ela não pode vir junto com um cabeçalho Authorization.",
  AU009: 'O corpo é JSON, e as entradas listadas nele precisam existir, sem repetir.',
  AU010: 'A resposta é JSON ou nenhuma. Uma saída vem do corpo, com um caminho de 1 a 20 partes e resposta JSON, ou do status HTTP, como número e sem caminho.',
  AU011: 'O tempo limite vai de 1 a 300 segundos, as tentativas de 1 a 10 e a espera inicial de 1 a 60 segundos. Ao seguir redirecionamentos, são de 1 a 3.',
  AU012: 'O cabeçalho da chave de idempotência tem um nome válido de até 100 caracteres, e não existe quando a chave não é enviada.',
  AU013: 'Use uma credencial: a senha e os cabeçalhos Authorization, Cookie e X-Api-Key não podem ter o valor escrito na automação.',
  AU101: 'Escolha um destino que exista.',
  AU102: 'Uma credencial usada na chamada não existe.',
  AU103: 'Uma credencial usada na chamada não permite o destino escolhido.',
  AU104: 'O destino usa HTTP sem TLS e não aceita credenciais. Peça a um administrador para permitir, ou não use credenciais.',
  AU105: 'O caminho precisa ficar dentro do prefixo do destino.',
  AU106: 'Num destino com *., informe como host um subdomínio dele. Nos outros, o host é o do destino ou fica vazio.',
};

export function automationProblemText(code: string, serverMessage: string): string {
  return Object.hasOwn(AUTOMATION_MESSAGES, code) ? AUTOMATION_MESSAGES[code] : serverMessage;
}
