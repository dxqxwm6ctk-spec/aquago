import { Module } from '@nestjs/common';
import { CouponsV2Module } from '../coupons/coupons.module';
import { OrderChatModule } from '../orders/order-chat.module';
import { DispatchQueue } from './dispatch.queue';
import { DispatchService } from './dispatch.service';
import { DispatchWorker } from './dispatch.worker';

/**
 * محرك التوزيع — خدمة مستقلة بلا Controllers عمداً:
 * يُختبر داخلياً عبر dispatch-sim قبل ربطه بالـ API والـ WebSocket (المرحلة 4).
 */
@Module({
  imports: [CouponsV2Module, OrderChatModule],
  providers: [DispatchQueue, DispatchWorker, DispatchService],
  // `DispatchQueue` مُصدَّرة أيضاً: متحكّم الطلبات يُدرج مهمة التوزيع بدل
  // انتظار دورة كاملة في مسار HTTP (انظر التعليق عند enqueueDispatch).
  exports: [DispatchService, DispatchQueue],
})
export class DispatchV2Module {}
