import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { BuildDebugAuthV2Service } from './build-debug-auth-v2.service';

@Injectable()
export class BuildDebugAuthV2Guard implements CanActivate {
  constructor(private readonly auth: BuildDebugAuthV2Service) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers?: { cookie?: string } }>();
    const token = this.auth.tokenFromCookieHeader(request.headers?.cookie);
    if (!token || !this.auth.validate(token)) {
      throw new UnauthorizedException('Build debugger authentication required');
    }
    return true;
  }
}
