import { ConfigService } from '@nestjs/config';
import * as jsonwebtoken from 'jsonwebtoken';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { Role } from '../src/common/enums/role.enum';
import { User } from '../src/users/user.entity';
import { createHarness, E2E_PASSWORD, Harness } from './helpers/e2e-harness';

/**
 * Authentication: who gets a token, and which tokens are accepted.
 * Authorization (what an authenticated user may do) is in authorization.e2e-spec.ts.
 */
describe('Authentication (e2e)', () => {
  let h: Harness;
  let secret: string;

  beforeAll(async () => {
    h = await createHarness();
    secret = h.app.get(ConfigService).getOrThrow<string>('JWT_SECRET');
  });
  afterAll(() => h.close());

  const login = (email: string, password: string) =>
    h.http().post('/auth/login').send({ email, password });
  const me = (authorization?: string) => {
    const req = h.http().get('/auth/me');
    return authorization === undefined
      ? req
      : req.set('Authorization', authorization);
  };
  const claims = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

  /** A token the way the server would sign it, with the given claims. */
  const sign = (payload: object, signingSecret = secret) =>
    jsonwebtoken.sign(payload, signingSecret);
  const now = () => Math.floor(Date.now() / 1000);
  const validClaims = () => ({
    sub: h.users.salesA.id,
    email: h.users.salesA.email,
    role: Role.SALES,
  });

  describe('login', () => {
    it('issues a JWT valid for exactly one hour, with the user id, email and role', async () => {
      const res = await login(h.users.salesA.email, E2E_PASSWORD).expect(200);

      expect(Object.keys(res.body).sort()).toEqual([
        'accessToken',
        'expiresIn',
      ]);
      expect(res.body.expiresIn).toBe(3600);
      const token = claims(res.body.accessToken);
      expect(token).toMatchObject({
        sub: h.users.salesA.id,
        email: h.users.salesA.email,
        role: 'SALES',
      });
      // Regression: the lifetime was once read as MILLISECONDS (a 3-second token).
      expect(token.exp - token.iat).toBe(3600);
    });

    it('never puts a password, hash or other secret in the token or the response', async () => {
      const res = await login(h.users.salesA.email, E2E_PASSWORD).expect(200);
      const everything =
        JSON.stringify(res.body) + JSON.stringify(claims(res.body.accessToken));
      expect(everything).not.toMatch(/password|hash|\$2[aby]\$/i);
    });

    it('issues a token that works', async () => {
      const { body } = await login(h.users.admin.email, E2E_PASSWORD).expect(
        200,
      );
      const res = await me(`Bearer ${body.accessToken}`).expect(200);
      expect(res.body).toEqual({
        id: h.users.admin.id,
        email: h.users.admin.email,
        name: 'admin',
        role: 'ADMIN',
      });
    });

    it('ignores the case of the email address', async () => {
      await login(h.users.salesA.email.toUpperCase(), E2E_PASSWORD).expect(200);
    });

    it('takes the role from the database, never from the login request', async () => {
      const res = await h
        .http()
        .post('/auth/login')
        .send({
          email: h.users.salesA.email,
          password: E2E_PASSWORD,
          role: 'ADMIN',
          sub: 'attacker',
        })
        .expect(200);
      expect(claims(res.body.accessToken)).toMatchObject({
        role: 'SALES',
        sub: h.users.salesA.id,
      });
    });

    describe('failures', () => {
      it('wrong password, unknown email and a deactivated account all get the SAME 401', async () => {
        await h.ds
          .getRepository(User)
          .update({ id: h.users.rev2.id }, { isActive: false });
        try {
          const wrongPassword = await login(
            h.users.salesA.email,
            'Wrong-Password-1',
          ).expect(401);
          const unknownEmail = await login(
            'nobody-here@example.com',
            E2E_PASSWORD,
          ).expect(401);
          const inactive = await login(h.users.rev2.email, E2E_PASSWORD).expect(
            401,
          );

          for (const other of [unknownEmail, inactive]) {
            for (const key of ['statusCode', 'error', 'message']) {
              expect(other.body[key]).toEqual(wrongPassword.body[key]);
            }
          }
          expect(wrongPassword.body.message).toBe('Invalid credentials');
          expect(
            JSON.stringify([
              wrongPassword.body,
              unknownEmail.body,
              inactive.body,
            ]),
          ).not.toMatch(/inactive|unknown|not found|exists|deactivated/i);
        } finally {
          await h.ds
            .getRepository(User)
            .update({ id: h.users.rev2.id }, { isActive: true });
        }
      });

      it('never issues a token on failure', async () => {
        const res = await login(
          h.users.salesA.email,
          'Wrong-Password-1',
        ).expect(401);
        expect(res.body).not.toHaveProperty('accessToken');
      });

      it.each([
        ['an empty body', {}],
        ['no password', { email: 'a@b.co' }],
        ['no email', { password: 'x' }],
        ['a malformed email', { email: 'not-an-email', password: 'x' }],
        ['an empty password', { email: 'a@b.co', password: '' }],
        [
          'a 129-character password',
          { email: 'a@b.co', password: 'x'.repeat(129) },
        ],
        ['a numeric password', { email: 'a@b.co', password: 12345 }],
        ['an object as the email', { email: { $ne: null }, password: 'x' }],
        ['an array as the password', { email: 'a@b.co', password: ['x'] }],
      ])('rejects %s with a structured 400', async (_name, body) => {
        const res = await h.http().post('/auth/login').send(body).expect(400);
        expect(res.body).not.toHaveProperty('accessToken');
        expect(res.body.requestId).toBeDefined();
      });

      it('only accepts POST', async () => {
        await h.http().get('/auth/login').expect(404);
        await h.http().put('/auth/login').send({}).expect(404);
      });
    });
  });

  describe('protected routes need a genuine, current token', () => {
    it('accepts a token issued by login', async () => {
      await me(`Bearer ${h.tokens.salesA}`).expect(200);
    });

    it.each([
      ['no Authorization header', undefined],
      ['an empty header', ''],
      ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
      ['"Bearer" with no token', 'Bearer'],
      ['"Bearer " with an empty token', 'Bearer '],
      ['a token that is not a JWT', 'Bearer not-a-jwt'],
      ['a JWT with only two parts', 'Bearer aaa.bbb'],
      [
        'random base64 parts',
        `Bearer ${Buffer.from('a').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`,
      ],
    ])('rejects %s with 401', async (_name, header) => {
      await me(header).expect(401);
    });

    it('rejects a token signed with a different secret', async () => {
      const forged = sign(
        { ...validClaims(), role: Role.ADMIN },
        'not-the-real-secret',
      );
      await me(`Bearer ${forged}`).expect(401);
    });

    it('rejects an EXPIRED token', async () => {
      const expired = sign({
        ...validClaims(),
        iat: now() - 7200,
        exp: now() - 3600,
      });
      await me(`Bearer ${expired}`).expect(401);
    });

    it('rejects a token that expired a single second ago, but accepts one valid for another minute', async () => {
      await me(`Bearer ${sign({ ...validClaims(), exp: now() - 1 })}`).expect(
        401,
      );
      await me(`Bearer ${sign({ ...validClaims(), exp: now() + 60 })}`).expect(
        200,
      );
    });

    it('rejects an unsigned token ("alg": "none")', async () => {
      const part = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${part({ alg: 'none', typ: 'JWT' })}.${part({ ...validClaims(), role: Role.ADMIN, exp: now() + 3600 })}.`;
      await me(`Bearer ${unsigned}`).expect(401);
    });

    it('rejects a genuine token whose payload was edited afterwards (role -> ADMIN)', async () => {
      const [header, , signature] = h.tokens.salesA.split('.');
      const payload = claims(h.tokens.salesA);
      const edited = Buffer.from(
        JSON.stringify({ ...payload, role: 'ADMIN' }),
      ).toString('base64url');
      await me(`Bearer ${header}.${edited}.${signature}`).expect(401);
    });

    it('rejects a genuine token with its signature stripped or replaced', async () => {
      const [header, payload] = h.tokens.salesA.split('.');
      await me(`Bearer ${header}.${payload}.`).expect(401);
      await me(`Bearer ${header}.${payload}.${'A'.repeat(43)}`).expect(401);
    });

    it('accepts another HMAC variant only when it is signed with the real secret, and keeps the claimed role', async () => {
      const hs512 = jsonwebtoken.sign(
        { ...validClaims(), exp: now() + 60 },
        secret,
        {
          algorithm: 'HS512',
        },
      );
      const res = await me(`Bearer ${hs512}`).expect(200);
      expect(res.body.role).toBe('SALES');

      const wrongKey = jsonwebtoken.sign(
        { ...validClaims(), exp: now() + 60 },
        'other-secret',
        {
          algorithm: 'HS512',
        },
      );
      await me(`Bearer ${wrongKey}`).expect(401);
    });

    it('rejects an asymmetric (RS256) token: no algorithm-confusion attack', async () => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const rs256 = jsonwebtoken.sign(
        { ...validClaims(), role: Role.ADMIN, exp: now() + 60 },
        privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { algorithm: 'RS256' },
      );
      await me(`Bearer ${rs256}`).expect(401);
    });

    it('rejects a token for a user that no longer exists, on /auth/me', async () => {
      const ghost = sign({
        sub: randomUUID(),
        email: 'ghost@example.com',
        role: Role.ADMIN,
        exp: now() + 60,
      });
      await me(`Bearer ${ghost}`).expect(401);
    });

    it('does not accept the token in a query string or cookie', async () => {
      await h
        .http()
        .get(`/auth/me?access_token=${h.tokens.salesA}`)
        .expect(401);
      await h
        .http()
        .get('/auth/me')
        .set('Cookie', `token=${h.tokens.salesA}`)
        .expect(401);
    });

    it('does not trust an identity header from the client', async () => {
      await h
        .http()
        .get('/auth/me')
        .set('x-user-id', h.users.admin.id)
        .set('x-user-role', 'ADMIN')
        .expect(401);
    });

    it('a user who is deactivated is refused on /auth/me straight away', async () => {
      const token = (await login(h.users.rev2.email, E2E_PASSWORD).expect(200))
        .body.accessToken;
      await h.ds
        .getRepository(User)
        .update({ id: h.users.rev2.id }, { isActive: false });
      try {
        await me(`Bearer ${token}`).expect(401);
      } finally {
        await h.ds
          .getRepository(User)
          .update({ id: h.users.rev2.id }, { isActive: true });
      }
    });

    /**
     * KNOWN LIMITATION, documented rather than hidden. Tokens are stateless: the
     * guard verifies the signature and expiry but does not look the user up, so a
     * user deactivated AFTER logging in keeps working on every endpoint except
     * /auth/me until the token expires (1 hour). Closing the gap means a user
     * lookup (or a token deny-list) per request. If you change this behaviour,
     * update this test and docs/SECURITY.md.
     */
    it('KNOWN LIMITATION: a deactivated user keeps API access until the token expires', async () => {
      const token = (await login(h.users.rev2.email, E2E_PASSWORD).expect(200))
        .body.accessToken;
      await h.ds
        .getRepository(User)
        .update({ id: h.users.rev2.id }, { isActive: false });
      try {
        const res = await h
          .http()
          .get('/applications')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
      } finally {
        await h.ds
          .getRepository(User)
          .update({ id: h.users.rev2.id }, { isActive: true });
      }
    });
  });

  describe('public routes stay public', () => {
    it('GET /health needs no token', async () => {
      await h.http().get('/health').expect(200);
    });

    it('POST /auth/login needs no token (it is how you get one)', async () => {
      await login(h.users.salesA.email, E2E_PASSWORD).expect(200);
    });

    it('a bad token on a public route does not break it', async () => {
      await h
        .http()
        .get('/health')
        .set('Authorization', 'Bearer garbage')
        .expect(200);
    });

    it('an unknown route is a plain 404, not a 401 that hints at what exists', async () => {
      await h.http().get('/definitely-not-a-route').expect(404);
    });
  });
});
