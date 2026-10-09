import { maskTaxId } from './mask';

describe('maskTaxId', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskTaxId('123-456-789')).toBe('*******-789');
  });

  it('fully masks values of 4 characters or fewer', () => {
    expect(maskTaxId('1234')).toBe('****');
    expect(maskTaxId('12')).toBe('**');
    expect(maskTaxId('')).toBe('');
  });

  it('preserves length', () => {
    expect(maskTaxId('987654321')).toHaveLength(9);
  });
});
