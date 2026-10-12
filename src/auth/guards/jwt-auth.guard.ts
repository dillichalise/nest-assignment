import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { UsersService } from '../../users/users.service';
import { AuthenticatedRequest, JwtPayload } from '../auth-user.interface';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Registered globally: every route needs a valid bearer token unless @Public().
 *
 * Two steps, answering two different questions:
 *   1. Is the token genuine and unexpired? (signature + expiry: cheap, no I/O)
 *   2. Is its user STILL allowed in, and with which role? The token only proves
 *      who the user was when it was issued, so the database is asked on every
 *      request. A user who is deactivated or deleted is refused immediately, and
 *      a role change takes effect immediately: the role (and email) on
 *      `req.user` come from the database, never from the token's claims.
 *
 * The price is one primary-key read per authenticated request. A very short
 * cache would cut that at the cost of a matching staleness window; see
 * docs/DECISIONS.md.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException();
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (!isUUID(payload.sub)) {
      throw new UnauthorizedException();
    }

    // Deliberately OUTSIDE the try block above: if the database is unavailable
    // this must surface as a server error, not be disguised as "unauthorized".
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      // Same response as a bad token: nothing reveals that the account exists.
      throw new UnauthorizedException();
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    return true;
  }
}
