import { randomBytes } from 'crypto';
import {
  createEncryptedColumnTransformer,
  decryptField,
  encryptField,
  ENCRYPTION_CONTEXT,
  isEncryptedField,
  LOCAL_DEV_KEY,
  parseEncryptionKey,
  resetFieldEncryptionKeyCache,
  validateFieldEncryptionKey,
} from './field-encryption';

const CTX = ENCRYPTION_CONTEXT.MERCHANT_OWNER_TAX_ID;
const key = randomBytes(32);

describe('encryptField / decryptField', () => {
  it.each(['123-456-789', 'ünïcödé ✓ 税', '', 'x'.repeat(5000)])(
    'round-trips %j',
    (plaintext) => {
      const stored = encryptField(plaintext, key, CTX);
      expect(decryptField(stored, key, CTX)).toBe(plaintext);
    },
  );

  it('produces the documented format and hides the plaintext', () => {
    const stored = encryptField('123-456-789', key, CTX);
    const parts = stored.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12); // IV
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(16); // GCM tag
    expect(stored).not.toContain('123-456-789');
    expect(isEncryptedField(stored)).toBe(true);
  });

  it('uses a fresh IV every time, so equal inputs give different ciphertexts', () => {
    const a = encryptField('same', key, CTX);
    const b = encryptField('same', key, CTX);
    expect(a).not.toBe(b);
    expect(decryptField(a, key, CTX)).toBe('same');
    expect(decryptField(b, key, CTX)).toBe('same');
  });

  describe('tamper detection', () => {
    const flipLastChar = (s: string) =>
      s.slice(0, -2) + (s.slice(-2, -1) === 'A' ? 'B' : 'A') + s.slice(-1);

    it.each([
      ['iv', 1],
      ['auth tag', 2],
      ['ciphertext', 3],
    ])('rejects a modified %s', (_name, index) => {
      const parts = encryptField('123-456-789', key, CTX).split(':');
      parts[index] = flipLastChar(parts[index]);
      expect(() => decryptField(parts.join(':'), key, CTX)).toThrow(
        'Failed to decrypt field',
      );
    });

    it('rejects truncated and extended payloads', () => {
      const stored = encryptField('123-456-789', key, CTX);
      expect(() => decryptField(stored.slice(0, -6), key, CTX)).toThrow();
      expect(() => decryptField(`${stored}:extra`, key, CTX)).toThrow();
    });

    it('rejects the wrong key', () => {
      const stored = encryptField('123-456-789', key, CTX);
      expect(() => decryptField(stored, randomBytes(32), CTX)).toThrow(
        'Failed to decrypt field',
      );
    });

    it('rejects a ciphertext moved to another column (context is authenticated)', () => {
      const stored = encryptField(
        '123-456-789',
        key,
        'merchant_applications.ownerTaxId',
      );
      expect(() => decryptField(stored, key, 'users.someOtherColumn')).toThrow(
        'Failed to decrypt field',
      );
    });

    it.each([
      '123-456-789',
      'v2:a:b:c',
      'v1:only:three:parts:four:five',
      '',
      'v1',
    ])('rejects unrecognized format %j', (bad) => {
      expect(() => decryptField(bad, key, CTX)).toThrow(
        'Failed to decrypt field',
      );
    });

    it('never includes the plaintext, key or payload in an error message', () => {
      const stored = encryptField('SECRET-PLAINTEXT', key, CTX);
      const tampered = stored.slice(0, -4) + 'AAAA';
      let message = '';
      try {
        decryptField(tampered, key, CTX);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain('SECRET-PLAINTEXT');
      expect(message).not.toContain(key.toString('base64'));
      expect(message).not.toContain(tampered);
    });
  });
});

describe('parseEncryptionKey', () => {
  it('accepts 32 bytes as base64 and as hex', () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseEncryptionKey(raw.toString('hex')).equals(raw)).toBe(true);
    expect(
      parseEncryptionKey(`  ${raw.toString('base64')}\n`).equals(raw),
    ).toBe(true);
  });

  it.each([
    undefined,
    '',
    '   ',
    'short',
    randomBytes(16).toString('base64'),
    randomBytes(31).toString('base64'),
    randomBytes(33).toString('base64'),
    randomBytes(16).toString('hex'),
    'not base64 at all !!!',
  ])('rejects %j', (bad) => {
    expect(() => parseEncryptionKey(bad)).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  it('does not echo the rejected value', () => {
    expect(() => parseEncryptionKey('my-weak-key')).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining('my-weak-key'),
      }),
    );
  });

  it('accepts the published dev key', () => {
    expect(parseEncryptionKey(LOCAL_DEV_KEY)).toHaveLength(32);
  });
});

describe('validateFieldEncryptionKey (startup check)', () => {
  const good = randomBytes(32).toString('base64');

  it('passes with a valid key', () => {
    expect(() =>
      validateFieldEncryptionKey({
        NODE_ENV: 'development',
        FIELD_ENCRYPTION_KEY: good,
      }),
    ).not.toThrow();
  });

  it.each(['development', 'production', undefined])(
    'fails fast without a key when NODE_ENV=%s',
    (env) => {
      expect(() => validateFieldEncryptionKey({ NODE_ENV: env })).toThrow(
        /FIELD_ENCRYPTION_KEY is not set/,
      );
    },
  );

  it('fails fast with a malformed key', () => {
    expect(() =>
      validateFieldEncryptionKey({
        NODE_ENV: 'development',
        FIELD_ENCRYPTION_KEY: 'short',
      }),
    ).toThrow(/32 bytes/);
  });

  it('is skipped under test', () => {
    expect(() =>
      validateFieldEncryptionKey({ NODE_ENV: 'test' }),
    ).not.toThrow();
  });

  it('refuses the published development key in production, but allows it elsewhere', () => {
    expect(() =>
      validateFieldEncryptionKey({
        NODE_ENV: 'production',
        FIELD_ENCRYPTION_KEY: LOCAL_DEV_KEY,
      }),
    ).toThrow(/published local development key/);
    expect(() =>
      validateFieldEncryptionKey({
        NODE_ENV: 'development',
        FIELD_ENCRYPTION_KEY: LOCAL_DEV_KEY,
      }),
    ).not.toThrow();
  });
});

describe('createEncryptedColumnTransformer', () => {
  const original = process.env.FIELD_ENCRYPTION_KEY;
  const transformer = createEncryptedColumnTransformer(CTX);
  const to = transformer.to as (v: unknown) => unknown;
  const from = transformer.from as (v: unknown) => unknown;

  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    resetFieldEncryptionKeyCache();
  });
  afterAll(() => {
    process.env.FIELD_ENCRYPTION_KEY = original;
    resetFieldEncryptionKeyCache();
  });

  it('encrypts on write and decrypts on read', () => {
    const stored = to('123-456-789') as string;
    expect(stored).not.toContain('123-456-789');
    expect(from(stored)).toBe('123-456-789');
  });

  it('passes null and undefined through', () => {
    expect(to(null)).toBeNull();
    expect(to(undefined)).toBeUndefined();
    expect(from(null)).toBeNull();
    expect(from(undefined)).toBeUndefined();
  });

  it('refuses to read a plaintext value from an encrypted column', () => {
    expect(() => from('123-456-789')).toThrow('Failed to decrypt field');
  });

  it('fails clearly when the key is missing', () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    resetFieldEncryptionKeyCache();
    expect(() => to('x')).toThrow(/FIELD_ENCRYPTION_KEY is not set/);
  });

  it('cannot read data written under a different key', () => {
    const stored = to('123-456-789') as string;
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    resetFieldEncryptionKeyCache();
    expect(() => from(stored)).toThrow('Failed to decrypt field');
  });
});
