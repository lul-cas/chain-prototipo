// A notação de expressões dos documentos (cadastro.md §3.1) para as árvores de expression-language.md §5.

const OPERADORES = { '=': 'equals', '≠': 'notEquals', '>': 'greaterThan', '<': 'lessThan', '>=': 'greaterOrEqual', '<=': 'lessOrEqual' };
const ARITMETICA = { '+': 'add', '−': 'subtract', '-': 'subtract', '×': 'multiply', '÷': 'divide' };
const UNIDADES = { dia: 'days', dias: 'days', mês: 'months', meses: 'months', ano: 'years', anos: 'years' };

function tokens(texto) {
  const lista = [];
  const padrao = /\s*(?:"([^"]*)"|([0-9]+(?:\.[0-9]+)?)|([\p{L}_][\p{L}\p{N}_.]*)|(>=|<=|[=≠><+−\-×÷(),]))/uy;
  let posicao = 0;
  while (posicao < texto.length) {
    if (!texto.slice(posicao).trim()) break;
    padrao.lastIndex = posicao;
    const achou = padrao.exec(texto);
    if (!achou) throw new Error(`caractere inesperado em "${texto}", na posição ${posicao}`);
    posicao = padrao.lastIndex;
    const [, texto_, numero, palavra, simbolo] = achou;
    if (texto_ !== undefined) lista.push({ tipo: 'texto', valor: texto_ });
    else if (numero !== undefined) lista.push({ tipo: 'numero', valor: numero });
    else if (palavra !== undefined) lista.push({ tipo: 'palavra', valor: palavra });
    else lista.push({ tipo: 'simbolo', valor: simbolo });
  }
  return lista;
}

class Leitor {
  constructor(texto) {
    this.texto = texto;
    this.lista = tokens(texto);
    this.posicao = 0;
  }

  get atual() {
    return this.lista[this.posicao];
  }

  eh(valor) {
    return this.atual?.valor === valor && this.atual.tipo !== 'texto';
  }

  aceitar(valor) {
    if (!this.eh(valor)) return false;
    this.posicao += 1;
    return true;
  }

  exigir(valor) {
    if (!this.aceitar(valor)) throw new Error(`esperava "${valor}" em "${this.texto}"`);
  }

  fim() {
    if (this.atual) throw new Error(`sobrou "${this.atual.valor}" em "${this.texto}"`);
  }

  ou() {
    return this.grupo('OU', 'or', () => this.e());
  }

  e() {
    return this.grupo('E', 'and', () => this.comparacao());
  }

  grupo(palavra, op, proximo) {
    const itens = [proximo()];
    while (this.aceitar(palavra)) itens.push(proximo());
    return itens.length === 1 ? itens[0] : { kind: 'group', op, items: itens };
  }

  comparacao() {
    const left = this.soma();
    if (this.aceitar('não')) {
      this.exigir('está');
      this.exigir('vazio');
      return { kind: 'compare', left, operator: 'isNotEmpty' };
    }
    if (this.aceitar('está')) {
      this.exigir('vazio');
      return { kind: 'compare', left, operator: 'isEmpty' };
    }
    if (this.aceitar('contém')) return { kind: 'compare', left, operator: 'contains', right: this.soma() };
    const operador = this.atual?.tipo === 'simbolo' ? OPERADORES[this.atual.valor] : undefined;
    if (!operador) throw new Error(`faltou a comparação em "${this.texto}"`);
    this.posicao += 1;
    return { kind: 'compare', left, operator: operador, right: this.soma() };
  }

  aritmetica(simbolos, proximo) {
    let left = proximo();
    while (this.atual?.tipo === 'simbolo' && simbolos.includes(this.atual.valor)) {
      const op = ARITMETICA[this.atual.valor];
      this.posicao += 1;
      left = { kind: 'arithmetic', op, left, right: proximo() };
    }
    return left;
  }

  soma() {
    return this.aritmetica(['+', '−', '-'], () => this.produto());
  }

  produto() {
    return this.aritmetica(['×', '÷'], () => this.fator());
  }

  hoje() {
    const sistema = { kind: 'system', name: 'currentDate' };
    const sinal = this.atual?.tipo === 'simbolo' && ['+', '−', '-'].includes(this.atual.valor) ? this.atual.valor : null;
    if (!sinal) return sistema;
    this.posicao += 1;
    const quantidade = this.atual;
    if (quantidade?.tipo !== 'numero') throw new Error(`esperava um número depois de hoje em "${this.texto}"`);
    this.posicao += 1;
    const unit = UNIDADES[this.atual?.valor];
    if (!unit) throw new Error(`unidade desconhecida em "${this.texto}"`);
    this.posicao += 1;
    const amount = Number(quantidade.valor);
    return { ...sistema, offset: { amount: sinal === '+' ? amount : -amount, unit } };
  }

  fator() {
    const token = this.atual;
    if (!token) throw new Error(`esperava um valor em "${this.texto}"`);
    this.posicao += 1;
    if (token.tipo === 'texto') return { kind: 'literal', type: 'text', value: token.valor };
    if (token.tipo === 'numero') return { kind: 'literal', type: 'number', value: token.valor };
    if (token.tipo === 'simbolo') {
      if (token.valor !== '(') throw new Error(`esperava um valor em "${this.texto}"`);
      const dentro = this.soma();
      this.exigir(')');
      return dentro;
    }
    if (token.valor === 'true' || token.valor === 'false') return { kind: 'literal', type: 'boolean', value: token.valor };
    if (token.valor === 'hoje') return this.hoje();
    if (this.aceitar('(')) {
      const args = [this.soma()];
      while (this.aceitar(',')) args.push(this.soma());
      this.exigir(')');
      return { kind: 'call', function: token.valor, args };
    }
    return { kind: 'path', path: token.valor.split('.') };
  }
}

/** Uma condição: `a = 1 E b ≠ "x"`. */
export function condicao(texto) {
  const leitor = new Leitor(texto);
  const arvore = leitor.ou();
  leitor.fim();
  return arvore;
}

/** Um valor: um caminho, um literal, `hoje + 15 dias` ou uma conta. */
export function valor(texto) {
  const leitor = new Leitor(texto);
  const arvore = leitor.soma();
  leitor.fim();
  return arvore;
}
