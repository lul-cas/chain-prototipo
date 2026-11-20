// The built-in text formats of forms.md F1, written as the server's (Chain.Forms/FieldRules.cs). Both run the shared vectors
// in specs/testing/form-vectors/formats.json.

// Whitespace that .NET and JavaScript both count. Their \s differ: only .NET's matches U+0085, only JavaScript's U+FEFF (#124).
const WHITESPACE = String.raw`\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000`;
// An email refuses whitespace in either reading, so U+0085 and U+FEFF too (#124).
const EMAIL_PART = String.raw`[^@${WHITESPACE}\u0085\uFEFF]+`;

const EMAIL = new RegExp(String.raw`^${EMAIL_PART}@${EMAIL_PART}\.${EMAIL_PART}$`);
const CPF = /^[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}$/;
const CNPJ = /^[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}\/?[0-9]{4}-?[0-9]{2}$/;
// A phone's only separator is the plain space, besides its punctuation (owner, 2026-10-19, #124).
const PHONE = /^\+?[0-9() -]{8,20}$/;
const CEP = /^[0-9]{5}-?[0-9]{3}$/;

const CNPJ_FIRST = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_SECOND = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function isValidFormat(format: string, value: string): boolean {
  switch (format) {
    case 'email':
      return value.length <= 254 && EMAIL.test(value);
    case 'cpf':
      return isCpf(value);
    case 'cnpj':
      return isCnpj(value);
    case 'phone':
      return isPhone(value);
    case 'cep':
      return CEP.test(value);
    default:
      return false;
  }
}

function digits(value: string): number[] {
  return [...value].filter((c) => c >= '0' && c <= '9').map(Number);
}

function allSame(values: readonly number[]): boolean {
  return values.every((d) => d === values[0]);
}

function isCpf(value: string): boolean {
  if (!CPF.test(value)) {
    return false;
  }
  const d = digits(value);
  const check = (count: number, startWeight: number): number => {
    let sum = 0;
    for (let i = 0; i < count; i++) {
      sum += d[i] * (startWeight - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return d.length === 11 && !allSame(d) && check(9, 10) === d[9] && check(10, 11) === d[10];
}

function isCnpj(value: string): boolean {
  if (!CNPJ.test(value)) {
    return false;
  }
  const d = digits(value);
  const weighted = (weights: readonly number[]): number => {
    const rest = weights.reduce((sum, weight, i) => sum + d[i] * weight, 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return d.length === 14 && !allSame(d) && weighted(CNPJ_FIRST) === d[12] && weighted(CNPJ_SECOND) === d[13];
}

function isPhone(value: string): boolean {
  if (!PHONE.test(value)) {
    return false;
  }
  let d = digits(value);
  if (value.trimStart().startsWith('+')) {
    if (d[0] !== 5 || d[1] !== 5) {
      return false;
    }
    d = d.slice(2);
  }
  return d.length === 10 || d.length === 11;
}
