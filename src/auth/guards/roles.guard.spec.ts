import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../common/enums/role.enum';
import { RolesGuard } from './roles.guard';
import { makeContext } from './test-utils';

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;
  const userWith = (role: Role) => ({ user: { id: 'u1', email: 'x', role } });

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows any authenticated user when no roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(makeContext(userWith(Role.SALES)))).toBe(true);
  });

  it('allows a user whose role is listed', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN, Role.REVIEWER]);
    expect(guard.canActivate(makeContext(userWith(Role.REVIEWER)))).toBe(true);
  });

  it('forbids a user whose role is not listed', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(makeContext(userWith(Role.SALES)))).toThrow(
      ForbiddenException,
    );
  });

  it('fails closed with 401 when roles are required but no user is attached', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });
});
