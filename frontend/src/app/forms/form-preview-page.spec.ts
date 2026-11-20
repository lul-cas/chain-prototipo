import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../../testing/axe';
import { FormPreviewPage } from './form-preview-page';

describe('FormPreviewPage (development only)', () => {
  it('renders the sample and shows what a valid submit would send', async () => {
    await render(FormPreviewPage);
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: 'Pessoa física' }));
    await user.type(screen.getByRole('textbox', { name: 'CPF' }), '529.982.247-25');
    await user.click(screen.getByRole('checkbox', { name: 'RG' }));
    await user.type(screen.getByRole('textbox', { name: 'CEP' }), '01310-100');
    await user.click(screen.getByRole('checkbox', { name: 'Li e aceito os termos' }));
    await user.click(screen.getByRole('button', { name: 'Concluir' }));

    expect(screen.getByLabelText('Dados enviados').textContent).toBe(
      '{"tipo":"pf","cpf":"529.982.247-25","quantidade":null,"parcela":null,"modalidade":null,"documentos":["rg"],"inicio":null,"horario":null,' +
        '"reuniao":null,"observacoes":null,"contrato":null,"endereco":{"cep":"01310-100","logradouro":null},"aceite":true}',
    );
    await expectNoAxeViolations();
  });
});
