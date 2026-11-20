import { Browser, Page, expect, test } from '@playwright/test';
import { adminSession, createReadyUser, unique, withETag } from '../fixtures/api';

// requests-ui.md §7, criterion 6: the credit journey in two browsers against the real stack. Ana starts a request through its
// start form, Bruno finds the analysis in "Do grupo", completes it and approves the decision, and Ana sees the request done.

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

test('Ana starts a credit request, Bruno analyses and approves it, and Ana sees it completed', async ({ browser }) => {
  const ana = await createReadyUser('Ana Teste', PASSWORD);
  const bruno = await createReadyUser('Bruno Teste', PASSWORD);
  const admin = await adminSession();
  const group = async (name: string, member: string) => {
    const created = (await (await admin.post('/api/admin/groups', { data: { name: unique(name) } })).json()) as { id: string };
    expect((await admin.put(`/api/admin/groups/${created.id}/members/${member}`)).status()).toBe(204);
    return created.id;
  };
  const comercial = await group('Comercial', ana.id);
  const analistas = await group('Analistas', bruno.id);

  const form = (await (await admin.post('/api/forms', { data: { name: unique('Proposta') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/forms/${form.id}/draft`, {
    document: {
      schemaVersion: 1,
      components: [
        { type: 'text', key: 'cliente', label: 'Cliente', validate: { required: true } },
        { type: 'number', key: 'valor', label: 'Valor solicitado', validate: { required: true, min: 1000 } },
        { type: 'file', key: 'documento', label: 'Documento' },
      ],
    },
  });
  await withETag(admin, 'post', `/api/forms/${form.id}/publish`);

  const workflowName = unique('Concessão de Crédito');
  const workflow = (await (await admin.post('/api/workflows', { data: { name: workflowName } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [
        { id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } },
        { id: 'lane_an', title: 'Análise', group: { kind: 'group', groupId: analistas } },
      ],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req', form: { formId: form.id } },
        { id: 'analyse', type: 'task', taskKind: 'human', label: 'Analisar proposta', laneId: 'lane_an' },
        { id: 'docs_ok', type: 'gateway', label: 'Docs ok?', laneId: 'lane_an', decisionMode: 'human', question: 'A documentação está correta?' },
        { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_an' },
      ],
      flows: [
        { id: 'f1', source: 'start', target: 'analyse' },
        { id: 'f2', source: 'analyse', target: 'docs_ok' },
        { id: 'f3', source: 'docs_ok', target: 'end', branch: 'true' },
        { id: 'f4', source: 'docs_ok', target: 'analyse', branch: 'false' },
      ],
    },
  });
  await withETag(admin, 'post', `/api/workflows/${workflow.id}/publish`);
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/grants`, [{ groupId: comercial, capabilities: ['start'] }]);
  await admin.dispose();

  // Ana starts the request through its start form.
  const anaPage = await signIn(browser, ana.username);
  await anaPage.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Solicitar' }).click();
  await anaPage.getByRole('link', { name: `Solicitar ${workflowName}` }).click();
  await anaPage.getByRole('textbox', { name: 'Cliente' }).fill('ACME Ltda.');
  await anaPage.getByRole('textbox', { name: 'Valor solicitado' }).fill('50000');
  // A file is uploaded as soon as it is chosen, then referenced by the start (forms.md F3, "File fields").
  await anaPage.getByLabel('Documento').setInputFiles({ name: 'proposta.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  const download = anaPage.waitForEvent('download');
  await anaPage.getByRole('link', { name: 'proposta.pdf' }).click(); // its uploader can download it while pending (ADR-0014 §4.4)
  expect((await download).suggestedFilename()).toBe('proposta.pdf');
  await anaPage.getByRole('button', { name: 'Iniciar solicitação' }).click();
  await expect(anaPage).toHaveURL(/\/solicitacoes\/[0-9a-f-]+$/);
  await expect(anaPage.getByText('Solicitação iniciada.')).toBeVisible();
  await expect(anaPage.getByText('Em andamento', { exact: true })).toBeVisible();
  await expect(anaPage.getByRole('link', { name: 'Analisar proposta' })).toBeVisible();
  const requestUrl = anaPage.url();
  // The flow shows where the request is (workflow-editor.md §10.11).
  await anaPage.getByRole('button', { name: 'Mostrar o fluxo' }).click();
  await expect(anaPage.getByRole('img', { name: 'Etapa: Analisar proposta, etapa atual' })).toBeVisible();
  // The data links the file sent with the start, and Ana comments with another (requests-ui.md §6; card #34, N8b).
  await expect(anaPage.getByRole('region', { name: 'Dados' }).getByRole('link', { name: 'proposta.pdf' })).toBeVisible();
  await anaPage.getByRole('textbox', { name: 'Comentário' }).fill('Segue o comprovante de renda');
  await anaPage.getByLabel('Anexos').setInputFiles({ name: 'comprovante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  await expect(anaPage.getByRole('link', { name: 'comprovante.pdf' })).toBeVisible();
  await anaPage.getByRole('button', { name: 'Comentar' }).click();
  await expect(anaPage.getByText('Comentário enviado.')).toBeVisible();
  const timeline = anaPage.getByRole('region', { name: 'Linha do tempo' });
  await expect(timeline.getByText('Segue o comprovante de renda', { exact: true })).toBeVisible();
  await expect(timeline.getByRole('link', { name: 'comprovante.pdf' })).toHaveAttribute('href', /^\/api\/files\/[0-9a-f-]+$/);

  // Bruno finds the analysis in his group, completes it, then approves the decision.
  const brunoPage = await signIn(browser, bruno.username);
  await expect(brunoPage.getByRole('tab', { name: 'Do grupo (1)' })).toHaveAttribute('aria-selected', 'true');
  await brunoPage.getByRole('link', { name: /Analisar proposta/ }).click();
  await brunoPage.getByRole('textbox', { name: 'Comentário (opcional)' }).fill('Documentos conferidos');
  await brunoPage.getByRole('button', { name: 'Concluir' }).click();
  await expect(brunoPage).toHaveURL(/\/tarefas$/);
  await brunoPage.getByRole('link', { name: /Docs ok\?/ }).click();
  await expect(brunoPage.getByText('A documentação está correta?')).toBeVisible();
  await brunoPage.getByRole('textbox', { name: 'Justificativa (opcional)' }).fill('Tudo certo');
  await brunoPage.getByRole('button', { name: 'Sim' }).click();
  await expect(brunoPage.getByText('Decisão registrada.')).toBeVisible();

  // Ana sees the request completed, with what happened.
  await anaPage.goto(requestUrl);
  await expect(anaPage.getByText('Concluída', { exact: true })).toBeVisible();
  await expect(anaPage.getByText(/Bruno Teste.*concluiu Analisar proposta/)).toBeVisible();
  await expect(anaPage.getByText('Documentos conferidos', { exact: true })).toBeVisible(); // quoted by <q>
  await expect(anaPage.getByText(/Bruno Teste.*respondeu Docs ok\?: Sim/)).toBeVisible();
  await expect(anaPage.getByRole('region', { name: 'Dados' }).getByText('ACME Ltda.')).toBeVisible();
});
