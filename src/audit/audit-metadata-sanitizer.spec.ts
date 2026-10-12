import { REDACTED } from '../common/security/mask';
import { sanitizeAuditMetadata } from './audit-metadata-sanitizer';

describe('sanitizeAuditMetadata', () => {
  describe('secrets are redacted by key, at any depth', () => {
    it.each([
      'password',
      'newPassword',
      'passwordHash',
      'token',
      'accessToken',
      'refresh_token',
      'authorization',
      'Authorization',
      'secret',
      'client_secret',
      'apiKey',
      'x-api-key',
      'cookie',
      'ownerTaxId',
      'taxId',
      'FIELD_ENCRYPTION_KEY',
      'JWT_SECRET',
    ])('removes the value under %s', (key) => {
      const out = sanitizeAuditMetadata({ [key]: 'S3CR3T', keep: 'ok' });
      expect(out[key]).toBe(REDACTED);
      expect(out.keep).toBe('ok');
      expect(JSON.stringify(out)).not.toContain('S3CR3T');
    });

    it('reaches into nested objects and arrays', () => {
      const out = sanitizeAuditMetadata({
        request: { headers: { authorization: 'Bearer abc' } },
        users: [
          { name: 'a', password: 'p1' },
          { name: 'b', token: 't1' },
        ],
      });
      const json = JSON.stringify(out);
      for (const secret of ['Bearer abc', 'p1', 't1']) {
        expect(json).not.toContain(secret);
      }
      expect(json).toContain('"name":"a"');
    });

    it('redacts non-string secrets too', () => {
      const out = sanitizeAuditMetadata({
        password: 12345,
        token: { nested: 'x' },
      });
      expect(out).toEqual({ password: REDACTED, token: REDACTED });
    });
  });

  describe('personal data is masked, not dropped', () => {
    it('masks values under email and phone keys', () => {
      const out = sanitizeAuditMetadata({
        ownerEmail: 'pat@example.com',
        email: 'sam@example.com',
        contactPhone: '+977 9876543210',
      });
      expect(out).toEqual({
        ownerEmail: 'p**@example.com',
        email: 's**@example.com',
        contactPhone: '+*** ******3210',
      });
    });

    it('masks emails and phone numbers inside free text', () => {
      const out = sanitizeAuditMetadata({
        reason:
          'Call the owner on +977 9876543210 or mail pat@example.com about the licence',
      });
      const reason = out.reason as string;
      expect(reason).not.toContain('pat@example.com');
      expect(reason).not.toContain('9876543210');
      expect(reason).toContain('p**@example.com');
      expect(reason).toContain('3210');
      expect(reason).toContain('about the licence');
    });

    it('masks a bare 10-digit number but leaves short numbers and dates alone', () => {
      const out = sanitizeAuditMetadata({
        a: 'ring 9876543210 now',
        b: 'order 4521 shipped',
        c: 'resubmitted on 2026-10-12 10:30',
        d: 'score 79 of 100',
      });
      expect(out.a).not.toContain('9876543210');
      expect(out.b).toBe('order 4521 shipped');
      expect(out.c).toBe('resubmitted on 2026-10-12 10:30');
      expect(out.d).toBe('score 79 of 100');
    });

    it('leaves uuids intact so ids stay searchable', () => {
      const id = '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11';
      const allDigits = '11111111-2222-3333-4444-555555555555';
      const out = sanitizeAuditMetadata({ reviewerId: id, other: allDigits });
      expect(out).toEqual({ reviewerId: id, other: allDigits });
    });
  });

  describe('ordinary metadata survives untouched', () => {
    it('keeps enums, numbers, booleans, null and arrays of ids', () => {
      const input = {
        from: 'DRAFT',
        to: 'SUBMITTED',
        run: 2,
        score: 79,
        reassigned: false,
        previousReviewerId: null,
        changedFields: ['businessName', 'currency'],
      };
      expect(sanitizeAuditMetadata(input)).toEqual(input);
    });

    it('returns an empty object for undefined or empty input', () => {
      expect(sanitizeAuditMetadata(undefined)).toEqual({});
      expect(sanitizeAuditMetadata({})).toEqual({});
    });
  });

  describe('safety limits', () => {
    it('does not mutate its input', () => {
      const input = { password: 'p', nested: { token: 't', email: 'a@b.co' } };
      const copy = JSON.parse(JSON.stringify(input));
      sanitizeAuditMetadata(input);
      expect(input).toEqual(copy);
    });

    it('survives circular references', () => {
      const a: Record<string, unknown> = { name: 'a', password: 'p' };
      a.self = a;
      const out = sanitizeAuditMetadata(a);
      expect(out.password).toBe(REDACTED);
      expect(out.self).toBe('[CIRCULAR]');
    });

    it('truncates long strings', () => {
      const out = sanitizeAuditMetadata({ note: 'x'.repeat(5000) });
      expect((out.note as string).length).toBeLessThan(1100);
      expect(out.note as string).toMatch(/\[truncated\]$/);
    });

    it('limits depth and array length', () => {
      const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
      expect(JSON.stringify(sanitizeAuditMetadata(deep))).toContain(
        '[TRUNCATED]',
      );
      const longList = { ids: Array.from({ length: 500 }, (_, i) => i) };
      expect((sanitizeAuditMetadata(longList).ids as number[]).length).toBe(
        100,
      );
    });

    it('replaces an oversized document instead of storing it', () => {
      const big: Record<string, unknown> = {};
      for (let i = 0; i < 400; i++) big[`key${i}`] = 'v'.repeat(100);
      expect(sanitizeAuditMetadata(big)).toEqual({
        truncated: true,
        reason: 'metadata exceeded the size limit',
      });
    });

    it('converts Dates, bigints and buffers, and drops functions', () => {
      const out = sanitizeAuditMetadata({
        at: new Date('2026-01-02T03:04:05.000Z'),
        big: BigInt(10),
        raw: Buffer.from('secret bytes'),
        fn: () => 'x',
      });
      expect(out).toEqual({
        at: '2026-01-02T03:04:05.000Z',
        big: '10',
        raw: '[BINARY]',
      });
    });
  });

  it('never lets any known secret through, however it is nested', () => {
    const secrets = [
      'hunter2',
      'Bearer abc.def.ghi',
      '123-456-789',
      'sk_live_999',
    ];
    const out = JSON.stringify(
      sanitizeAuditMetadata({
        login: { password: secrets[0] },
        headers: { Authorization: secrets[1] },
        application: { ownerTaxId: secrets[2] },
        provider: { apiKey: secrets[3] },
        list: [{ deep: [{ token: secrets[0] }] }],
      }),
    );
    for (const secret of secrets) {
      expect(out).not.toContain(secret);
    }
  });
});
