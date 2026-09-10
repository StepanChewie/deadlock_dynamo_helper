import { Module } from '@nestjs/common';
import { StatlockerAdaptiveModule } from '../statlocker-adaptive/statlocker-adaptive.module';
import { BuildDebugAuthV2Guard } from './build-debug-auth-v2.guard';
import { BuildDebugAuthV2Service } from './build-debug-auth-v2.service';
import { BuildDebugV2Controller } from './build-debug-v2.controller';

@Module({
  imports: [StatlockerAdaptiveModule],
  controllers: [BuildDebugV2Controller],
  providers: [BuildDebugAuthV2Service, BuildDebugAuthV2Guard],
})
export class BuildDebugV2Module {}
