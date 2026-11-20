import { isValidHost } from './host-name';

describe('isValidHost (Destination.IsValidHost)', () => {
  it('accepts lowercase DNS names and wildcards of two labels or more', () => {
    for (const host of ['api.erp.example', 'localhost', 'a-b.example', '*.erp.example', 'x1.example']) {
      expect(isValidHost(host)).toBe(true);
    }
  });

  it('refuses addresses, capitals, ports, user info, paths and bad labels', () => {
    for (const host of ['', '10.0.0.1', 'API.erp.example', 'erp.example:8443', 'user@erp.example', 'erp.example/v1', '-a.example', 'a-.example', '*.example', '*', 'a..example', `${'a'.repeat(64)}.example`]) {
      expect(isValidHost(host)).toBe(false);
    }
  });
});
