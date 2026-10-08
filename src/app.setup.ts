import { INestApplication } from '@nestjs/common';
import { createValidationPipe } from './common/pipes/validation.pipe';

/** App-level setup shared by main.ts and e2e tests. */
export const configureApp = (app: INestApplication) => {
  app.useGlobalPipes(createValidationPipe());
};
