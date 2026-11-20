import { expect, test } from '@playwright/test';
import { adminSession, createReadyUser, unique } from '../fixtures/api';

// design-system.md, Dialog (#117): a dialog's actions sit at the end of its footer, with a gap between them. This needs a
// browser: jsdom lays nothing out. "Novo processo" stands for every dialog, since they share the layout.
const PASSWORD = 'uma-senha-nova-bem-longa';

test('a dialog lays out its actions at the end of its footer, with a gap between them', async ({ browser }) => {
  const user = await createReadyUser('Elisa Modeladora', PASSWORD);
  const admin = await adminSession();
  const group = (await (await admin.post('/api/admin/groups', { data: { name: unique('Modeladores') } })).json()) as { id: string };
  expect((await admin.put(`/api/admin/groups/${group.id}/members/${user.id}`)).status()).toBe(204);
  expect((await admin.put(`/api/admin/groups/${group.id}/modeler`)).status()).toBe(204);
  await admin.dispose();

  const page = await (await browser.newContext()).newPage();
  await page.goto('/entrar');
  await page.getByRole('textbox', { name: 'Usuário' }).fill(user.username);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/tarefas$/);
  await page.goto('/processos');
  await page.getByRole('button', { name: 'Novo processo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo processo' });
  await expect(dialog).toBeVisible();

  const cancel = (await dialog.getByRole('button', { name: 'Cancelar' }).boundingBox())!;
  const create = (await dialog.getByRole('button', { name: 'Criar' }).boundingBox())!;
  const frame = (await dialog.boundingBox())!;
  expect(create.x - (cancel.x + cancel.width)).toBeGreaterThanOrEqual(6); // a gap of space-2, 8 px
  expect(frame.x + frame.width - (create.x + create.width)).toBeLessThan(40); // at the end, inside the 24 px padding
  expect(Math.abs(create.y - cancel.y)).toBeLessThan(2); // on one row
});
