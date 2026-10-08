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
});
