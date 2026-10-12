import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditEntityType } from '../audit/audit-entity-type';
import { AuditRecorder } from '../audit/audit-recorder';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { JwtPayload } from './auth-user.interface';
import { getJwtExpiresInSeconds } from './jwt-expiry';
import { LoginResponseDto } from './dto/login-response.dto';

// Compared against when the email is unknown, so response time does not
// reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditRecorder,
  ) {}

  async login(email: string, password: string): Promise<LoginResponseDto> {
    const user = await this.users.findByEmailWithPassword(email);
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hash);

    // One generic error for unknown email, wrong password and inactive user.
    // The CLIENT never learns which; the audit trail records the real reason.
    if (!user || !passwordMatches || !user.isActive) {
      await this.audit.record({
        action: AuditAction.LOGIN_FAILED,
        // The account that was targeted, if there is one: useful for spotting
        // someone hammering a single user. null for an unknown email.
        actor: user ? { id: user.id, role: user.role } : null,
        entityType: AuditEntityType.USER,
        entityId: user?.id ?? null,
        // Never the password. The email is masked by the sanitizer.
        metadata: {
          reason: !user
            ? 'UNKNOWN_EMAIL'
            : !passwordMatches
              ? 'BAD_PASSWORD'
              : 'INACTIVE_USER',
          email,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwt.signAsync(payload);

    // Never the token itself.
    await this.audit.record({
      action: AuditAction.LOGIN_SUCCEEDED,
      actor: { id: user.id, role: user.role },
      entityType: AuditEntityType.USER,
      entityId: user.id,
    });
    return {
      accessToken,
      expiresIn: getJwtExpiresInSeconds(this.config),
    };
  }

  /** Loads the current user; rejects tokens of deleted/deactivated users. */
  async getCurrentUser(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
