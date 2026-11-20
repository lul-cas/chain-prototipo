import { expect, test } from '@playwright/test';
import { createUser } from '../fixtures/api';

// identity.md, UI: acceptance criteria 1–4, against the real stack.

test('a new user logs in, replaces the temporary password and signs out', async ({ page }) => {
  const user = await createUser('Bruna Teste');
  const password = 'uma-senha-nova-bem-longa';

  await page.goto('/');
  await expect(page).toHaveURL(/\/entrar\?returnUrl=%2Ftarefas$/); // `/` leads to the inbox

  await page.getByRole('textbox', { name: 'Usuário' }).fill(user.username);
  await page.getByLabel('Senha', { exact: true }).fill(user.temporaryPassword);
  await page.getByRole('button', { name: 'Entrar' }).click();

  await expect(page).toHaveURL(/\/trocar-senha/);
  await expect(page.getByRole('status').filter({ hasText: 'Troca obrigatória' })).toBeVisible();
  await page.getByLabel('Senha atual', { exact: true }).fill(user.temporaryPassword);
  await page.getByLabel('Nova senha', { exact: true }).fill(password);
  await page.getByLabel('Confirme a nova senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Trocar senha' }).click();

  await expect(page).toHaveURL(/\/tarefas$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tarefas');
  await expect(page.getByText('Olá, Bruna Teste.')).toBeVisible();
  await expect(page.getByText('Senha alterada.')).toBeVisible();

  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/entrar\?returnUrl=%2Ftarefas$/); // `/` leads to the inbox

  await page.getByRole('textbox', { name: 'Usuário' }).fill(user.username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('Olá, Bruna Teste.')).toBeVisible();
});

test('wrong credentials show one generic message', async ({ page }) => {
  const user = await createUser('Caio Teste');

  await page.goto('/entrar');
  await page.getByRole('textbox', { name: 'Usuário' }).fill(user.username);
  await page.getByLabel('Senha', { exact: true }).fill('nao-e-a-senha');
  await page.getByRole('button', { name: 'Entrar' }).click();

  await expect(page.getByRole('alert')).toContainText('Usuário ou senha inválidos.');
  await expect(page).toHaveURL(/\/entrar$/);
});
