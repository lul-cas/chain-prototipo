// Liga o mock a uma porta, na rede interna da stack do laboratório (mock.md §2).
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { criarMock } from './app.mjs';

const LIMITE_DO_CORPO = 1024 * 1024;

function lerCorpo(pedido) {
  return new Promise((resolver, rejeitar) => {
    const partes = [];
    let tamanho = 0;
    pedido.on('data', (parte) => {
      tamanho += parte.length;
      if (tamanho > LIMITE_DO_CORPO) rejeitar(new Error('corpo grande demais'));
      else partes.push(parte);
    });
    pedido.on('end', () => resolver(partes.length ? Buffer.concat(partes).toString('utf8') : undefined));
    pedido.on('error', rejeitar);
  });
}

export function criarServidor(mock) {
  return createServer(async (pedido, resposta) => {
    try {
      const corpo = await lerCorpo(pedido);
      const { status, corpo: conteudo } = await mock.tratar({ metodo: pedido.method, caminho: pedido.url, cabecalhos: pedido.headers, corpo });
      console.log(`${pedido.method} ${pedido.url} ${status}`);
      resposta.writeHead(status, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify(conteudo));
    } catch (erro) {
      console.error(`${pedido.method} ${pedido.url} falhou: ${erro.message}`);
      resposta.writeHead(500, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ erro: 'erro no mock' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chave = process.env.MOCK_API_KEY;
  if (!chave) {
    console.error('Defina MOCK_API_KEY.');
    process.exit(1);
  }
  const mock = criarMock({ chave, hoje: process.env.MOCK_HOJE || undefined });
  criarServidor(mock).listen(8080, () => console.log('O mock do laboratório escuta na porta 8080.'));
}
