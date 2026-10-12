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

/**
 * `user@example.com` -> `u***@example.com`. Keeps the first character of the
 * local part and the domain (useful for support) but hides the rest. Anything
 * that does not look like an email is fully masked.
 */
export const maskEmail = (value: string): string => {
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) {
    return '*'.repeat(value.length);
  }
  const local = value.slice(0, at);
  const domain = value.slice(at);
  return local.slice(0, 1) + '*'.repeat(Math.max(local.length - 1, 2)) + domain;
};

/**
 * Keeps the last 4 digits and any formatting characters, masking every other
 * digit: `+977 9876543210` -> `+*** ******3210`.
 */
export const maskPhone = (value: string): string => {
  let digitsToKeep = 4;
  const chars = [...value].reverse().map((ch) => {
    if (!/\d/.test(ch)) {
      return ch;
    }
    if (digitsToKeep > 0) {
      digitsToKeep -= 1;
      return ch;
    }
    return '*';
  });
  return chars.reverse().join('');
};

export const REDACTED = '[REDACTED]';

/**
 * Key names (normalized: lower case, letters and digits only) that must never
 * be logged or stored in audit metadata. Matching is by substring, so
 * `x-api-key`, `accessToken`, `user_password` and `ownerTaxId` all hit. Erring
 * on the side of over-redaction is deliberate.
 */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'cookie',
  'credential',
  'taxid',
  'privatekey',
  'encryptionkey',
];

const normalizeKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, '');

export const isSensitiveKey = (
  key: string,
  extraKeys: readonly string[] = [],
) => {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part)) ||
    extraKeys.some((extra) => normalized.includes(normalizeKey(extra)))
  );
};

/**
 * Returns a deep copy of `value` with the value of every sensitive key
 * replaced by `[REDACTED]`. Never mutates the input; safe for circular
 * references; leaves Dates and Buffers alone.
 */
export const redact = <T>(value: T, extraKeys: readonly string[] = []): T => {
  const seen = new WeakMap<object, unknown>();

  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (input instanceof Date || Buffer.isBuffer(input)) {
      return input;
    }
    if (seen.has(input)) {
      return seen.get(input);
    }
    if (Array.isArray(input)) {
      const copy: unknown[] = [];
      seen.set(input, copy);
      input.forEach((item) => copy.push(walk(item)));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(input, copy);
    for (const [key, item] of Object.entries(input)) {
      copy[key] = isSensitiveKey(key, extraKeys) ? REDACTED : walk(item);
    }
    return copy;
  };

  return walk(value) as T;
};

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A run of digits with common phone separators, not glued to a word.
const PHONE_IN_TEXT = /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w])/g;
const MIN_PHONE_DIGITS = 9;
const ISO_DATE_START = /^\d{4}-\d{2}-\d{2}/;

/**
 * Best-effort masking of personal data inside free text (decision reasons and
 * the like): every email address and every phone-number-looking run of 9+
 * digits. It is a heuristic safety net, not a guarantee: structured fields
 * must never rely on it. Dates and short numbers are left alone.
 */
export const maskPersonalDataInText = (text: string): string =>
  text
    .replace(EMAIL_IN_TEXT, (match) => maskEmail(match))
    .replace(PHONE_IN_TEXT, (match) => {
      const digits = match.replace(/\D/g, '').length;
      if (digits < MIN_PHONE_DIGITS || ISO_DATE_START.test(match)) {
        return match;
      }
      return maskPhone(match.trimEnd());
    });
