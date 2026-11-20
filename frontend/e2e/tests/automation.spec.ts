import { Browser, Page, expect, test } from '@playwright/test';
import { adminSession, createReadyUser, unique, withETag } from '../fixtures/api';

// automation.md §10, end to end: a workflow with an automation step against the stub target on the compose network (an internal
// destination), through to completion, and a failing variant that ends in an incident. The stub answers only to the secret's
// value, which e2e/run.sh makes random for each run, so a completed request proves the secret reached the target.

const PASSWORD = 'uma-senha-nova-bem-longa';

async function signIn(browser: Browser, username: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/entrar');
  await page.getByRole('textbox', { name: 'Usuário' }).fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  return page;
}

async function startRequest(page: Page, workflowName: string, cpf: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Solicitar' }).click();
  await page.getByRole('link', { name: `Solicitar ${workflowName}` }).click();
  await page.getByRole('textbox', { name: 'CPF' }).fill(cpf);
  await page.getByRole('button', { name: 'Iniciar solicitação' }).click();
  await expect(page).toHaveURL(/\/solicitacoes\/[0-9a-f-]+$/);
}

/** The step runs in the automation service; the page shows its result after a reload. */
async function expectStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(status, { exact: true })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
}

test('an automation step calls the target with its secret and merges the answer; a failing call ends in an incident', async ({ browser }) => {
  // Two requests wait for the automation service (up to 45 s each, see expectStatus), beyond the default 30 s per test.
  test.setTimeout(120_000);
  const key = process.env['CHAIN_E2E_STUB_KEY'];
  expect(key, 'e2e/run.sh sets the stub key').toBeTruthy();

  const ana = await createReadyUser('Ana Automação', PASSWORD);
  const admin = await adminSession();
  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Cadastro') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${ana.id}`)).status()).toBe(204);

  // The stub is a service of the deployment: an internal destination on the compose network, over http with the admin's consent.
  const destination = unique('stub');
  const created = await admin.post('/api/admin/automation/destinations', {
    data: { name: destination, scheme: 'http', host: 'stub', port: 8080, pathPrefix: '/v1', internal: true, allowSecretsOverHttp: true },
  });
  expect(created.status(), await created.text()).toBe(201);
  const secret = unique('chave');
  const stored = await admin.post('/api/admin/automation/secrets', { data: { name: secret, value: key, allowedDestinations: [destination] } });
  expect(stored.status(), await stored.text()).toBe(201);

  const automation = (await (await admin.post('/api/automations', { data: { name: unique('Consultar CPF') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/automations/${automation.id}/draft`, {
    document: {
      schemaVersion: 1,
      kind: 'http',
      inputs: [{ key: 'cpf', type: 'text', required: true }],
      request: {
        method: 'POST',
        destination,
        path: '/v1/clientes/{cpf}/consultas',
        query: {},
        headers: { 'X-Api-Key': `{{secret:${secret}}}`, Accept: 'application/json' },
        auth: null,
        body: { type: 'json', keys: ['cpf'] },
      },
      response: { type: 'json' },
      outputs: [{ key: 'situacao', type: 'text', required: true, source: 'body', path: ['resultado', 'situacao'] }],
    },
  });
  await withETag(admin, 'post', `/api/automations/${automation.id}/publish`);

  const form = (await (await admin.post('/api/forms', { data: { name: unique('Cadastro') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/forms/${form.id}/draft`, {
    document: { schemaVersion: 1, components: [{ type: 'text', key: 'cpf', label: 'CPF', validate: { required: true } }] },
  });
  await withETag(admin, 'post', `/api/forms/${form.id}/publish`);

  const workflowName = unique('Cadastro com consulta');
  const workflow = (await (await admin.post('/api/workflows', { data: { name: workflowName } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', form: { formId: form.id } },
        {
          id: 'consulta',
          type: 'task',
          taskKind: 'automation',
          label: 'Consultar CPF',
          automation: {
            automationId: automation.id,
            inputs: { cpf: { kind: 'path', path: ['cpf'] } },
            outputs: { situacao_cpf: { kind: 'path', path: ['situacao'] } },
          },
        },
        { id: 'end', type: 'end', label: 'Fim' },
      ],
      flows: [
        { id: 'f1', source: 'start', target: 'consulta' },
        { id: 'f2', source: 'consulta', target: 'end' },
      ],
    },
  });
  await withETag(admin, 'post', `/api/workflows/${workflow.id}/publish`);
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/grants`, [{ groupId: group.id, capabilities: ['start'] }]);
  await admin.dispose();

  // Ana starts a request; the step calls the stub with the secret, and its answer is mapped into the request's data.
  const page = await signIn(browser, ana.username);
  await startRequest(page, workflowName, '123.456.789-09');
  await expectStatus(page, 'Concluída');
  await expect(page.getByRole('region', { name: 'Dados' }).getByText('regular', { exact: true })).toBeVisible();
  // The timeline reads the step's events as sentences that name the step (requests-ui.md §6.1, card #139).
  const timeline = page.getByRole('region', { name: 'Linha do tempo' });
  await expect(timeline.getByText('Etapa automática Consultar CPF iniciada')).toBeVisible();
  await expect(timeline.getByText('Etapa automática Consultar CPF concluída')).toBeVisible();

  // The stub does not know this client: a 404 is final, and the request shows the incident.
  await startRequest(page, workflowName, '000.000.000-00');
  await expectStatus(page, 'Com falha');
  const incidents = page.getByRole('region', { name: 'Incidentes' });
  await expect(incidents.getByText('A etapa automática falhou.')).toBeVisible();
  await expect(incidents.getByText('automation_failed', { exact: true })).toBeVisible();
  await expect(incidents.getByText('http_status: The target answered HTTP 404.')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Linha do tempo' }).getByText(/Etapa automática Consultar CPF falhou.*: o sistema de destino respondeu com erro HTTP 404/),
  ).toBeVisible();
});
