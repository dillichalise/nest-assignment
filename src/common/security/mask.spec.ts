import { maskEmail, maskPhone, maskTaxId, redact, REDACTED } from './mask';

describe('maskTaxId', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskTaxId('123-45-6789')).toBe('*******6789');
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

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('user@example.com')).toBe('u***@example.com');
    expect(maskEmail('owner.user@example.com')).toBe('o*********@example.com');
  });

  it('never reveals the local part of short addresses', () => {
    expect(maskEmail('a@example.com')).toBe('a**@example.com');
    expect(maskEmail('ab@example.com')).not.toContain('b@');
  });

  it('fully masks anything that is not an email', () => {
    expect(maskEmail('not-an-email')).toBe('************');
    expect(maskEmail('@example.com')).toBe('*'.repeat(12));
    expect(maskEmail('pat@')).toBe('****');
    expect(maskEmail('')).toBe('');
  });

  it('uses the last @ so a quoted local part cannot leak the domain boundary', () => {
    expect(maskEmail('we@ird@example.com')).toBe('w*****@example.com');
  });
});

describe('maskPhone', () => {
  it('keeps the last 4 digits and the formatting', () => {
    expect(maskPhone('+977 9876543210')).toBe('+*** ******3210');
    expect(maskPhone('(555) 010-1234')).toBe('(***) ***-1234');
  });

  it('fully masks digits when there are 4 or fewer', () => {
    expect(maskPhone('1234')).toBe('1234');
    expect(maskPhone('+1 234')).toBe('+1 234');
  });

  it('handles empty input', () => {
    expect(maskPhone('')).toBe('');
  });
});

describe('redact', () => {
  it('replaces sensitive values at any depth, in objects and arrays', () => {
    const input = {
      user: 'pat',
      password: 'hunter2',
      nested: {
        accessToken: 'abc',
        keep: 1,
        list: [{ secret: 's', ok: true }],
      },
      headers: {
        Authorization: 'Bearer xyz',
        'x-api-key': 'k',
        Accept: 'json',
      },
    };
    expect(redact(input)).toEqual({
      user: 'pat',
      password: REDACTED,
      nested: {
        accessToken: REDACTED,
        keep: 1,
        list: [{ secret: REDACTED, ok: true }],
      },
      headers: {
        Authorization: REDACTED,
        'x-api-key': REDACTED,
        Accept: 'json',
      },
    });
  });

  it.each([
    'password',
    'Password',
    'user_password',
    'passwordHash',
    'token',
    'refresh-token',
    'accessToken',
    'authorization',
    'Set-Cookie',
    'client_secret',
    'apiKey',
    'ownerTaxId',
    'owner_tax_id',
    'FIELD_ENCRYPTION_KEY',
    'JWT_SECRET',
  ])('treats %s as sensitive', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: REDACTED });
  });

  it.each(['businessName', 'ownerName', 'status', 'email', 'id'])(
    'leaves %s alone',
    (key) => {
      expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
    },
  );

  it('supports extra keys', () => {
    expect(redact({ iban: 'DE89', name: 'x' }, ['iban'])).toEqual({
      iban: REDACTED,
      name: 'x',
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', nested: { token: 't' } };
    redact(input);
    expect(input).toEqual({ password: 'p', nested: { token: 't' } });
  });

  it('survives circular references', () => {
    const a: Record<string, unknown> = { name: 'a', password: 'p' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.self).toBe(out);
  });

  it('leaves primitives, null, Dates and Buffers untouched', () => {
    const date = new Date();
    const buf = Buffer.from('x');
    expect(redact(null)).toBeNull();
    expect(redact('text')).toBe('text');
    expect(redact(5)).toBe(5);
    expect(redact({ at: date, buf })).toEqual({ at: date, buf });
  });

  it('never leaks the original value anywhere in the output', () => {
    const out = JSON.stringify(
      redact({
        a: { b: [{ password: 'S3CR3T-VALUE' }] },
        token: 'S3CR3T-VALUE',
      }),
    );
    expect(out).not.toContain('S3CR3T-VALUE');
  });
});
