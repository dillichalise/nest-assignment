import {
  isSensitiveKey,
  maskEmail,
  maskPersonalDataInText,
  maskPhone,
  REDACTED,
} from '../common/security/mask';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 1000;
const MAX_JSON_LENGTH = 8000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sanitizeString = (value: string): string => {
  // Ids are not personal data and must stay intact for lookups.
  const cleaned = UUID.test(value) ? value : maskPersonalDataInText(value);
  return cleaned.length > MAX_STRING_LENGTH
    ? `${cleaned.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : cleaned;
};

/**
 * Everything that is about to be written to the audit trail goes through here.
 *
 *  - values under secret-looking keys (password, token, authorization, secret,
 *    api key, cookie, tax id, ...) are replaced by [REDACTED];
 *  - values under `*email*` / `*phone*` keys are masked, not dropped, so the
 *    trail stays useful for support without exposing the address or number;
 *  - emails and phone numbers inside any other string are masked;
 *  - size, depth and array length are bounded so a log row stays small.
 *
 * Never mutates its input.
 */
export const sanitizeAuditMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input ?? null;
    if (typeof input === 'string') return sanitizeString(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'function' || typeof input === 'symbol')
      return undefined;
    if (input instanceof Date) return input.toISOString();
    if (Buffer.isBuffer(input)) return '[BINARY]';
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';

    const obj = input as object;
    if (seen.has(obj)) return '[CIRCULAR]';
    seen.add(obj);

    if (Array.isArray(obj)) {
      return obj.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (typeof value === 'string' && /email/i.test(key)) {
        out[key] = maskEmail(value);
      } else if (typeof value === 'string' && /phone/i.test(key)) {
        out[key] = maskPhone(value);
      } else {
        const walked = walk(value, depth + 1);
        if (walked !== undefined) out[key] = walked;
      }
    }
    return out;
  };

  const result = (walk(metadata ?? {}, 0) ?? {}) as Record<string, unknown>;
  return JSON.stringify(result).length > MAX_JSON_LENGTH
    ? { truncated: true, reason: 'metadata exceeded the size limit' }
    : result;
};
