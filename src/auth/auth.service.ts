import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
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
  ) {}

  async login(email: string, password: string): Promise<LoginResponseDto> {
    const user = await this.users.findByEmailWithPassword(email);
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hash);

    // One generic error for unknown email, wrong password and inactive user.
    if (!user || !passwordMatches || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
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
