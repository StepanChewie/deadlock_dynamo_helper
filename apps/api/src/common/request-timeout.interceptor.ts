import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

/**
 * Bounds how long a public handler may run.
 *
 * The shipped client has no request timeout of its own, so a handler that
 * stalls leaves the client's flush hanging with the batch still in flight —
 * nothing else is sent until it settles. Failing fast here lets the client
 * retry or drop the batch instead of stalling indefinitely.
 *
 * Do not attach this to `POST /deadlock/adaptive/v2/recommend`: that route
 * legitimately computes for seconds, and a timeout would convert correct slow
 * work into a client-visible failure.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((error: unknown) =>
        throwError(() =>
          isTimeoutError(error)
            ? new RequestTimeoutException(`Request exceeded ${this.timeoutMs}ms`)
            : error,
        ),
      ),
    );
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}
