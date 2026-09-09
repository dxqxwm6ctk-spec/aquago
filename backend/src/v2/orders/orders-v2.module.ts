import { Module } from '@nestjs/common';
import { CouponsV2Module } from '../coupons/coupons.module';
import { DispatchV2Module } from '../dispatch/dispatch.module';
import { DriverV2Controller } from '../dispatch/driver-v2.controller';
import { FinanceV2Module } from '../finance/finance.module';
import { OrderChatModule } from './order-chat.module';
import { OrdersV2Controller } from './orders-v2.controller';
import { OrdersV2Service } from './orders-v2.service';

// كلا الـ Controllers هنا: الاتجاه أحادي (orders → dispatch/finance) بلا دور
@Module({
  imports: [DispatchV2Module, FinanceV2Module, CouponsV2Module, OrderChatModule],
  controllers: [OrdersV2Controller, DriverV2Controller],
  providers: [OrdersV2Service],
  exports: [OrdersV2Service],
})
export class OrdersV2Module {}
