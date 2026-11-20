// A massa de dados de mock.md §3: fixa, para o laboratório alcançar cada caminho de propósito.

function digito(digitos, pesos) {
  const resto = digitos.reduce((soma, d, i) => soma + d * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function comDigitos(base, pesosDe) {
  const digitos = [...base].map(Number);
  digitos.push(digito(digitos, pesosDe(digitos.length)));
  digitos.push(digito(digitos, pesosDe(digitos.length)));
  return digitos.join('');
}

const pesosCpf = (tamanho) => Array.from({ length: tamanho }, (_, i) => tamanho + 1 - i);
const pesosCnpj = (tamanho) => Array.from({ length: tamanho }, (_, i) => ((tamanho - 1 - i) % 8) + 2);

export const cpf = (base) => comDigitos(base, pesosCpf);
export const cnpj = (base) => comDigitos(base, pesosCnpj);

/** Se os dígitos verificadores de um CPF ou CNPJ conferem. */
export function documentoValido(documento) {
  if (/^[0-9]{11}$/.test(documento)) return cpf(documento.slice(0, 9)) === documento;
  if (/^[0-9]{14}$/.test(documento)) return cnpj(documento.slice(0, 12)) === documento;
  return false;
}

export function somarDias(data, dias) {
  const resultado = new Date(`${data}T00:00:00Z`);
  resultado.setUTCDate(resultado.getUTCDate() + dias);
  return resultado.toISOString().slice(0, 10);
}

export function somarAnos(data, anos) {
  const resultado = new Date(`${data}T00:00:00Z`);
  resultado.setUTCFullYear(resultado.getUTCFullYear() + anos);
  return resultado.toISOString().slice(0, 10);
}

const CLIENTES = [
  { base: '000000001', nome: 'Ana Clara Moreira', renda: 12000, score: 800, parcelas: 300, saldo: 2500 },
  { base: '000000002', nome: 'Bruno Teixeira', renda: 8000, score: 650, parcelas: 800, saldo: 900 },
  { base: '000000003', nome: 'Carla Nunes', renda: 5000, score: 350, parcelas: 200, saldo: 100 },
  { base: '000000004', nome: 'Diogo Prado', renda: 6000, score: 620, parcelas: 900, saldo: 50, atraso: 120 },
  { base: '000000005', nome: 'Eduarda Campos', renda: 7000, score: 700, parcelas: 400, saldo: 800, cadastroVencido: true },
  { base: '000000006', nome: 'Fábio Rocha', renda: 4000, score: 600, parcelas: 0, saldo: 0, situacao: 'bloqueado' },
  { base: '000000007', nome: 'Gabriela Dias', renda: 9000, score: 700, parcelas: 500, saldo: 300, contratosForaDaMassa: 1, apolices: 1 },
  { base: '000000008', nome: 'Heitor Lima', renda: 3500, score: 640, parcelas: 0, saldo: 1500 },
  { base: '000000009', nome: 'Íris Melo', renda: 3000, score: 610, parcelas: 0, saldo: 0 },
  { base: '000000010', nome: 'Júlio Braga', renda: 10000, score: 780, parcelas: 200, saldo: 1200, assinaturaDemora: true },
  { base: '000000011', nome: 'Karina Alves', renda: 6500, score: 690, parcelas: 300, saldo: 700, pld: 'alerta' },
  { base: '000000012', nome: 'Leandro Reis', renda: 15000, score: 720, parcelas: 1000, saldo: 4000, restricoes: 2500 },
  { base: '000000013', nome: 'Marcos Vale', renda: 4500, score: 500, parcelas: 900, saldo: 0 },
  { base: '000000014', nome: 'Nestor Sales', renda: 11000, score: 790, parcelas: 100, saldo: 600, aprovacaoVencida: true },
];

const CONTRATOS = [
  { numero: 'CT-1001', base: '000000002', saldoDevedor: 12000, valorParcela: 600, diasAtraso: 45 },
  { numero: 'CT-1002', base: '000000013', saldoDevedor: 30000, valorParcela: 900, diasAtraso: 400 },
  { numero: 'CT-1003', base: '000000001', saldoDevedor: 9000, valorParcela: 300, diasAtraso: 0 },
];

/** Documentos fora do Core, para CAD-01 (mock.md §3.2). */
const SITUACOES = new Map([[cpf('000000102'), 'irregular']]);
const LISTAS = new Map([
  [cpf('000000103'), { resultadoPld: 'alerta', pep: false }],
  [cpf('000000104'), { resultadoPld: 'bloqueio', pep: false }],
  [cpf('000000105'), { resultadoPld: 'limpo', pep: true }],
]);

export const situacaoDocumento = (documento) => (documentoValido(documento) ? (SITUACOES.get(documento) ?? 'regular') : 'inexistente');
export const listasRestritivas = (documento) => LISTAS.get(documento) ?? { resultadoPld: 'limpo', pep: false };

function clienteDaMassa(semente, indice, documento, tipoPessoa, hoje) {
  return {
    documentoCliente: documento,
    idCliente: `CLI-${String(indice + 1).padStart(4, '0')}`,
    nomeCliente: semente.nome,
    tipoPessoa,
    situacaoCliente: semente.situacao ?? 'ativo',
    dataValidadeCadastro: semente.cadastroVencido ? somarDias(hoje, -30) : somarAnos(hoje, 1),
    rendaMensal: semente.renda,
    endereco: { cep: '01001000', logradouro: 'Rua das Flores', numero: String(indice + 1), bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
    email: `cliente${indice + 1}@exemplo.test`,
    telefone: '11999990000',
    numeroAgencia: '0001',
    numeroConta: `10${String(indice + 1).padStart(4, '0')}-0`,
    saldoConta: semente.saldo,
    score: semente.score,
    valorRestricoes: semente.restricoes ?? 0,
    parcelasAtuais: semente.parcelas,
    atrasoDias: semente.atraso ?? 0,
    contratosForaDaMassa: semente.contratosForaDaMassa ?? 0,
    apolicesAtivas: semente.apolices ?? 0,
    cotasAtivas: 0,
    pld: semente.pld,
    assinaturaDemora: semente.assinaturaDemora ?? false,
    aprovacaoVencida: semente.aprovacaoVencida ?? false,
  };
}

export function massaInicial(hoje) {
  const clientes = new Map();
  CLIENTES.forEach((semente, indice) => {
    const documento = cpf(semente.base);
    clientes.set(documento, clienteDaMassa(semente, indice, documento, 'pf', hoje));
  });
  const empresa = cnpj('900000010001');
  clientes.set(empresa, clienteDaMassa({ nome: 'Oficina Boa Vista Ltda', renda: 60000, score: 700, parcelas: 3000, saldo: 10000 }, CLIENTES.length, empresa, 'pj', hoje));

  const contratos = new Map(CONTRATOS.map(({ numero, base, ...contrato }) => [numero, { numeroContrato: numero, documentoCliente: cpf(base), ...contrato, liberado: true, daMassa: true }]));

  return {
    clientes,
    contratos,
    decisoes: [],
    cotacoes: new Map(),
    apolices: [],
    envelopes: new Map(),
    gravames: [],
    acordos: [],
    pagamentos: [],
    boletos: [],
    lancamentos: [],
    mensagens: [],
    comunicacoes: [],
    sequencias: new Map(),
  };
}
