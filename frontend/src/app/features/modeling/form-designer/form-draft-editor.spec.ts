import { FormDocument } from '../../../forms/model';
import { FormDraftEditor } from './form-draft-editor';

const SAVED: FormDocument = {
  schemaVersion: 1,
  components: [
    { type: 'text', key: 'nome', label: 'Nome' },
    { type: 'group', key: 'endereco', label: 'Endereço', components: [{ type: 'text', key: 'cep', label: 'CEP' }] },
    { type: 'number', key: 'valor', label: 'Valor' },
  ],
};

const keys = (editor: FormDraftEditor) => editor.saveable().components.map((component) => component.key ?? component.type);
const idOf = (editor: FormDraftEditor, key: string): string => {
  const walk = (components: ReturnType<FormDraftEditor['document']>['components']): string | undefined =>
    components.map((component) => (component.key === key ? component.id : walk(component.components ?? []))).find(Boolean);
  return walk(editor.document().components)!;
};

describe('FormDraftEditor (form-designer.md §4.4)', () => {
  let editor: FormDraftEditor;

  beforeEach(() => {
    editor = new FormDraftEditor();
    editor.load(SAVED);
  });

  it('starts from the saved draft, with nothing to save or undo', () => {
    expect(editor.saveable()).toEqual(SAVED);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);
    expect(editor.selection()).toBeNull();
  });

  it('adds where §7.3 says, selects the new component, and says what was added', () => {
    editor.select(idOf(editor, 'nome'));
    const id = editor.add('number')!;

    expect(keys(editor)).toEqual(['nome', 'numero', 'endereco', 'valor']);
    expect(editor.selection()).toBe(id);
    expect(editor.notice()).toBe('Adicionado: Número.');
    expect(editor.dirty()).toBe(true);

    editor.select(idOf(editor, 'endereco'));
    editor.add('text');
    expect(editor.saveable().components[2].components!.map((component) => component.key)).toEqual(['cep', 'campo_de_texto']);
  });

  it('refuses an addition past the limits, says why, and changes nothing (§7.5)', () => {
    editor.load({ schemaVersion: 1, components: Array.from({ length: 200 }, (_, i) => ({ type: 'text' as const, key: `c${i}`, label: 'C' })) });

    expect(editor.add('text')).toBeNull();
    expect(editor.notice()).toBe('O formulário já tem 200 componentes.');
    expect(editor.saveable().components.length).toBe(200);
    expect(editor.canUndo()).toBe(false);
  });

  it('removes the selection with its children, and selects the next component, else the previous, else the container', () => {
    editor.select(idOf(editor, 'endereco'));
    editor.remove();
    expect(keys(editor)).toEqual(['nome', 'valor']);
    expect(editor.selection()).toBe(idOf(editor, 'valor'));
    expect(editor.notice()).toBe('Excluído: Endereço.');

    editor.remove();
    expect(editor.selection()).toBe(idOf(editor, 'nome'));

    editor.load(SAVED);
    const group = idOf(editor, 'endereco');
    editor.select(idOf(editor, 'cep'));
    editor.remove();
    expect(editor.selection()).toBe(group);
  });

  it('moves the selection up and down, out of groups at their edges (Alt+↑ and Alt+↓, §7.2)', () => {
    editor.select(idOf(editor, 'cep'));

    editor.moveDown();
    expect(keys(editor)).toEqual(['nome', 'endereco', 'cep', 'valor']); // out of the group, just after it
    editor.moveUp();
    expect(keys(editor)).toEqual(['nome', 'cep', 'endereco', 'valor']); // past the group as a whole
    editor.moveUp();
    expect(keys(editor)).toEqual(['cep', 'nome', 'endereco', 'valor']);
    expect(editor.selection()).toBe(idOf(editor, 'cep'));

    const top = editor.document();
    editor.moveUp();
    expect(editor.document()).toBe(top); // nothing above the top, and no step to undo
  });

  it('moves to a place chosen in Mover para…, and refuses one past the depth limit', () => {
    editor.select(idOf(editor, 'valor'));
    editor.moveTo({ parent: idOf(editor, 'endereco'), index: 0 });
    expect(editor.saveable().components[1].components!.map((component) => component.key)).toEqual(['valor', 'cep']);

    editor.load({
      schemaVersion: 1,
      components: [
        { type: 'group', key: 'a', label: 'A', components: [{ type: 'group', key: 'b', label: 'B', components: [{ type: 'text', key: 'x', label: 'X' }] }] },
        { type: 'group', key: 'c', label: 'C', components: [{ type: 'group', key: 'd', label: 'D', components: [{ type: 'text', key: 'y', label: 'Y' }] }] },
      ],
    });
    editor.select(idOf(editor, 'c'));
    editor.moveTo({ parent: idOf(editor, 'b'), index: 0 });
    expect(editor.notice()).toBe('Grupos e listas aninham até 3 níveis.');
    expect(editor.dirty()).toBe(false);
  });

  it("changes properties, and a new field's key follows its label (§8.2)", () => {
    const id = editor.add('text')!;

    editor.change(id, { label: 'Valor solicitado' });

    expect(editor.saveable().components[3]).toEqual({ type: 'text', key: 'valor_solicitado', label: 'Valor solicitado' });
  });

  it('undoes and redoes each change, keeping the selection while it exists', () => {
    const id = editor.add('checkbox')!;
    editor.change(id, { label: 'Aceito' });

    editor.undo();
    expect(editor.saveable().components[3].label).toBe('Caixa de seleção');
    editor.undo();
    expect(keys(editor)).toEqual(['nome', 'endereco', 'valor']);
    expect(editor.selection()).toBeNull();
    expect(editor.dirty()).toBe(false);

    editor.redo();
    editor.redo();
    expect(editor.saveable().components[3].label).toBe('Aceito');
    expect(editor.canRedo()).toBe(false);
  });

  it('keeps at most 200 steps of history', () => {
    const id = editor.add('text')!;
    for (let i = 0; i < 205; i++) {
      editor.change(id, { placeholder: `${i}` });
    }
    let steps = 0;
    while (editor.canUndo()) {
      editor.undo();
      steps++;
    }
    expect(steps).toBe(200);
  });

  it('is saved once the server has the document that was sent, even if editing went on meanwhile', () => {
    editor.add('text');
    const sent = editor.document();
    editor.add('number');

    editor.markSaved(sent);
    expect(editor.dirty()).toBe(true);

    editor.markSaved(editor.document());
    expect(editor.dirty()).toBe(false);
  });

  it('discards the changes back to the saved draft', () => {
    editor.add('text');
    editor.discard();

    expect(editor.saveable()).toEqual(SAVED);
    expect(editor.dirty()).toBe(false);
    expect(editor.canUndo()).toBe(false);
  });
});
