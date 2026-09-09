import { Module } from '@nestjs/common';
import { AuthV2Module } from '../auth/auth-v2.module';
import { CouponsV2Module } from '../coupons/coupons.module';
import { DispatchV2Module } from '../dispatch/dispatch.module';
import { FinanceV2Module } from '../finance/finance.module';
import { OrdersV2Module } from '../orders/orders-v2.module';
import { SupportV2Module } from '../support/support.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { OrderChatModule } from '../orders/order-chat.module';

// SupportV2Module: رد الدعم من اللوحة يمر بنفس مسار الرد من تيليجرام
// (SupportService.appendSupportReply) فلا يتفرّع سلوك الرد حسب مصدره.
// DispatchV2Module: إنقاذ الطلبات العالقة يمر بمحرك التوزيع نفسه، فلا
// تُكتب قواعد الإسناد مرتين.
// OrdersV2Module: الإلغاء الإداري يمر بخدمة الطلبات نفسها — إشعار الزبون
// والوكالة والسائق وتحرير الكوبون في مكان واحد لا نسختين تتباعدان.
@Module({
  imports: [
    // قراءة محادثة الطلب للإشراف — قراءة فقط
    OrderChatModule,
    AuthV2Module,
    CouponsV2Module,
    DispatchV2Module,
    FinanceV2Module,
    OrdersV2Module,
    SupportV2Module,
  ],
  controllers: [PlatformController],
  providers: [PlatformService],
  // saveUploadedImage يخدم رفع شعار الفاتورة أيضاً — مخزن صور واحد للوحة كلها
  exports: [PlatformService],
})
export class PlatformV2Module {}
