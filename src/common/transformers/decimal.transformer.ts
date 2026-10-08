import { ValueTransformer } from 'typeorm';

/**
 * Money-like values are stored as Postgres `numeric` and kept as decimal
 * STRINGS in JS, so no value ever passes through a binary float.
 * Writes accept a number or numeric string and normalize to 2 decimals.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value?: number | string | null) => {
    if (value === null || value === undefined) {
      return value;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid decimal value: ${String(value)}`);
    }
    return n.toFixed(2);
  },
  from: (value?: string | null) => value,
};
