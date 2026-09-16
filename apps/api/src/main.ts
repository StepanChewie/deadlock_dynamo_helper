import { randomUUID } from 'node:crypto';
import { json } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { INTERNAL_API_KEY_HEADER } from './common/internal-api.guard';

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
  app.enableCors({
    origin: readCorsOrigins(),
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', INTERNAL_API_KEY_HEADER],
  });
  await app.listen(3000);
}

/**
 * CORS_ALLOWED_ORIGINS is a comma-separated allowlist. When it is unset the
 * server stays permissive, which is what local runs and tests need.
 *
 * Deliberately not defaulting to a guessed value: Overwolf windows call this API
 * over HTTPS and the exact Origin header they send is not knowable from the
 * source. It has to be observed on a live build (temporarily log it here, or
 * read it from the nginx access log) before it is pinned, otherwise the client
 * breaks in the field. If it turns out to be `null`, allow `null` explicitly and
 * comment why, or someone will "tidy" it away later.
 */
function readCorsOrigins(): string[] | boolean {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : true;
}

void bootstrap();
