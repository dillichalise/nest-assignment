import { decimalTransformer } from './decimal.transformer';

describe('decimalTransformer', () => {
  const to = decimalTransformer.to as (v: unknown) => unknown;
  const from = decimalTransformer.from as (v: unknown) => unknown;

  it('normalizes numbers and numeric strings to 2 decimals', () => {
    expect(to(1500)).toBe('1500.00');
    expect(to('99.5')).toBe('99.50');
  });

  it('passes null/undefined through', () => {
    expect(to(null)).toBeNull();
    expect(to(undefined)).toBeUndefined();
  });

  it('rejects non-numeric input', () => {
    expect(() => to('abc')).toThrow('Invalid decimal value');
  });

  it('reads database values back as strings, untouched', () => {
    expect(from('12345678901.10')).toBe('12345678901.10');
  });
});
