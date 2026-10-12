import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../common/enums/role.enum';
import { JwtAuthGuard } from './jwt-auth.guard';
import { makeContext } from './test-utils';

describe('JwtAuthGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let jwt: { verifyAsync: jest.Mock };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    jwt = { verifyAsync: jest.fn() };
    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflector as unknown as Reflector,
    );
  });

  it('lets @Public routes through without a token and without verifying', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(makeContext({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['no token', 'Bearer'],
  ])('rejects %s', async (_name, authorization) => {
    const ctx = makeContext({ headers: { authorization } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid or expired token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const ctx = makeContext({ headers: { authorization: 'Bearer bad' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a valid token and attaches the user from the payload', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      email: 'a@b.c',
      role: Role.REVIEWER,
    });
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer good' },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u1', email: 'a@b.c', role: Role.REVIEWER });
  });

  describe('identity comes from the verified token and nothing else', () => {
    const tokenPayload = {
      sub: 'real-user',
      email: 'real@example.com',
      role: Role.SALES,
    };

    it('ignores a role, id or email smuggled into the body, query, params or headers', async () => {
      jwt.verifyAsync.mockResolvedValue(tokenPayload);
      const req: Record<string, unknown> = {
        headers: {
          authorization: 'Bearer good',
          'x-user-role': 'ADMIN',
          'x-user-id': 'attacker',
        },
        body: {
          role: Role.ADMIN,
          id: 'attacker',
          sub: 'attacker',
          email: 'evil@example.com',
          user: { role: Role.ADMIN },
        },
        query: { role: Role.ADMIN, userId: 'attacker' },
        params: { role: Role.ADMIN },
      };

      await guard.canActivate(makeContext(req));

      expect(req.user).toEqual({
        id: 'real-user',
        email: 'real@example.com',
        role: Role.SALES,
      });
    });

    it('does not let a pre-set req.user (e.g. from an earlier middleware) survive verification', async () => {
      jwt.verifyAsync.mockResolvedValue(tokenPayload);
      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer good' },
        user: { id: 'attacker', email: 'evil@example.com', role: Role.ADMIN },
      };

      await guard.canActivate(makeContext(req));

      expect(req.user).toEqual({
        id: 'real-user',
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
