import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { AuthenticatedRequest } from './auth-user.interface';
import { AuthService } from './auth.service';
import { LoginResponseDto } from './dto/login-response.dto';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiBody({
    type: LoginDto,
    examples: {
      sales: {
        summary: 'A sales user',
        value: {
          email: 'sales@example.com',
          password: 'the SEED_PASSWORD from your .env',
        },
      },
      admin: {
        summary: 'The admin',
        value: {
          email: 'admin@example.com',
          password: 'the SEED_PASSWORD from your .env',
        },
      },
      reviewer: {
        summary: 'A reviewer',
        value: {
          email: 'reviewer@example.com',
          password: 'the SEED_PASSWORD from your .env',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Exchange credentials for a JWT',
    description:
      'Returns a token valid for `expiresIn` seconds. Paste it into **Authorize** (top right) to call the other endpoints. Wrong password, unknown email and a deactivated account all give the same 401, so the response never reveals which accounts exist.',
  })
  @ApiOkResponse({
    type: LoginResponseDto,
    description: 'A signed JWT and its lifetime in seconds.',
  })
  @ApiErrorResponses(400, 401)
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current authenticated user',
    description:
      'Who the token belongs to. Handy for finding your own `id`, for example the reviewer id needed to assign an application.',
  })
  @ApiOkResponse({
    type: MeResponseDto,
    description: 'The user the token was issued to.',
  })
  @ApiErrorResponses(401)
  async me(@Req() req: AuthenticatedRequest): Promise<MeResponseDto> {
    const { id, email, name, role } = await this.auth.getCurrentUser(
      req.user.id,
    );
    return { id, email, name, role };
  }
}
