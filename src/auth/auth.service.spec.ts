import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Role } from '../common/enums/role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const password = 'correct-horse';
  let user: User;
  let users: jest.Mocked<
    Pick<UsersService, 'findByEmailWithPassword' | 'findById'>
  >;
  let jwt: { signAsync: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    user = {
      id: 'u1',
      email: 'sales@example.com',
      name: 'Sam',
      role: Role.SALES,
      isActive: true,
      passwordHash: bcrypt.hashSync(password, 4),
    } as User;
    users = { findByEmailWithPassword: jest.fn(), findById: jest.fn() };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };
    const config = { getOrThrow: jest.fn().mockReturnValue('3600') };
    service = new AuthService(
      users as unknown as UsersService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
    );
  });

  it('issues a token with sub, email and role for valid credentials', async () => {
    users.findByEmailWithPassword.mockResolvedValue(user);

    const result = await service.login(user.email, password);

    expect(result).toEqual({
      accessToken: 'signed.jwt.token',
      expiresIn: 3600,
    });
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'u1',
      email: user.email,
      role: Role.SALES,
    });
  });

  it('rejects a wrong password', async () => {
    users.findByEmailWithPassword.mockResolvedValue(user);
    await expect(service.login(user.email, 'nope')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('rejects an inactive user even with the right password', async () => {
    users.findByEmailWithPassword.mockResolvedValue({
      ...user,
      isActive: false,
    });
    await expect(service.login(user.email, password)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('gives the same error for unknown email, wrong password and inactive user', async () => {
    const messageOf = async (setup: () => void, pw: string) => {
      setup();
      return service
        .login(user.email, pw)
        .catch((e: UnauthorizedException) => e.getResponse());
    };

    const unknown = await messageOf(
      () => users.findByEmailWithPassword.mockResolvedValue(null),
      password,
    );
    const wrong = await messageOf(
      () => users.findByEmailWithPassword.mockResolvedValue(user),
      'nope',
    );
    const inactive = await messageOf(
      () =>
        users.findByEmailWithPassword.mockResolvedValue({
          ...user,
          isActive: false,
        }),
      password,
    );

    expect(unknown).toEqual(wrong);
    expect(wrong).toEqual(inactive);
  });

  it('rejects tokens of users that are missing or deactivated', async () => {
    users.findById.mockResolvedValue(null);
    await expect(service.getCurrentUser('u1')).rejects.toThrow(
      UnauthorizedException,
    );

    users.findById.mockResolvedValue({ ...user, isActive: false });
    await expect(service.getCurrentUser('u1')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
