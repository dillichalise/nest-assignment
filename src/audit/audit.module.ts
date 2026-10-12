import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './audit-log.entity';
import { AuditRecorder } from './audit-recorder';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [
    AuditService,
    // Business code depends on the abstract port; this is its implementation.
    { provide: AuditRecorder, useExisting: AuditService },
  ],
  exports: [AuditRecorder, AuditService],
})
export class AuditModule {}
