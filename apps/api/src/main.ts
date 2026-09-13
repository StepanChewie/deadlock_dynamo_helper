import { randomUUID } from 'node:crypto';
import { json } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

if (!('crypto' in globalThis)) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID },
    configurable: true,
  });
}

async function bootstrap(): Promise<void> {
  // The Overwolf client batches live game events and can send payloads well
  // above the default 100kb JSON limit (especially after reconnects), so the
  // ingest endpoint needs a larger body limit.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '10mb' }));
  app.enableCors();
  await app.listen(3000);
}

void bootstrap();
