import { groupDescriptionProblem, groupNameProblem } from './group-rules';

describe('group rules (admin-ui.md §5.1; identity.md I2)', () => {
  it('takes a name of 1 to 100 characters around spaces, of text the server can store', () => {
    expect(groupNameProblem('Crédito')).toBeNull();
    expect(groupNameProblem(`  ${'x'.repeat(100)} `)).toBeNull();

    expect(groupNameProblem('   ')).toBe('invalid_group_name');
    expect(groupNameProblem('x'.repeat(101))).toBe('invalid_group_name');
    expect(groupNameProblem('Crédito\u0000')).toBe('invalid_group_name');
  });

  it('takes an empty description, or one of at most 500 characters around spaces, of text the server can store', () => {
    expect(groupDescriptionProblem('')).toBeNull();
    expect(groupDescriptionProblem(` ${'x'.repeat(500)}  `)).toBeNull();

    expect(groupDescriptionProblem('x'.repeat(501))).toBe('description_too_long');
    expect(groupDescriptionProblem('Análise \uDC00')).toBe('invalid_description');
  });
});
