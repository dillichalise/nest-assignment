import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { AuditModule } from '../audit/audit.module';
import { QueueModule } from '../queue/queue.module';
import { RiskProviderClient } from './risk-provider';
import { RiskReviewProcessor } from './risk-review.processor';
import { RiskReviewService } from './risk-review.service';
import { SimulatedRiskProvider } from './simulated-risk-provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([MerchantApplication]),
    QueueModule,
    AuditModule,
  ],
  providers: [
    RiskReviewService,
    RiskReviewProcessor,
    // Swap for a real client without touching the worker.
    { provide: RiskProviderClient, useClass: SimulatedRiskProvider },
  ],
  exports: [RiskReviewService],
})
export class RiskReviewModule {}
