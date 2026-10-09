import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';
import { ApplicationWorkflowService } from './application-workflow.service';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { MerchantApplication } from './merchant-application.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([MerchantApplication]),
    PoliciesModule,
    UsersModule,
    AuditModule,
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, ApplicationWorkflowService],
  exports: [ApplicationsService, ApplicationWorkflowService],
})
export class ApplicationsModule {}
