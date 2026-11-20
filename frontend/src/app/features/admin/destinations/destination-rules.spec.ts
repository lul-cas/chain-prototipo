import { DestinationSettings, addressText, bytesOf, destinationProblems, sizeParts, sizeText } from './destination-rules';

const SETTINGS: DestinationSettings = {
  description: null,
  scheme: 'https',
  host: 'api.erp.example',
  port: null,
  pathPrefix: null,
  internal: false,
  allowSecretsOverHttp: false,
  maxRequestBytes: null,
  maxResponseBytes: null,
};
const problems = (change: Partial<DestinationSettings>, name?: string) => destinationProblems({ ...SETTINGS, ...change }, name);

describe("a destination's rules, as the server's Destination checks them (automation.md §3.1, automation-ui.md §3.4)", () => {
  it('passes a valid destination, with a wildcard host, a port, a prefix and sizes', () => {
    expect(problems({ pathPrefix: '/a\uFEFFb' })).toEqual([]); // not whitespace in .NET
    expect(problems({ host: '*.erp.example', port: 8443, pathPrefix: '/v1', maxRequestBytes: 2_097_152 }, 'erp')).toEqual([]);
    expect(problems({ scheme: 'http', internal: true, allowSecretsOverHttp: true }, 'interno.1')).toEqual([]);
  });

  it.each([
    ['', 'invalid_name'],
    ['Erp', 'invalid_name'],
    ['_erp', 'invalid_name'],
    ['a'.repeat(65), 'invalid_name'],
  ])('refuses the name %j', (name, code) => {
    expect(problems({}, name)).toEqual([code]);
  });

  it.each([
    [{ description: 'a'.repeat(501) }, 'description_too_long'],
    [{ description: 'nul\u0000' }, 'invalid_description'],
    [{ scheme: 'ftp' }, 'invalid_scheme'],
    [{ scheme: 'http' }, 'http_requires_internal'],
    [{ allowSecretsOverHttp: true }, 'secrets_over_http_requires_http'],
    [{ host: 'API.erp.example' }, 'invalid_host'],
    [{ host: 'https://api.erp.example' }, 'invalid_host'],
    [{ host: '*.com' }, 'invalid_host'],
    [{ host: '10.0.0.1' }, 'invalid_host'],
    [{ host: '-api.example' }, 'invalid_host'],
    [{ port: 0 }, 'invalid_port'],
    [{ port: 65_536 }, 'invalid_port'],
    [{ pathPrefix: 'v1' }, 'invalid_path_prefix'],
    [{ pathPrefix: '/a/../b' }, 'invalid_path_prefix'],
    [{ pathPrefix: '/a%2Fb' }, 'invalid_path_prefix'],
    [{ pathPrefix: '/a b' }, 'invalid_path_prefix'],
    [{ pathPrefix: '/a\u0085b' }, 'invalid_path_prefix'],
    [{ maxRequestBytes: 1023 }, 'invalid_max_request_bytes'],
    [{ maxResponseBytes: 10_485_761 }, 'invalid_max_response_bytes'],
  ] as const)('refuses %j with %s', (change, code) => {
    expect(problems(change)).toEqual([code]);
  });
});

describe('how a destination is shown (automation-ui.md §3.1)', () => {
  it('writes the address with the port and the prefix only when set', () => {
    expect(addressText({ ...SETTINGS, port: 8443, pathPrefix: '/v1' })).toBe('https://api.erp.example:8443/v1');
    expect(addressText({ ...SETTINGS, host: '*.erp.example' })).toBe('https://*.erp.example');
    expect(addressText({ ...SETTINGS, scheme: 'http', host: 'erp.interno' })).toBe('http://erp.interno');
  });

  it('shows a size in the largest unit that holds it exactly, and reads it back', () => {
    expect(sizeParts(2_097_152)).toEqual({ amount: 2, unit: 'MiB' });
    expect(sizeParts(1536)).toEqual({ amount: 1536, unit: 'bytes' });
    expect(sizeParts(3072)).toEqual({ amount: 3, unit: 'KiB' });
    expect(sizeText(1_048_576)).toBe('1 MiB');
    expect(bytesOf(2, 'MiB')).toBe(2_097_152);
    expect(bytesOf(1, 'KiB')).toBe(1024);
  });
});
