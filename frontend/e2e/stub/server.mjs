// The target of the automation end-to-end test (automation.md §10): a stub on the compose network, reached by the automation
// service through an internal destination. It answers like the ERP of the contract fixtures, and only to the right key, so a
// completed request proves the secret reached it. A CPF that starts with 000 is unknown: 404.
import { createServer } from 'node:http';

const key = process.env.STUB_API_KEY;

function send(response, status, body) {
  response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    const consultation = /^\/v1\/clientes\/([^/]+)\/consultas$/.exec(request.url.split('?')[0]);

    if (!key || request.headers['x-api-key'] !== key) {
      send(response, 401);
    } else if (request.method !== 'POST' || !consultation) {
      send(response, 404);
    } else if (decodeURIComponent(consultation[1]).startsWith('000')) {
      send(response, 404, { erro: 'cliente desconhecido' });
    } else {
      send(response, 200, { resultado: { situacao: 'regular', score: 812 } });
    }
  });
}).listen(8080, () => console.log('The automation stub listens on 8080.'));
