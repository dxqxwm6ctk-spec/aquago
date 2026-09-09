import { Module } from '@nestjs/common';
import { AuthV2Module } from '../auth/auth-v2.module';
import { DispatchV2Module } from '../dispatch/dispatch.module';
import { FinanceV2Module } from '../finance/finance.module';
import { TrackingV2Module } from '../tracking/tracking-v2.module';
import { AgenciesController } from './agencies.controller';
import { AgenciesService } from './agencies.service';
import { OrderChatModule } from '../orders/order-chat.module';

@Module({
  imports: [
    // قراءة محادثة الطلب للإشراف — قراءة فقط
    OrderChatModule,
    AuthV2Module,
    DispatchV2Module,
    FinanceV2Module,
    TrackingV2Module,
  ],
  controllers: [AgenciesController],
  providers: [AgenciesService],
})
export class AgenciesV2Module {}
