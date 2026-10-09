import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user.interface';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { ApplicationsService } from './applications.service';
import {
  ApplicationResponseDto,
  PaginatedApplicationsDto,
} from './dto/application-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({ summary: 'Create a merchant application (starts as DRAFT)' })
  @ApiCreatedResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 403)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateApplicationDto,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.applications.create(user, dto),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List applications visible to the caller',
    description:
      'SALES see only their own applications, REVIEWER only those assigned to them, ADMIN all. Newest first.',
  })
  @ApiOkResponse({ type: PaginatedApplicationsDto })
  @ApiErrorResponses(400, 401)
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListApplicationsQueryDto,
  ): Promise<PaginatedApplicationsDto> {
    const { items, ...meta } = await this.applications.list(user, query);
    return { items: items.map((a) => ApplicationResponseDto.from(a)), ...meta };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one application',
    description:
      'Returns 404 both when the application does not exist and when the caller may not see it.',
  })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 404)
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.applications.findOne(user, id),
    );
  }

  @Patch(':id')
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({
    summary: 'Update an application',
    description:
      'Only while DRAFT or INFO_REQUESTED. SALES may update only their own applications.',
  })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.applications.update(user, id, dto),
    );
  }
}
