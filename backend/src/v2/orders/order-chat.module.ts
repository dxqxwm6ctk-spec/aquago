import { Module } from '@nestjs/common';
import { OrderChatService } from './order-chat.service';

/**
 * محادثة الطلب في وحدة مستقلة: يحتاجها `orders` (مسارات المحادثة) و
 * `dispatch` (رسالة السائق التلقائية عند القبول) معاً. إبقاؤها داخل
 * `OrdersV2Module` كان سيجعل dispatch يستورد orders، وorders يستورد
 * dispatch أصلاً — دورة وحدات. اعتماداتها كلها `@Global` فلا تستورد شيئاً.
 */
@Module({
  providers: [OrderChatService],
  exports: [OrderChatService],
})
export class OrderChatModule {}
