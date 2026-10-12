import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RISK_REVIEW_QUEUE } from './queue.constants';
import { buildRiskReviewJobOptions } from './risk-review-job-options';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT', 6379)),
        },
        // Lets a second environment (e.g. the e2e suite) share one Redis
        // without its jobs ever reaching another environment's worker.
        prefix: config.get<string>('QUEUE_PREFIX', 'bull'),
      }),
    }),
    BullModule.registerQueueAsync({
      name: RISK_REVIEW_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        defaultJobOptions: buildRiskReviewJobOptions(config),
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
