import { Browser, Page, expect, test } from '@playwright/test';
import { adminSession, createReadyUser, unique, withETag } from '../fixtures/api';

// workflow-editor.md §10.1 and §10.2, in a browser: a Modeler opens "Processos", finds a process made through the API drawn on
// the canvas, validates and publishes it, then creates a new process, whose empty draft the server refuses with its problems.
// Then a Modeler builds a process on the canvas by click and keyboard, saves it and publishes it; and one drags (§10.3).

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

async function modeler(name: string): Promise<{ username: string }> {
  const user = await createReadyUser(name, PASSWORD);
  const admin = await adminSession();
  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Modeladores') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${user.id}`)).status()).toBe(204);
  expect((await admin.put(`/api/admin/groups/${group.id}/modeler`)).status()).toBe(204);
  await admin.dispose();
  return user;
}

test('a Modeler sees a process drawn, validates and publishes it, and a new empty process is refused with its problems', async ({ browser }) => {
  const bruno = await createReadyUser('Bruno Modelador', PASSWORD);
  const admin = await adminSession();
  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Modeladores') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${bruno.id}`)).status()).toBe(204);
  expect((await admin.put(`/api/admin/groups/${group.id}/modeler`)).status()).toBe(204);

  const processName = unique('Aprovação simples');
  const workflow = (await (await admin.post('/api/workflows', { data: { name: processName } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [{ id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } }],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req' },
        { id: 'end', type: 'end', label: 'Concluído', laneId: 'lane_req' },
      ],
      flows: [{ id: 'f1', source: 'start', target: 'end' }],
    },
  });
  await admin.dispose();

  const page = await signIn(browser, bruno.username);
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Processos' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Processos' })).toBeVisible();
  await page.getByRole('link', { name: processName }).click();

  await expect(page.getByRole('heading', { level: 1, name: processName })).toBeVisible();
  const canvas = page.getByRole('group', { name: 'Diagrama do processo' });
  await expect(canvas.getByRole('button', { name: 'Área: Solicitantes' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Início: Início' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Fim: Concluído' })).toBeVisible();
  // A straight flow has an empty bounding box, which Playwright counts as hidden, so it is checked as present.
  await expect(canvas.getByRole('button', { name: 'Fluxo de Início para Concluído' })).toBeAttached();
  await expect(page.getByText('Nunca publicado')).toBeVisible();

  await page.getByRole('button', { name: 'Validar' }).click();
  await expect(page.getByText('Nenhum problema encontrado.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 1 publicada.')).toBeVisible();
  await expect(page.getByText('Versão publicada: 1')).toBeVisible();
  // The version, read-only, from Versões (§10.11).
  await page.getByRole('button', { name: 'Versões' }).click();
  await page.getByRole('dialog', { name: 'Versões' }).getByRole('button', { name: 'Ver a versão 1' }).click();
  const version = page.getByRole('dialog', { name: 'Versão 1' });
  await expect(version.getByRole('img', { name: /^Início:/ })).toBeVisible();
  await version.getByRole('button', { name: 'Fechar' }).click();
  await expect(version).toBeHidden();

  // A new process starts empty; publishing it lists what is missing.
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Processos' }).click();
  await page.getByRole('button', { name: 'Novo processo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo processo' });
  const newName = unique('Processo novo');
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(newName);
  await dialog.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByRole('heading', { level: 1, name: newName })).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByRole('region', { name: /problemas?$/ })).toBeVisible();
  await expect(page.getByText('O processo precisa de exatamente um início.')).toBeVisible(); // WF001, in pt-BR (§10.1)
});

test('a Modeler builds a process on the canvas by click and keyboard, is asked before leaving it unsaved, publishes it, and a requester starts it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const carla = await modeler('Carla Modeladora');
  const page = await signIn(browser, carla.username);
  const nav = page.getByRole('navigation', { name: 'Principal' });

  await nav.getByRole('link', { name: 'Processos' }).click();
  await page.getByRole('button', { name: 'Novo processo' }).click();
  const name = unique('Atendimento');
  await page.getByRole('dialog', { name: 'Novo processo' }).getByRole('textbox', { name: 'Nome' }).fill(name);
  await page.getByRole('button', { name: 'Criar' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // The palette adds each node in the middle of the view, focused, so the arrow keys move it at once.
  const canvas = page.getByRole('group', { name: 'Diagrama do processo' });
  await page.getByRole('button', { name: '+ Início' }).click();
  await expect(canvas.getByRole('button', { name: 'Início: Início' })).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await page.getByRole('button', { name: '+ Etapa' }).click();
  await page.getByRole('button', { name: '+ Fim' }).click();
  await expect(canvas.getByRole('button', { name: 'Fim: Fim' })).toBeFocused();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+ArrowRight');
  }
  await expect(page.getByText('Alterações não salvas')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Início' })).toBeDisabled();

  // Connect by pointer: choose the source, "Ligar a…", then the target.
  await canvas.getByRole('button', { name: 'Início: Início' }).click();
  await page.getByRole('button', { name: 'Ligar a…' }).click();
  await expect(page.getByRole('status', { name: 'Situação da edição' })).toHaveText('Escolha o destino do fluxo que sai de “Início”. Esc cancela.');
  await canvas.getByRole('button', { name: 'Etapa: Nova etapa' }).click();
  await expect(canvas.getByRole('button', { name: 'Fluxo de Início para Nova etapa' })).toHaveAttribute('aria-pressed', 'true');

  // Connect by keyboard: the focus goes to the source; Tab reaches the next node, and Enter connects to it.
  await canvas.getByRole('button', { name: 'Etapa: Nova etapa' }).click();
  await page.getByRole('button', { name: 'Ligar a…' }).click();
  await expect(canvas.getByRole('button', { name: 'Etapa: Nova etapa' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(canvas.getByRole('button', { name: 'Fim: Fim' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(canvas.getByRole('button', { name: 'Fluxo de Nova etapa para Fim' })).toHaveAttribute('aria-pressed', 'true');

  // Leaving with unsaved changes asks first.
  await nav.getByRole('link', { name: 'Processos' }).click();
  const leaving = page.getByRole('dialog', { name: 'Sair sem salvar?' });
  await leaving.getByRole('button', { name: 'Continuar editando' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Rename the step in its properties, a side panel (§10.5).
  await canvas.getByRole('button', { name: 'Etapa: Nova etapa' }).click();
  await page.getByRole('button', { name: 'Propriedades…' }).click();
  const panel = page.getByRole('dialog', { name: 'Propriedades' });
  await panel.getByRole('textbox', { name: 'Rótulo' }).fill('Analisar pedido');
  await panel.getByRole('button', { name: 'Aplicar' }).click();
  await expect(panel).toBeHidden();
  await expect(canvas.getByRole('button', { name: 'Etapa: Analisar pedido' })).toBeVisible();

  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await expect(page.getByText('Rascunho salvo.')).toBeVisible();
  await expect(page.getByText('Alterações não salvas')).toBeHidden();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 1 publicada.')).toBeVisible();

  // The draft was saved with its layout: after a reload, everything is where it was.
  await page.reload();
  await expect(canvas.getByRole('button', { name: 'Fluxo de Analisar pedido para Fim' })).toBeAttached();
  await expect(page.getByText('Versão publicada: 1')).toBeVisible();
  const workflowId = new URL(page.url()).pathname.split('/').pop()!;
  await nav.getByRole('link', { name: 'Processos' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Processos' })).toBeVisible(); // nothing unsaved: no question

  // A requester of a group granted start begins it, and finds the request at its first step (workflow-editor.md §10.11).
  const rita = await createReadyUser('Rita Requerente', PASSWORD);
  const admin = await adminSession();
  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Atendimento') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${rita.id}`)).status()).toBe(204);
  await withETag(admin, 'put', `/api/workflows/${workflowId}/grants`, [{ groupId: group.id, capabilities: ['start'] }]);
  await admin.dispose();
  const requester = await signIn(browser, rita.username);
  await requester.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Solicitar' }).click();
  await requester.getByRole('link', { name: `Solicitar ${name}` }).click();
  await requester.getByRole('button', { name: 'Iniciar solicitação' }).click();
  await expect(requester).toHaveURL(/\/solicitacoes\/[0-9a-f-]+$/);
  await requester.getByRole('button', { name: 'Mostrar o fluxo' }).click();
  await expect(requester.getByRole('img', { name: 'Etapa: Analisar pedido, etapa atual' })).toBeVisible();
});

test('a Modeler drags a node, connects by dragging, resizes a lane by its corner, and the draft keeps it all', async ({ browser }) => {
  test.setTimeout(120_000);
  const dora = await modeler('Dora Modeladora');
  const admin = await adminSession();
  const workflow = (await (await admin.post('/api/workflows', { data: { name: unique('Arrastar') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [
        { id: 'lane_a', title: 'Solicitantes', group: { kind: 'requesters' }, layout: { x: 40, y: 40, w: 800, h: 200 } },
        { id: 'lane_b', title: 'Análise', group: { kind: 'requesters' }, layout: { x: 40, y: 260, w: 800, h: 200 } },
      ],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_a', layout: { x: 108, y: 108, w: 64, h: 64 } },
        { id: 'task_1', type: 'task', taskKind: 'human', label: 'Analisar', laneId: 'lane_a', layout: { x: 230, y: 105, w: 140, h: 70 } },
        { id: 'end', type: 'end', label: 'Fim', laneId: 'lane_b', layout: { x: 668, y: 328, w: 64, h: 64 } },
      ],
      flows: [{ id: 'f1', source: 'start', target: 'task_1' }],
    },
  });
  await admin.dispose();

  const page = await signIn(browser, dora.username);
  await page.goto(`/processos/${workflow.id}`);
  const canvas = page.getByRole('group', { name: 'Diagrama do processo' });
  const task = canvas.getByRole('button', { name: 'Etapa: Analisar' });
  await expect(task).toBeVisible();
  const centerOf = async (box: { x: number; y: number; width: number; height: number } | null) => ({
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  });
  const dragBy = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
  };

  // Drag the task 200 px to the right, along its lane.
  // Measured with expect.poll, which waits for the canvas to redraw after each action.
  const before = (await task.boundingBox())!;
  const start = await centerOf(before);
  await dragBy(start, { x: start.x + 200, y: start.y });
  await expect.poll(async () => (await task.boundingBox())!.x - before.x).toBeGreaterThan(150);
  expect(Math.abs((await task.boundingBox())!.y - before.y)).toBeLessThan(2);
  await expect(page.getByText('Alterações não salvas')).toBeVisible();

  // Connect by dragging from the task's exit handle onto the end.
  const exit = await centerOf(await page.locator('[data-handle="task_1"][data-exit]').boundingBox());
  await dragBy(exit, await centerOf(await canvas.getByRole('button', { name: 'Fim: Fim' }).boundingBox()));
  const flow = canvas.getByRole('button', { name: 'Fluxo de Analisar para Fim' });
  await expect(flow).toBeAttached();

  // Connecting selected the new flow, which shows its handles: dragging a bend handle moves the bend, and a double click
  // switches its routing (§10.4). Paths are read with expect.poll, which waits for the redraw.
  const path = async () => flow.locator('.chain-canvas__flow-line').getAttribute('d');
  await expect(flow).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-flow-handle="bend"]')).toHaveCount(2);
  const straightened = await path();
  const bend = await centerOf(await page.locator('[data-flow-handle="bend"]').first().boundingBox());
  await dragBy(bend, { x: bend.x + 25, y: bend.y + 25 });
  await expect.poll(path).not.toBe(straightened);
  const bent = await path();
  await flow.dispatchEvent('dblclick');
  await expect.poll(path).not.toBe(bent);
  await page.keyboard.press('Control+z');
  await expect.poll(path).toBe(bent);

  // Select the second lane by its title band, and resize it by its bottom-right corner; undo and redo it in one step.
  const lane = canvas.getByRole('button', { name: 'Área: Análise' });
  await lane.click({ position: { x: 12, y: 40 } });
  await expect(lane).toHaveAttribute('aria-pressed', 'true');
  const handle = page.locator('[data-lane="lane_b"][data-corner="br"]');
  await handle.scrollIntoViewIfNeeded(); // the corner is below the fold of a 720 px viewport
  const laneBefore = (await lane.boundingBox())!;
  const corner = await centerOf(await handle.boundingBox());
  await dragBy(corner, { x: corner.x + 60, y: corner.y + 40 });
  const width = async () => (await lane.boundingBox())!.width;
  await expect.poll(width).toBeGreaterThan(laneBefore.width + 30);
  expect((await lane.boundingBox())!.height).toBeGreaterThan(laneBefore.height + 20);
  const grown = await width();
  await page.keyboard.press('Control+z');
  await expect.poll(width).toBeCloseTo(laneBefore.width, 0);
  await page.keyboard.press('Control+Shift+Z');
  await expect.poll(width).toBeCloseTo(grown, 0);

  // Rename the second lane in place, on its title band, and give it a group in its panel (§10.6).
  await page.locator('[data-element="lane_b"] .chain-canvas__lane-band').dblclick();
  const rename = page.getByRole('textbox', { name: 'Nome da área' });
  await rename.fill('Análise de pedidos');
  await rename.press('Enter');
  const renamed = canvas.getByRole('button', { name: 'Área: Análise de pedidos' });
  await expect(renamed).toBeAttached();
  await renamed.click({ position: { x: 12, y: 40 } });
  await page.getByRole('button', { name: 'Propriedades…' }).click();
  const lanePanel = page.getByRole('dialog', { name: 'Propriedades da Área' });
  await expect(lanePanel.getByRole('combobox', { name: 'Grupo' })).toBeEnabled(); // the groups have loaded
  await lanePanel.getByRole('combobox', { name: 'Grupo' }).selectOption({ index: 1 });
  await lanePanel.getByRole('button', { name: 'Aplicar' }).click();
  await expect(lanePanel).toBeHidden();

  // Saved, and still there after a reload.
  await page.getByRole('button', { name: 'Salvar rascunho' }).click();
  await expect(page.getByText('Rascunho salvo.')).toBeVisible();
  await page.reload();
  await expect(canvas.getByRole('button', { name: 'Fluxo de Analisar para Fim' })).toBeAttached();
  await page.getByRole('button', { name: 'Visualizar JSON' }).click();
  await expect(page.getByTestId('draft-json')).toContainText('"schemaVersion"');
  const saved = JSON.parse((await page.getByTestId('draft-json').textContent())!) as {
    lanes: { id: string; title: string; group: { kind: string }; layout: { w: number; h: number } }[];
    nodes: { id: string; layout: { x: number; y: number } }[];
  };
  expect(saved.nodes.find((node) => node.id === 'task_1')!.layout.x).toBeGreaterThan(230 + 150);
  expect(saved.nodes.find((node) => node.id === 'task_1')!.layout.y).toBe(105);
  expect(saved.lanes.find((candidate) => candidate.id === 'lane_b')!.layout.w).toBeGreaterThan(800);
  expect(saved.lanes.find((candidate) => candidate.id === 'lane_b')).toMatchObject({ title: 'Análise de pedidos', group: { kind: 'group' } });
});

test('a Modeler decides a gateway automatically, with conditions on start-form fields, a date adjusted, that the server accepts', async ({ browser }) => {
  test.setTimeout(120_000);
  const fabio = await modeler('Fábio Modelador');
  const admin = await adminSession();
  const form = (await (await admin.post('/api/forms', { data: { name: unique('Pedido') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/forms/${form.id}/draft`, {
    document: {
      schemaVersion: 1,
      components: [
        { type: 'text', key: 'cliente', label: 'Cliente', validate: { required: true } },
        { type: 'number', key: 'valor', label: 'Valor', validate: { required: true } },
        { type: 'date', key: 'vencimento', label: 'Vencimento', validate: { required: true } },
      ],
    },
  });
  await withETag(admin, 'post', `/api/forms/${form.id}/publish`);
  const workflow = (await (await admin.post('/api/workflows', { data: { name: unique('Alçada') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [{ id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } }],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req', form: { formId: form.id } },
        { id: 'alto', type: 'gateway', label: 'Valor alto?', laneId: 'lane_req', decisionMode: 'human', question: 'O valor é alto?' },
        { id: 'diretoria', type: 'end', label: 'Diretoria', laneId: 'lane_req' },
        { id: 'fim', type: 'end', label: 'Fim', laneId: 'lane_req' },
      ],
      flows: [
        { id: 'f1', source: 'start', target: 'alto' },
        { id: 'f2', source: 'alto', target: 'diretoria', branch: 'true' },
        { id: 'f3', source: 'alto', target: 'fim', branch: 'false' },
      ],
    },
  });
  await admin.dispose();

  const page = await signIn(browser, fabio.username);
  await page.goto(`/processos/${workflow.id}`);
  const canvas = page.getByRole('group', { name: 'Diagrama do processo' });
  await canvas.getByRole('button', { name: 'Condicional: Valor alto?' }).click();
  await page.getByRole('button', { name: 'Propriedades…' }).click();
  const panel = page.getByRole('dialog', { name: 'Propriedades' });
  await panel.getByRole('combobox', { name: 'Modo de decisão' }).selectOption('automatic');
  await panel.getByRole('button', { name: '+ condição' }).click();
  const data = panel.getByRole('combobox', { name: 'Dado' });
  await expect(data.getByRole('option', { name: 'valor (número)' })).toBeAttached(); // the start form's field, from the catalog
  await data.selectOption('valor');
  await panel.getByRole('combobox', { name: 'Operador' }).selectOption('greaterThan');
  await panel.getByRole('textbox', { name: 'Valor' }).fill('50000');
  await expect(panel.getByTestId('condition-preview')).toHaveText('data.valor > 50000');

  await panel.getByRole('button', { name: '+ condição' }).click(); // a date, against today adjusted (§10.8)
  const second = panel.getByRole('group', { name: 'Condição 2' });
  await second.getByRole('combobox', { name: 'Dado' }).selectOption('vencimento');
  await second.getByRole('combobox', { name: 'Operador' }).selectOption('greaterOrEqual');
  await second.getByRole('combobox', { name: 'Tipo do valor' }).selectOption('system');
  const adjustment = second.getByRole('group', { name: 'Ajuste do valor' });
  await adjustment.getByRole('combobox', { name: 'Ajuste' }).selectOption('-');
  await adjustment.getByRole('textbox', { name: 'Quantidade' }).fill('30');
  await expect(panel.getByTestId('condition-preview')).toHaveText('data.valor > 50000 E data.vencimento ≥ currentDate − 30 dias');
  await panel.getByRole('button', { name: 'Aplicar' }).click();
  await expect(panel).toBeHidden();

  await page.getByRole('button', { name: 'Validar' }).click(); // saves first, then the server type-checks the condition (WF201)
  await expect(page.getByText('Nenhum problema encontrado.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 1 publicada.')).toBeVisible();
});

test('a Modeler makes a step automatic: picks the automation, maps its input from the start form, keeps its output, and publishes', async ({ browser }) => {
  test.setTimeout(120_000);
  const fabio = await modeler('Fábio Automação');
  const admin = await adminSession();
  const destination = unique('stub');
  const created = await admin.post('/api/admin/automation/destinations', {
    data: { name: destination, scheme: 'http', host: 'stub', port: 8080, pathPrefix: '/v1', internal: true, allowSecretsOverHttp: false },
  });
  expect(created.status(), await created.text()).toBe(201);
  const automationName = unique('Consultar CPF');
  const automation = (await (await admin.post('/api/automations', { data: { name: automationName } })).json()) as { id: string };
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
        headers: { Accept: 'application/json' },
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
  const workflow = (await (await admin.post('/api/workflows', { data: { name: unique('Cadastro de cliente') } })).json()) as { id: string };
  await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
    document: {
      schemaVersion: 1,
      lanes: [{ id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } }],
      nodes: [
        { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req', form: { formId: form.id } },
        { id: 'consulta', type: 'task', taskKind: 'human', label: 'Consultar CPF', laneId: 'lane_req' },
        { id: 'fim', type: 'end', label: 'Fim', laneId: 'lane_req' },
      ],
      flows: [
        { id: 'f1', source: 'start', target: 'consulta' },
        { id: 'f2', source: 'consulta', target: 'fim' },
      ],
    },
  });
  await admin.dispose();

  const page = await signIn(browser, fabio.username);
  await page.goto(`/processos/${workflow.id}`);
  await page.getByRole('group', { name: 'Diagrama do processo' }).getByRole('button', { name: 'Etapa: Consultar CPF' }).click();
  await page.getByRole('button', { name: 'Propriedades…' }).click();
  const panel = page.getByRole('dialog', { name: 'Propriedades' });
  await panel.getByRole('combobox', { name: 'Tipo' }).selectOption('automatic');
  await panel.getByRole('combobox', { name: 'Automação' }).selectOption({ label: automationName });
  await expect(panel.getByText('Versão 1')).toBeVisible();
  const cpf = panel.getByRole('group', { name: 'cpf' });
  await cpf.getByRole('combobox', { name: 'Tipo do valor' }).selectOption('path');
  await cpf.getByRole('combobox', { name: 'Dado' }).selectOption('cpf'); // the start form's field, from the catalog
  await panel.getByRole('group', { name: 'situacao' }).getByRole('textbox', { name: 'Guardar como' }).fill('situacaoCpf');
  await panel.getByRole('button', { name: 'Aplicar' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('group', { name: 'Diagrama do processo' }).getByRole('button', { name: 'Etapa automática: Consultar CPF' })).toBeVisible();

  await page.getByRole('button', { name: 'Validar' }).click(); // saves first; the server checks the reference and the inputs (WF104, WF110)
  await expect(page.getByText('Nenhum problema encontrado.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 1 publicada.')).toBeVisible();
});

test('a Modeler calls another process from a step: maps its start form from the parent data, keeps its result, and publishes', async ({ browser }) => {
  test.setTimeout(120_000);
  const fabio = await modeler('Fábio Subprocesso');
  const admin = await adminSession();
  const publishForm = async (name: string, components: unknown[]) => {
    const form = (await (await admin.post('/api/forms', { data: { name: unique(name) } })).json()) as { id: string };
    await withETag(admin, 'put', `/api/forms/${form.id}/draft`, { document: { schemaVersion: 1, components } });
    await withETag(admin, 'post', `/api/forms/${form.id}/publish`);
    return form.id;
  };
  const draft = async (name: string, nodes: unknown[], flows: unknown[]) => {
    const workflow = (await (await admin.post('/api/workflows', { data: { name } })).json()) as { id: string };
    await withETag(admin, 'put', `/api/workflows/${workflow.id}/draft`, {
      document: { schemaVersion: 1, lanes: [{ id: 'lane_req', title: 'Solicitantes', group: { kind: 'requesters' } }], nodes, flows },
    });
    return workflow.id;
  };
  const analise = await publishForm('Análise', [{ type: 'number', key: 'valor', label: 'Valor', validate: { required: true } }]);
  const childName = unique('Análise de risco');
  const child = await draft(
    childName,
    [
      { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req', form: { formId: analise } },
      { id: 'fim', type: 'end', label: 'Fim', laneId: 'lane_req' },
    ],
    [{ id: 'f1', source: 'start', target: 'fim' }],
  );
  await withETag(admin, 'post', `/api/workflows/${child}/publish`);
  const pedido = await publishForm('Pedido', [{ type: 'number', key: 'montante', label: 'Montante', validate: { required: true } }]);
  const parent = await draft(
    unique('Crédito com análise'),
    [
      { id: 'start', type: 'start', label: 'Início', laneId: 'lane_req', form: { formId: pedido } },
      { id: 'analisar', type: 'task', taskKind: 'human', label: 'Analisar risco', laneId: 'lane_req' },
      { id: 'fim', type: 'end', label: 'Fim', laneId: 'lane_req' },
    ],
    [
      { id: 'f1', source: 'start', target: 'analisar' },
      { id: 'f2', source: 'analisar', target: 'fim' },
    ],
  );
  await admin.dispose();

  const page = await signIn(browser, fabio.username);
  await page.goto(`/processos/${parent}`);
  const canvas = page.getByRole('group', { name: 'Diagrama do processo' });
  await canvas.getByRole('button', { name: 'Etapa: Analisar risco' }).click();
  await page.getByRole('button', { name: 'Propriedades…' }).click();
  const panel = page.getByRole('dialog', { name: 'Propriedades' });
  await panel.getByRole('combobox', { name: 'Tipo' }).selectOption('subworkflow');
  await panel.getByRole('combobox', { name: 'Processo' }).selectOption({ label: childName });
  await expect(panel.getByText('Versão 1')).toBeVisible(); // the child's contract (workflow-definition.md §6.5)
  const input = panel.getByRole('group', { name: 'Entradas' }).getByRole('group', { name: 'valor' });
  await input.getByRole('combobox', { name: 'Tipo do valor' }).selectOption('path');
  await input.getByRole('combobox', { name: 'Dado' }).selectOption('montante'); // the parent's start form field, from the catalog
  await panel.getByRole('group', { name: 'Saídas' }).getByRole('group', { name: 'valor' }).getByRole('textbox', { name: 'Guardar como' }).fill('valorAnalisado');
  await panel.getByRole('button', { name: 'Aplicar' }).click();
  await expect(panel).toBeHidden();
  await expect(canvas.getByRole('button', { name: 'Subprocesso: Analisar risco' })).toBeVisible();

  await page.getByRole('button', { name: 'Validar' }).click(); // the server checks the call and its mappings (WF105, WF202, WF203)
  await expect(page.getByText('Nenhum problema encontrado.')).toBeVisible();
  await page.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 1 publicada.')).toBeVisible();
});
