import { expect, test } from '@playwright/test';
import { adminSession, apiSession, createReadyUser, unique, withETag } from '../fixtures/api';

// requests-ui.md §1.7, criterion 1, against the real stack: a form step is completed in the browser and the request moves on.

test('a requester fills the first step of a request and completes it', async ({ page }) => {
  const password = 'uma-senha-nova-bem-longa';
  const requester = await createReadyUser('Rita Teste', password);
  const admin = await adminSession();

  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Comercial') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${requester.id}`)).status()).toBe(204);

  const form = (await (await admin.post('/api/forms', { data: { name: unique('Proposta') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/forms/${form.id}/draft`, {
    document: {
      schemaVersion: 1,
      components: [
        { type: 'text', key: 'cliente', label: 'Cliente', validate: { required: true } },
        { type: 'number', key: 'valor', label: 'Valor solicitado', validate: { required: true, min: 1000, decimalDigits: 2 } },
      ],
    },
  });
  await withETag(admin, 'post', `/api/forms/${form.id}/publish`);

  const workflow = (await (await admin.post('/api/workflows', { data: { name: unique('Concessão') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [{ id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } }],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req' },
        { id: 'fill', type: 'task', taskKind: 'human', label: 'Preencher proposta', laneId: 'lane_req', form: { formId: form.id } },
        { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_req' },
      ],
      flows: [
        { id: 'f1', source: 'start', target: 'fill' },
        { id: 'f2', source: 'fill', target: 'end' },
      ],
    },
  });
  await withETag(admin, 'post', `/api/workflows/${workflow.id}/publish`);
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/grants`, [{ groupId: group.id, capabilities: ['start'] }]);
  await admin.dispose();

  const api = await apiSession(requester.username, password);
  const started = await api.post('/api/instances', { data: { definitionId: workflow.id }, headers: { 'Idempotency-Key': unique('start') } });
  expect(started.status()).toBe(201);
  const request = (await started.json()) as { id: string; openTasks: { id: string }[] };

  await page.goto('/entrar');
  await page.getByRole('textbox', { name: 'Usuário' }).fill(requester.username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/tarefas$/);

  await page.goto(`/tarefas/${request.openTasks[0].id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preencher proposta');
  await expect(page.getByText('Disponível para quem solicitou')).toBeVisible();
  await page.getByRole('textbox', { name: 'Cliente' }).fill('ACME Ltda.');
  await page.getByRole('textbox', { name: 'Valor solicitado' }).fill('999,99');
  await page.getByRole('textbox', { name: 'Comentário (opcional)' }).fill('Proposta enviada pelo navegador');
  await page.getByRole('button', { name: 'Concluir' }).click();

  // The browser refuses the value below the minimum before anything is sent.
  await expect(page.getByRole('link', { name: 'Valor solicitado: O valor mínimo é 1000.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Valor solicitado' }).fill('2500,75');
  await page.getByRole('button', { name: 'Concluir' }).click();

  await expect(page).toHaveURL(/\/tarefas$/);
  await expect(page.getByText('Tarefa concluída.')).toBeVisible();

  const after = (await (await api.get(`/api/instances/${request.id}`)).json()) as {
    status: string;
    data: Record<string, unknown>;
    timeline: { type: string; details: Record<string, unknown> }[];
  };
  expect(after.status).toBe('completed');
  expect(after.data).toMatchObject({ cliente: 'ACME Ltda.', valor: 2500.75 });
  expect(after.timeline.find((event) => event.type === 'task.completed')?.details['comment']).toBe('Proposta enviada pelo navegador');
  await api.dispose();
});
