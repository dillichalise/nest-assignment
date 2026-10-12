import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditRecorder } from '../audit/audit-recorder';
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
  let audit: { record: jest.Mock };
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
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { getOrThrow: jest.fn().mockReturnValue('3600') };
    service = new AuthService(
      users as unknown as UsersService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      audit as unknown as AuditRecorder,
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

  describe('audit trail', () => {
    const auditedActions = () => audit.record.mock.calls.map(([e]) => e.action);

    it('records a successful login for the user, with no token or password', async () => {
      users.findByEmailWithPassword.mockResolvedValue(user);

      await service.login(user.email, password);

      expect(audit.record).toHaveBeenCalledTimes(1);
      const [event] = audit.record.mock.calls[0];
      expect(event).toEqual({
        action: AuditAction.LOGIN_SUCCEEDED,
        actor: { id: 'u1', role: Role.SALES },
        entityType: 'User',
        entityId: 'u1',
      });
      const json = JSON.stringify(event);
      expect(json).not.toContain(password);
      expect(json).not.toContain('signed.jwt.token');
    });

    it('records the REAL reason for a wrong password, against the targeted account', async () => {
      users.findByEmailWithPassword.mockResolvedValue(user);

      await service.login(user.email, 'wrong-password').catch(() => undefined);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][0]).toEqual({
        action: AuditAction.LOGIN_FAILED,
        actor: { id: 'u1', role: Role.SALES },
        entityType: 'User',
        entityId: 'u1',
        metadata: { reason: 'BAD_PASSWORD', email: user.email },
      });
    });

    it('records an unknown email with no actor and no entity', async () => {
      users.findByEmailWithPassword.mockResolvedValue(null);

      await service.login('nobody@example.com', 'x').catch(() => undefined);

      expect(audit.record.mock.calls[0][0]).toEqual({
        action: AuditAction.LOGIN_FAILED,
        actor: null,
        entityType: 'User',
        entityId: null,
        metadata: { reason: 'UNKNOWN_EMAIL', email: 'nobody@example.com' },
      });
    });

    it('records an inactive account (correct password) as INACTIVE_USER', async () => {
      users.findByEmailWithPassword.mockResolvedValue({
        ...user,
        isActive: false,
      });

      await service.login(user.email, password).catch(() => undefined);

      expect(audit.record.mock.calls[0][0].metadata).toEqual({
        reason: 'INACTIVE_USER',
        email: user.email,
      });
      expect(auditedActions()).toEqual([AuditAction.LOGIN_FAILED]);
    });

    it('never puts the attempted password in a failure record', async () => {
      users.findByEmailWithPassword.mockResolvedValue(user);
      await service.login(user.email, 'my-secret-guess').catch(() => undefined);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'my-secret-guess',
      );
    });

    it('the client still gets one generic error whatever the recorded reason', async () => {
      const bodies: unknown[] = [];
      for (const found of [null, user, { ...user, isActive: false }]) {
        users.findByEmailWithPassword.mockResolvedValue(found as User | null);
        const pw = found === user ? 'wrong' : password;
        bodies.push(
          await service
            .login(user.email, pw)
            .catch((e: UnauthorizedException) => e.getResponse()),
        );
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
      expect(JSON.stringify(bodies)).not.toMatch(
        /BAD_PASSWORD|UNKNOWN_EMAIL|INACTIVE_USER/,
      );
    });

    it('does not issue a token if the audit write fails (fail closed)', async () => {
      users.findByEmailWithPassword.mockResolvedValue(user);
      audit.record.mockRejectedValue(new Error('audit table unavailable'));
      await expect(service.login(user.email, password)).rejects.toThrow(
        'audit table unavailable',
      );
    });

    it('records nothing for the /auth/me lookup', async () => {
      users.findById.mockResolvedValue(user);
      await service.getCurrentUser('u1');
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
