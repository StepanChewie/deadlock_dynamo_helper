import { randomUUID } from 'node:crypto';
import { json } from 'express';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { INTERNAL_API_KEY_HEADER } from './common/internal-api.guard';

if (!('crypto' in globalThis)) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID },
    configurable: true,
  });
}

/**
 * Ingest carries a batch of raw game events, and a client that has been offline
 * or wedged can arrive with a large backlog, so it keeps a large allowance.
 *
 * This was measured, not guessed: production returned 413 for real client
 * batches that exceeded the old limit, so lowering it would reintroduce the
 * failure. The client now chunks its own batches well below this.
 */
const INGEST_BODY_LIMIT = '10mb';

/**
 * The Statlocker probe forwards an arbitrary body on the operator's behalf, so
 * it shares the large allowance. It is behind the internal key.
 */
const PROBE_BODY_LIMIT = '10mb';

/**
 * Every other route carries a small JSON document — a match id, a vote, a
 * password. The previous single 10mb limit applied to all of them, which let an
 * unauthenticated caller make the server buffer 10mb for a request that only
 * ever needs a few hundred bytes.
 */
const DEFAULT_BODY_LIMIT = '256kb';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  // nginx is the only thing that can reach this port (see the compose file) and
  // it appends the real client address to X-Forwarded-For. Trusting exactly one
  // hop makes req.ip the real client address instead of 127.0.0.1 for everyone,
  // which is what the rate limiter keys on.
  //
  // `1` and not `true`: with `true` Express would believe a client-supplied
  // X-Forwarded-For prefix, letting anyone rotate their apparent address and
  // walk straight through the rate limiter.
  app.set('trust proxy', 1);

  // Order matters: body-parser skips a request whose body is already parsed, so
  // the specific routes below win and everything else falls through to the
  // small default.
  app.use('/deadlock/live/events', json({ limit: INGEST_BODY_LIMIT }));
  app.use('/deadlock/tools/statlocker', json({ limit: PROBE_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));

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
