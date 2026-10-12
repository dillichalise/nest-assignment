import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Role } from '../../common/enums/role.enum';
import { AuthUser } from '../auth-user.interface';
import { CurrentUser } from './current-user.decorator';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { ROLES_KEY, Roles } from './roles.decorator';

describe('@Public()', () => {
  @Public()
  class OpenController {
    @Public()
    open() {}
    closed() {}
  }

  it('marks a handler and a class as public', () => {
    const reflector = new Reflector();
    expect(reflector.get(IS_PUBLIC_KEY, OpenController)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, OpenController.prototype.open)).toBe(
      true,
    );
  });

  it('leaves undecorated handlers protected (no metadata)', () => {
    expect(
      new Reflector().get(IS_PUBLIC_KEY, OpenController.prototype.closed),
    ).toBeUndefined();
  });
});

describe('@Roles()', () => {
  class Controller {
    @Roles(Role.ADMIN, Role.REVIEWER)
    restricted() {}
    anyone() {}
  }

  it('records the allowed roles in order', () => {
    expect(
      new Reflector().get(ROLES_KEY, Controller.prototype.restricted),
    ).toEqual([Role.ADMIN, Role.REVIEWER]);
  });

  it('has no roles metadata on undecorated handlers, which RolesGuard reads as "any authenticated user"', () => {
    expect(
      new Reflector().get(ROLES_KEY, Controller.prototype.anyone),
    ).toBeUndefined();
  });
});

describe('@CurrentUser()', () => {
  class Controller {
    handler(@CurrentUser() user: AuthUser) {
      return user;
    }
  }

  /** Nest stores a param decorator's factory in route-args metadata. */
  const factory = () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      Controller,
      'handler',
    );
    return Object.values(
      args as Record<
        string,
        { factory: (d: unknown, c: ExecutionContext) => AuthUser }
      >,
    )[0].factory;
  };
  const contextWith = (request: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  it('returns the user the JWT guard attached to the request', () => {
    const user: AuthUser = { id: 'u1', email: 'a@b.co', role: Role.SALES };
    expect(factory()(undefined, contextWith({ user }))).toBe(user);
  });

  it('takes identity from the verified token only, never from the body, query or headers', () => {
    const tokenUser: AuthUser = {
      id: 'real',
      email: 'real@x.co',
      role: Role.SALES,
    };
    const result = factory()(
      undefined,
      contextWith({
        user: tokenUser,
        body: { role: 'ADMIN', id: 'attacker', user: { role: 'ADMIN' } },
        query: { role: 'ADMIN' },
        headers: { 'x-user-role': 'ADMIN', 'x-user-id': 'attacker' },
      }),
    );
    expect(result).toEqual({
      id: 'real',
      email: 'real@x.co',
      role: Role.SALES,
    });
  });

  it('is undefined when no guard ran, rather than inventing a user', () => {
    expect(factory()(undefined, contextWith({}))).toBeUndefined();
  });
});
