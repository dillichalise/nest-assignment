import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
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
import { PolicyService } from '../policies/policy.service';
import { AuditEntityType } from '../audit/audit-entity-type';
import { AuditService } from '../audit/audit.service';
import {
  AuditLogResponseDto,
  PaginatedAuditLogsDto,
} from '../audit/dto/audit-log-response.dto';
import { AuditLogsQueryDto } from '../audit/dto/audit-logs-query.dto';
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

@ApiBearerAuth()
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly workflow: ApplicationWorkflowService,
    private readonly policy: PolicyService,
    private readonly auditTrail: AuditService,
  ) {}

  @Post()
  @ApiTags('Applications')
  @Roles(Role.SALES, Role.ADMIN)
  @ApiBody({
    type: CreateApplicationDto,
    examples: {
      restaurant: {
        summary: 'A restaurant',
        value: {
          businessName: 'Blue Door Cafe',
          legalBusinessName: 'Blue Door Hospitality',
          businessType: 'restaurant',
          ownerName: 'Pat Owner',
          ownerEmail: 'pat@bluedoor.example',
          ownerPhone: '+977 9876543210',
          ownerTaxId: '123-456-789',
          monthlyVolume: 25000,
          averageTicketSize: 42.5,
          currency: 'USD',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Create a merchant application (starts as DRAFT)',
    description:
      'SALES and ADMIN only. The application is owned by the caller and starts as DRAFT; it can be edited until it is submitted. Amounts are positive, with at most 2 decimals (a number or a numeric string); `currency` is an ISO 4217 code such as USD. Fields that the server controls (`status`, `riskStatus`, `createdById`, `assignedReviewerId`, ...) are ignored if sent.',
  })
  @ApiCreatedResponse({
    type: ApplicationResponseDto,
    description:
      'The new application, in DRAFT. Owner email, phone and tax id are masked.',
  })
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
  @ApiTags('Applications')
  @ApiOperation({
    summary: 'List applications visible to the caller',
    description:
      'SALES see only their own applications, REVIEWER only those assigned to them, ADMIN all. Newest first.',
  })
  @ApiOkResponse({
    type: PaginatedApplicationsDto,
    description:
      'A page of applications, newest first, with the total across all pages.',
  })
  @ApiErrorResponses(400, 401)
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListApplicationsQueryDto,
  ): Promise<PaginatedApplicationsDto> {
    const { items, ...meta } = await this.applications.list(user, query);
    return { items: items.map((a) => ApplicationResponseDto.from(a)), ...meta };
  }

  @Get(':id')
  @ApiTags('Applications')
  @ApiOperation({
    summary: 'Get one application',
    description:
      'Returns 404 both when the application does not exist and when the caller may not see it. Owner email, phone and tax id are masked, except for an ADMIN, who sees the full values here (and only here).',
  })
  @ApiOkResponse({
    type: ApplicationResponseDto,
    description:
      'The application. `riskResult` is included for ADMIN and REVIEWER only.',
  })
  @ApiErrorResponses(400, 401, 404)
  async findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applications.findOne(user, id);
    return ApplicationResponseDto.from(application, {
      revealSensitive: this.policy.canViewSensitiveOwnerData(user),
      includeRiskDetails: this.policy.canViewRiskDetails(user),
    });
  }

  @Get(':id/audit')
  @ApiTags('Audit trail')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Audit trail of one application (ADMIN only)',
    description:
      'Every significant action on the application, oldest first: creation, edits (field names only), submission, reviewer assignment, risk-review start/completion/failure/retry and the decision. Metadata is sanitized: secrets are removed and emails and phone numbers are masked.',
  })
  @ApiOkResponse({
    type: PaginatedAuditLogsDto,
    description: 'A page of audit records, oldest first.',
  })
  @ApiErrorResponses(400, 401, 403, 404)
  async auditTrailOf(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AuditLogsQueryDto,
  ): Promise<PaginatedAuditLogsDto> {
    // Defense in depth behind @Roles, and the single place the rule is named.
    if (!this.policy.canViewAuditTrail(user)) {
      throw new ForbiddenException('Only an admin may read the audit trail');
    }
    // 404 for an unknown application rather than an empty page.
    await this.applications.findOne(user, id);

    const { items, ...meta } = await this.auditTrail.listForEntity(
      AuditEntityType.APPLICATION,
      id,
      query,
    );
    return { items: items.map((l) => AuditLogResponseDto.from(l)), ...meta };
  }

  @Patch(':id')
  @ApiTags('Applications')
  @Roles(Role.SALES, Role.ADMIN)
  @ApiBody({
    type: UpdateApplicationDto,
    examples: {
      rename: {
        summary: 'Change one field',
        value: { businessName: 'Blue Door Bistro' },
      },
      correct: {
        summary: 'Answer a request for information',
        value: { businessType: 'restaurant', monthlyVolume: 30000 },
      },
    },
  })
  @ApiOperation({
    summary: 'Update an application',
    description:
      'Only while DRAFT or INFO_REQUESTED. SALES may update only their own applications.',
  })
  @ApiOkResponse({
    type: ApplicationResponseDto,
    description: 'The updated application. Only the fields you sent change.',
  })
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
  @ApiTags('Application workflow')
  @HttpCode(200)
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({
    summary: 'Submit an application for review',
    description:
      'DRAFT or INFO_REQUESTED -> SUBMITTED. SALES may submit only their own applications. Required fields must be complete (422 otherwise). Risk review is restarted for every submission.',
  })
  @ApiOkResponse({
    type: ApplicationResponseDto,
    description:
      'The application, now SUBMITTED, with a PENDING risk review running in the background.',
  })
  @ApiErrorResponses(400, 401, 403, 404, 409, 422)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.workflow.submit(user, id));
  }

  @Post(':id/assign')
  @ApiTags('Application workflow')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  @ApiBody({
    type: AssignReviewerDto,
    examples: {
      assign: {
        summary: 'Assign a reviewer',
        description:
          'Use the `id` that `GET /auth/me` returns when logged in as the reviewer.',
        value: { reviewerId: '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11' },
      },
    },
  })
  @ApiOperation({
    summary: 'Assign a reviewer (ADMIN only)',
    description:
      'SUBMITTED -> IN_REVIEW. While IN_REVIEW the reviewer may be changed; in any other status this is a 409. The target must be an active REVIEWER (422 otherwise).',
  })
  @ApiOkResponse({
    type: ApplicationResponseDto,
    description: 'The application, now IN_REVIEW with the chosen reviewer.',
  })
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

  @Post(':id/risk-review/retry')
  @ApiTags('Risk review')
  @HttpCode(202)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Retry a failed risk review (ADMIN only)',
    description:
      'Only when the risk review FAILED and the application is SUBMITTED or IN_REVIEW (409 otherwise). Queues a new review and returns immediately with riskStatus PENDING; poll the application for the outcome. 503 if the queue is unavailable (the review stays FAILED and can be retried again).',
  })
  @ApiAcceptedResponse({
    type: ApplicationResponseDto,
    description:
      'The review was queued again. riskStatus is PENDING; poll the application for the outcome.',
  })
  @ApiErrorResponses(401, 403, 404, 409, 503)
  async retryRiskReview(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(
      await this.workflow.retryRiskReview(user, id),
    );
  }

  @Post(':id/decision')
  @ApiTags('Application workflow')
  @HttpCode(200)
  @Roles(Role.REVIEWER)
  @ApiBody({
    type: RecordDecisionDto,
    examples: {
      approve: {
        summary: 'Approve (reason optional)',
        value: { decision: 'APPROVED' },
      },
      reject: {
        summary: 'Reject (reason required)',
        value: {
          decision: 'REJECTED',
          reason: 'Business could not be verified.',
        },
      },
      requestInfo: {
        summary: 'Ask the applicant for more information (reason required)',
        value: {
          decision: 'INFO_REQUESTED',
          reason: 'Please add the trade licence number.',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Record a risk decision (assigned REVIEWER only)',
    description:
      'IN_REVIEW -> APPROVED | REJECTED | INFO_REQUESTED. Only the assigned reviewer (others get 404; ADMIN and SALES get 403). Requires the risk review to be COMPLETED (409 otherwise). A reason is required for REJECTED and INFO_REQUESTED.',
  })
  @ApiOkResponse({
    type: ApplicationResponseDto,
    description: 'The application with the decision recorded.',
  })
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
