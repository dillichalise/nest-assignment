import { Injectable } from '@nestjs/common';
import { AuditRecorder } from './audit-recorder';

@Injectable()
export class NoopAuditRecorder extends AuditRecorder {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
