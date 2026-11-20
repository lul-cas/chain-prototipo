import { displayNameProblem, usernameProblem } from './user-rules';

describe('user rules (admin-ui.md §4.1; identity.md I2)', () => {
  it('takes a username of 3 to 64 characters from a-z, digits, dot, hyphen and underscore, around spaces', () => {
    for (const username of ['ana', 'ana.souza', 'a_1-b', '  ana  ', '123', 'x'.repeat(64)]) {
      expect(usernameProblem(username)).toBeNull();
    }
  });

  it('refuses a username that is short, long, uppercase, accented, spaced or with other symbols', () => {
    for (const username of ['', 'an', '  an  ', 'x'.repeat(65), 'Ana', 'joão', 'ana souza', 'ana@x', 'ana\u0000', 'anaK']) {
      expect(usernameProblem(username)).toBe('invalid_username');
    }
  });

  it('takes a display name of 1 to 200 characters around spaces, of text the server can store', () => {
    expect(displayNameProblem('Ana Souza')).toBeNull();
    expect(displayNameProblem(`  ${'x'.repeat(200)} `)).toBeNull();
    expect(displayNameProblem('😀'.repeat(100))).toBeNull(); // 200 UTF-16 units, as the server counts

    expect(displayNameProblem('   ')).toBe('invalid_display_name');
    expect(displayNameProblem('x'.repeat(201))).toBe('invalid_display_name');
    expect(displayNameProblem('Ana\u0000')).toBe('invalid_display_name');
    expect(displayNameProblem('Ana \uD800')).toBe('invalid_display_name');
  });
});
