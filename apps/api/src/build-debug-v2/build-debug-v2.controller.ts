import {
  Body,
  Controller,
  Get,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  Sse,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { BuildDebugTraceStoreV2Service } from '../statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDebugAuthV2Guard } from './build-debug-auth-v2.guard';
import { BuildDebugAuthV2Service } from './build-debug-auth-v2.service';

interface HeaderResponseV2 {
  setHeader(name: string, value: string): void;
}

interface CookieRequestV2 {
  headers?: { cookie?: string };
}

@Controller('debug/build-v2')
export class BuildDebugV2Controller {
  constructor(
    private readonly auth: BuildDebugAuthV2Service,
    private readonly traces: BuildDebugTraceStoreV2Service,
  ) {}

  @Post('login')
  login(
    @Body() body: { password?: unknown },
    @Res({ passthrough: true }) response: HeaderResponseV2,
  ): { authenticated: true } {
    if (!body || typeof body.password !== 'string') {
      throw new UnauthorizedException('Invalid build debugger password');
    }
    const token = this.auth.login(body.password);
    if (!token) throw new UnauthorizedException('Invalid build debugger password');
    response.setHeader('Set-Cookie', this.auth.sessionCookie(token));
    return { authenticated: true };
  }

  @Post('logout')
  @UseGuards(BuildDebugAuthV2Guard)
  logout(
    @Req() request: CookieRequestV2,
    @Res({ passthrough: true }) response: HeaderResponseV2,
  ): { authenticated: false } {
    const token = this.auth.tokenFromCookieHeader(request.headers?.cookie);
    if (token) this.auth.revoke(token);
    response.setHeader('Set-Cookie', this.auth.expiredSessionCookie());
    return { authenticated: false };
  }

  @Get('matches')
  @UseGuards(BuildDebugAuthV2Guard)
  matches() {
    return this.traces.listActive();
  }

  @Get('matches/:matchId')
  @UseGuards(BuildDebugAuthV2Guard)
  snapshot(@Param('matchId') matchId: string) {
    const trace = this.traces.get(matchId);
    if (!trace) throw new NotFoundException(`Build debug trace not found for match ${matchId}`);
    return trace;
  }

  @Sse('matches/:matchId/stream')
  @UseGuards(BuildDebugAuthV2Guard)
  stream(@Param('matchId') matchId: string): Observable<MessageEvent> {
    return this.traces.observe(matchId).pipe(
      map((trace) => ({ type: 'trace', data: trace })),
    );
  }
}
