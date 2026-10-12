import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { setupSwagger } from './swagger.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  setupSwagger(app);

  const port = app.get(ConfigService).get<number>('PORT', 5001);
  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Swagger docs at http://localhost:${port}/docs`);
}
bootstrap();
