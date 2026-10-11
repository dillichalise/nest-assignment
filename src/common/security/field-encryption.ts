import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

/**
 * Field-level encryption (AES-256-GCM) for sensitive columns.
 *
 * Stored format:  v1:<iv>:<authTag>:<ciphertext>   (each part base64)
 *   - `v1` is the format/key version, reserved for future key rotation.
 *   - a fresh random 12-byte IV per write, so equal inputs never produce equal
 *     ciphertexts (and therefore cannot be searched or indexed directly).
 *   - the GCM auth tag makes any modification of the stored value detectable.
 *   - `context` is bound in as additional authenticated data, so a ciphertext
 *     copied from one column into another fails to decrypt.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const ENCRYPTION_CONTEXT = {
  MERCHANT_OWNER_TAX_ID: 'merchant_applications.ownerTaxId',
} as const;

/**
 * The key published in .env.example. It is public, so it must never protect
 * real data: startup refuses it when NODE_ENV=production.
 */
export const LOCAL_DEV_KEY = 'n9bRxLzfgSEjnnd06ZE3cdEFuPzeLuK4/6bkMaFfwmg=';

/** Accepts a 32-byte key as base64 (preferred) or 64 hex characters. */
export const parseEncryptionKey = (raw: string | undefined): Buffer => {
  const value = raw?.trim();
  if (!value) {
    throw new Error('FIELD_ENCRYPTION_KEY is not set');
  }
  const candidates = [
    /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : null,
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : null,
  ];
  const key = candidates.find((c) => c?.length === KEY_BYTES);
  if (!key) {
    // Deliberately does not echo the value.
    throw new Error(
      `FIELD_ENCRYPTION_KEY must be ${KEY_BYTES} bytes, base64 or hex encoded (e.g. \`openssl rand -base64 32\`)`,
    );
  }
  return key;
};

export const isEncryptedField = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(`${VERSION}:`);

export const encryptField = (
  plaintext: string,
  key: Buffer,
  context: string,
): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
};

export const decryptField = (
  payload: string,
  key: Buffer,
  context: string,
): string => {
  const [version, ivB64, tagB64, ctB64, ...extra] = payload.split(':');
  if (
    version !== VERSION ||
    !ivB64 ||
    !tagB64 ||
    ctB64 === undefined ||
    extra.length
  ) {
    throw new Error('Failed to decrypt field: unrecognized format');
  }
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('bad lengths');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // One message for tampering, wrong key and wrong context; never any detail.
    throw new Error(
      'Failed to decrypt field: data is corrupted or the key is wrong',
    );
  }
};

let cachedKey: Buffer | undefined;

/** The key from the environment, parsed once. Read lazily (after dotenv/ConfigModule loaded). */
export const getFieldEncryptionKey = (): Buffer => {
  cachedKey ??= parseEncryptionKey(process.env.FIELD_ENCRYPTION_KEY);
  return cachedKey;
};

/** For tests that change the environment. */
export const resetFieldEncryptionKeyCache = () => {
  cachedKey = undefined;
};

/**
 * Startup check: refuse to boot with a missing/short key (skipped under Jest)
 * or with the published development key in production.
 */
export const validateFieldEncryptionKey = (
  env: Record<string, unknown>,
): void => {
  if (env.NODE_ENV === 'test') {
    return;
  }
  const raw =
    typeof env.FIELD_ENCRYPTION_KEY === 'string'
      ? env.FIELD_ENCRYPTION_KEY
      : undefined;
  parseEncryptionKey(raw);
  if (env.NODE_ENV === 'production' && raw?.trim() === LOCAL_DEV_KEY) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is the published local development key; generate a real one',
    );
  }
};

/** TypeORM transformer: encrypts on write, decrypts on read. */
export const createEncryptedColumnTransformer = (
  context: string,
): ValueTransformer => ({
  to: (value?: string | null) =>
    value === null || value === undefined
      ? value
      : encryptField(value, getFieldEncryptionKey(), context),
  from: (value?: string | null) => {
    if (value === null || value === undefined) {
      return value;
    }
    // Strict on purpose: a plaintext value in an encrypted column is a data
    // problem (un-run backfill migration), not something to silently accept.
    return decryptField(value, getFieldEncryptionKey(), context);
  },
});
