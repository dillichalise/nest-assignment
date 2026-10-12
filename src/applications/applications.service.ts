import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditEntityType } from '../audit/audit-entity-type';
import { AuditRecorder } from '../audit/audit-recorder';
import { AuthUser } from '../auth/auth-user.interface';
import { NotFoundError } from '../common/errors/domain.error';
import { PolicyService } from '../policies/policy.service';
import { EDITABLE_STATUSES, isEditable } from './application-state-machine';
import { ApplicationNotEditableError } from './application.errors';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { ApplicationStatus } from './enums/application-status.enum';
import { RiskStatus } from './enums/risk-status.enum';
import { MerchantApplication } from './merchant-application.entity';

@Injectable()
export class ApplicationsService {
  constructor(
    @InjectRepository(MerchantApplication)
    private readonly repo: Repository<MerchantApplication>,
    private readonly policy: PolicyService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditRecorder,
  ) {}

  async create(
    user: AuthUser,
    dto: CreateApplicationDto,
  ): Promise<MerchantApplication> {
    // The row and its audit record commit (or roll back) together.
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(MerchantApplication);
      const application = repo.create({
        businessName: dto.businessName,
        legalBusinessName: dto.legalBusinessName,
        businessType: dto.businessType,
        ownerName: dto.ownerName,
        ownerEmail: dto.ownerEmail,
        ownerPhone: dto.ownerPhone,
        ownerTaxId: dto.ownerTaxId,
        monthlyVolume: dto.monthlyVolume,
        averageTicketSize: dto.averageTicketSize,
        currency: dto.currency,
        // Server-controlled; never taken from the request body.
        createdById: user.id,
        status: ApplicationStatus.DRAFT,
        riskStatus: RiskStatus.NOT_STARTED,
      });
      const saved = await repo.save(application);
      await this.audit.record(
        {
          action: AuditAction.APPLICATION_CREATED,
          actor: user,
          entityType: AuditEntityType.APPLICATION,
          entityId: saved.id,
          metadata: { initialStatus: ApplicationStatus.DRAFT },
        },
        manager,
      );
      // Re-read so the response matches GET exactly (DB-normalized decimals, defaults).
      return repo.findOneByOrFail({ id: saved.id });
    });
  }

  async findOne(user: AuthUser, id: string): Promise<MerchantApplication> {
    const application = await this.loadOrNotFound(id);
    this.policy.assertCanView(user, application);
    return application;
  }

  async list(
    user: AuthUser,
    query: ListApplicationsQueryDto,
  ): Promise<{
    items: MerchantApplication[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, status } = query;
    const [items, total] = await this.repo.findAndCount({
      where: {
        ...this.policy.applicationScope(user),
        ...(status && { status }),
      },
      // id as tie-breaker keeps pagination stable for equal timestamps.
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateApplicationDto,
  ): Promise<MerchantApplication> {
    const application = await this.loadOrNotFound(id);

    // Authorization first: a caller who may not see the application must get
    // the same 404 as for a missing id, never a state-revealing 409.
    this.policy.assertCanEdit(user, application);

    if (!isEditable(application.status)) {
      throw new ApplicationNotEditableError(application.status);
    }

    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(patch).length === 0) {
      return application;
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(MerchantApplication);

      // Compare-and-set on status: if a submit raced us, nothing is updated.
      const result = await repo.update(
        { id, status: In([...EDITABLE_STATUSES]) },
        patch,
      );
      if (!result.affected) {
        throw new ApplicationNotEditableError();
      }
      await this.audit.record(
        {
          action: AuditAction.APPLICATION_UPDATED,
          actor: user,
          entityType: AuditEntityType.APPLICATION,
          entityId: id,
          // Field NAMES only: values can be personal data (email, tax id).
          metadata: { changedFields: Object.keys(patch).sort() },
        },
        manager,
      );
      return repo.findOneByOrFail({ id });
    });
  }

  private async loadOrNotFound(id: string): Promise<MerchantApplication> {
    const application = await this.repo.findOneBy({ id });
    if (!application) {
      throw new NotFoundError('Application not found');
    }
    return application;
  }
}
