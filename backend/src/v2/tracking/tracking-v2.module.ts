import { Global, Module } from '@nestjs/common';
import { RealtimeEmitter } from './realtime.emitter';
import { TrackingV2Gateway } from './tracking-v2.gateway';

@Global()
@Module({
  providers: [TrackingV2Gateway, RealtimeEmitter],
  exports: [TrackingV2Gateway, RealtimeEmitter],
})
export class TrackingV2Module {}
