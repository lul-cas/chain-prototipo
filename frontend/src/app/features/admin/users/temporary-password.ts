import { DialogService } from '../../../ui/dialog/dialog.service';
import { SecretOnceData, SecretOnceDialog } from '../secret-once-dialog';

/** Shows a new user's, or a reset, temporary password once (admin-ui.md §4.3). Nothing else keeps it. */
export function showTemporaryPassword(dialogs: DialogService, username: string, password: string): void {
  dialogs.open<void, SecretOnceData>(SecretOnceDialog, {
    data: {
      title: `Senha temporária de ${username}`,
      label: 'Senha temporária',
      value: password,
      note: 'Esta senha aparece só agora. Entregue-a ao usuário por um canal seguro; ele vai trocá-la no primeiro acesso.',
    },
  });
}
