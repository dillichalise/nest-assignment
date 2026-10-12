import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../common/enums/role.enum';
import { User } from '../../users/user.entity';
import { UsersService } from '../../users/users.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { makeContext } from './test-utils';

const USER_ID = '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11';
const ATTACKER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('JwtAuthGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let jwt: { verifyAsync: jest.Mock };
  let users: { findById: jest.Mock };
  let guard: JwtAuthGuard;

  const dbUser = (over: Partial<User> = {}) =>
    ({
      id: USER_ID,
      email: 'real@example.com',
      role: Role.SALES,
      isActive: true,
      ...over,
    }) as User;
  const tokenFor = (claims: Record<string, unknown> = {}) =>
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      email: 'token@example.com',
      role: Role.SALES,
      ...claims,
    });
  const request = (extra: Record<string, unknown> = {}) => ({
    headers: { authorization: 'Bearer good' },
    ...extra,
  });

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    jwt = { verifyAsync: jest.fn() };
    users = { findById: jest.fn().mockResolvedValue(dbUser()) };
    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflector as unknown as Reflector,
      users as unknown as UsersService,
    );
  });

  describe('public routes and malformed requests never reach the database', () => {
    it('lets @Public routes through without a token, without verifying and without a lookup', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      await expect(
        guard.canActivate(makeContext({ headers: {} })),
      ).resolves.toBe(true);
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
      expect(users.findById).not.toHaveBeenCalled();
    });

    it.each([
      ['no header', undefined],
      ['wrong scheme', 'Basic abc'],
      ['no token', 'Bearer'],
    ])('rejects %s', async (_name, authorization) => {
      const ctx = makeContext({ headers: { authorization } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(users.findById).not.toHaveBeenCalled();
    });

    it('rejects an invalid or expired token before spending a database read on it', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
      await expect(guard.canActivate(makeContext(request()))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(users.findById).not.toHaveBeenCalled();
    });

    it.each([undefined, null, '', 'u1', 42, '123', 'not-a-uuid'])(
      'rejects a genuine token whose subject is %p, without querying',
      async (sub) => {
        tokenFor({ sub });
        await expect(guard.canActivate(makeContext(request()))).rejects.toThrow(
          UnauthorizedException,
        );
        expect(users.findById).not.toHaveBeenCalled();
      },
    );
  });

  describe('the user is looked up on every request, and must still be allowed in', () => {
    it('accepts a valid token for an active user and attaches the user', async () => {
      tokenFor();
      const req = request();

      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);

      expect(req).toMatchObject({
        user: { id: USER_ID, email: 'real@example.com', role: Role.SALES },
      });
    });

    it("looks up exactly the token's subject, once per request", async () => {
      tokenFor();
      await guard.canActivate(makeContext(request()));
      expect(users.findById).toHaveBeenCalledTimes(1);
      expect(users.findById).toHaveBeenCalledWith(USER_ID);
    });

    it('refuses a user who was deactivated after the token was issued', async () => {
      tokenFor();
      users.findById.mockResolvedValue(dbUser({ isActive: false }));
      const req: Record<string, unknown> = request();

      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(req.user).toBeUndefined();
    });

    it('refuses a user who no longer exists', async () => {
      tokenFor();
      users.findById.mockResolvedValue(null);
      const req: Record<string, unknown> = request();

      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(req.user).toBeUndefined();
    });

    it('answers a deactivated user exactly like a bad token, revealing nothing about the account', async () => {
      const failure = async (): Promise<UnauthorizedException> => {
        try {
          await guard.canActivate(makeContext(request()));
        } catch (error) {
          if (error instanceof UnauthorizedException) return error;
          throw error;
        }
        throw new Error('expected the guard to refuse the request');
      };

      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      const badToken = await failure();

      tokenFor();
      users.findById.mockResolvedValue(dbUser({ isActive: false }));
      const deactivated = await failure();

      users.findById.mockResolvedValue(null);
      const deleted = await failure();

      expect(deactivated.getResponse()).toEqual(badToken.getResponse());
      expect(deleted.getResponse()).toEqual(badToken.getResponse());
    });

    it('does not turn a database failure into "unauthorized": it surfaces as a server error', async () => {
      tokenFor();
      users.findById.mockRejectedValue(new Error('connection terminated'));

      const error = await guard
        .canActivate(makeContext(request()))
        .catch((e) => e);

      expect(error).not.toBeInstanceOf(UnauthorizedException);
      expect(error.message).toBe('connection terminated');
    });
  });

  describe('role and email come from the database, not from the token', () => {
    it('a role change takes effect at once: a token still saying ADMIN does not make a demoted user an admin', async () => {
      tokenFor({ role: Role.ADMIN });
      users.findById.mockResolvedValue(dbUser({ role: Role.SALES }));
      const req: Record<string, unknown> = request();

      await guard.canActivate(makeContext(req));

      expect((req.user as { role: Role }).role).toBe(Role.SALES);
    });

    it('and a promotion applies without logging in again', async () => {
      tokenFor({ role: Role.SALES });
      users.findById.mockResolvedValue(dbUser({ role: Role.ADMIN }));
      const req: Record<string, unknown> = request();

      await guard.canActivate(makeContext(req));

      expect((req.user as { role: Role }).role).toBe(Role.ADMIN);
    });

    it('uses the current email, not the one baked into the token', async () => {
      tokenFor({ email: 'old@example.com' });
      users.findById.mockResolvedValue(
        dbUser({ email: 'current@example.com' }),
      );
      const req: Record<string, unknown> = request();

      await guard.canActivate(makeContext(req));

      expect((req.user as { email: string }).email).toBe('current@example.com');
    });
  });

  describe('identity comes from the verified token (and the database) and nothing else', () => {
    it('ignores a role, id or email smuggled into the body, query, params or headers', async () => {
      tokenFor();
      const req: Record<string, unknown> = {
        headers: {
          authorization: 'Bearer good',
          'x-user-role': 'ADMIN',
          'x-user-id': ATTACKER_ID,
        },
        body: {
          role: Role.ADMIN,
          id: ATTACKER_ID,
          sub: ATTACKER_ID,
          email: 'evil@example.com',
          user: { role: Role.ADMIN },
        },
        query: { role: Role.ADMIN, userId: ATTACKER_ID },
        params: { role: Role.ADMIN },
      };

      await guard.canActivate(makeContext(req));

      expect(req.user).toEqual({
        id: USER_ID,
        email: 'real@example.com',
        role: Role.SALES,
      });
      expect(users.findById).toHaveBeenCalledWith(USER_ID);
    });

    it('does not let a pre-set req.user (e.g. from an earlier middleware) survive', async () => {
      tokenFor();
      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer good' },
        user: { id: ATTACKER_ID, email: 'evil@example.com', role: Role.ADMIN },
      };

      await guard.canActivate(makeContext(req));

      expect(req.user).toEqual({
        id: USER_ID,
        email: 'real@example.com',
        role: Role.SALES,
      });
    });

    it('never attaches a user when verification fails', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer forged' },
        body: { role: Role.ADMIN },
      };

      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(req.user).toBeUndefined();
    });
  });
});
