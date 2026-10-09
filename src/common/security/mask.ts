/**
 * Masks all but the last 4 characters. Values of 4 characters or fewer are
 * fully masked so short secrets are never echoed back.
 */
export const maskTaxId = (value: string): string => {
  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }
  return '*'.repeat(value.length - 4) + value.slice(-4);
};
