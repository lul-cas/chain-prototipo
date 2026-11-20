import { ComponentType } from '../../../forms/model';
import { PaletteType } from './form-edits';

/** One entry of the palette (form-designer.md §6): its group, its name, and the type it adds. */
export interface PaletteEntry {
  readonly group: 'Entrada' | 'Seleção' | 'Apresentação' | 'Contêineres';
  readonly name: string;
  readonly type: PaletteType;
}

/** The POC's groups and names, limited to Chain's types (§6). A time or a datetime is a *Data e hora* with another subtype. */
export const PALETTE: readonly PaletteEntry[] = [
  { group: 'Entrada', name: 'Campo de texto', type: 'text' },
  { group: 'Entrada', name: 'Área de texto', type: 'textarea' },
  { group: 'Entrada', name: 'Número', type: 'number' },
  { group: 'Entrada', name: 'Data e hora', type: 'date' },
  { group: 'Entrada', name: 'Campo calculado', type: 'computed' },
  { group: 'Entrada', name: 'Seletor de arquivo', type: 'file' },
  { group: 'Seleção', name: 'Caixa de seleção', type: 'checkbox' },
  { group: 'Seleção', name: 'Grupo de caixas de seleção', type: 'checklist' },
  { group: 'Seleção', name: 'Grupo de opções', type: 'radio' },
  { group: 'Seleção', name: 'Selecionar', type: 'select' },
  { group: 'Apresentação', name: 'Título', type: 'heading' },
  { group: 'Apresentação', name: 'Parágrafo', type: 'paragraph' },
  { group: 'Apresentação', name: 'Separador', type: 'separator' },
  { group: 'Contêineres', name: 'Grupo', type: 'group' },
  { group: 'Contêineres', name: 'Lista dinâmica', type: 'dynamicList' },
];

export function paletteName(type: PaletteType): string {
  return PALETTE.find((entry) => entry.type === type)?.name ?? type;
}

/** Each type's name on cards and in the status line: the palette's words, and the subtypes of *Data e hora* (§6, §7.1). */
export const TYPE_NAME: Readonly<Record<ComponentType, string>> = {
  text: 'Campo de texto',
  textarea: 'Área de texto',
  number: 'Número',
  date: 'Data',
  time: 'Hora',
  datetime: 'Data e hora',
  computed: 'Campo calculado',
  file: 'Seletor de arquivo',
  checkbox: 'Caixa de seleção',
  checklist: 'Grupo de caixas de seleção',
  radio: 'Grupo de opções',
  select: 'Selecionar',
  heading: 'Título',
  paragraph: 'Parágrafo',
  separator: 'Separador',
  group: 'Grupo',
  dynamicList: 'Lista dinâmica',
};
