import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { HealthResponseDto } from './health-response.dto';

@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Service health check',
    description: 'Needs no token. Answers 200 while the process is up.',
  })
  @ApiOkResponse({
    type: HealthResponseDto,
    description: 'The service is running.',
  })
  @ApiErrorResponses(500)
  check(): HealthResponseDto {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
