import { Module } from '@nestjs/common';
import { AuditRecorder } from './audit-recorder';
import { NoopAuditRecorder } from './noop-audit-recorder';

@Module({
  providers: [{ provide: AuditRecorder, useClass: NoopAuditRecorder }],
  exports: [AuditRecorder],
})
export class AuditModule {}
