import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ApplicationsModule } from './applications/applications.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HttpLoggingMiddleware } from './common/middleware/http-logging.middleware';
import { validateFieldEncryptionKey } from './common/security/field-encryption';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PoliciesModule } from './policies/policies.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast at startup rather than on the first encrypted write.
      validate: (config: Record<string, unknown>) => {
        validateFieldEncryptionKey(config);
        return config;
      },
    }),
    DatabaseModule,
    QueueModule,
    AuthModule,
    PoliciesModule,
    ApplicationsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Order matters: the logger reads the request id set by the first one.
    consumer
      .apply(RequestIdMiddleware, HttpLoggingMiddleware)
      .forRoutes('*path');
  }
}
