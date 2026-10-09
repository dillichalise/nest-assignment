import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ApplicationWorkflowService } from './application-workflow.service';
import { ApplicationsService } from './applications.service';
import {
  ApplicationResponseDto,
  PaginatedApplicationsDto,
} from './dto/application-response.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly workflow: ApplicationWorkflowService,
  ) {}

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

  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({
    summary: 'Submit an application for review',
    description:
      'DRAFT or INFO_REQUESTED -> SUBMITTED. SALES may submit only their own applications. Required fields must be complete (422 otherwise). Risk review is restarted for every submission.',
  })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 403, 404, 409, 422)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.workflow.submit(user, id));
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Assign a reviewer (ADMIN only)',
    description:
      'SUBMITTED -> IN_REVIEW. While IN_REVIEW the reviewer may be changed; in any other status this is a 409. The target must be an active REVIEWER (422 otherwise).',
  })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 403, 404, 409, 422)
  async assign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignReviewerDto,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.workflow.assign(user, id, dto.reviewerId),
    );
  }

  @Post(':id/decision')
  @HttpCode(200)
  @Roles(Role.REVIEWER)
  @ApiOperation({
    summary: 'Record a risk decision (assigned REVIEWER only)',
    description:
      'IN_REVIEW -> APPROVED | REJECTED | INFO_REQUESTED. Only the assigned reviewer (others get 404; ADMIN and SALES get 403). Requires the risk review to be COMPLETED (409 otherwise). A reason is required for REJECTED and INFO_REQUESTED.',
  })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordDecisionDto,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.workflow.decide(user, id, dto.decision, dto.reason),
    );
  }
}
