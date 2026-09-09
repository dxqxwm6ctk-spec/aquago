import { Module } from '@nestjs/common';
import { AuthV2Controller } from './auth-v2.controller';
import { AuthV2Service } from './auth-v2.service';
import { JwtV2Guard } from './jwt-v2.guard';
import { WhatsappService } from './whatsapp.service';
import { MetaWhatsappService } from './meta-whatsapp.service';
import { EmailService } from './email.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { ReviewAccountV2Module } from '../review-account/review-account.module';
import { MetaCloudModule } from '../outreach/meta-cloud.module';

@Module({
  // حساب مراجعة المتجر يُفحص داخل مسار الدخول قبل رمز الواتساب
  // MetaCloudModule: مزوّد Meta مشترك بين الحملات ورموز التحقق. وحدة
  // صغيرة مستقلة لا OutreachV2Module كاملة — تلك تستورد هذه الوحدة
  // فتُغلق الحلقة ويرفض Nest الإقلاع.
  imports: [ReviewAccountV2Module, MetaCloudModule],
  controllers: [AuthV2Controller],
  providers: [
    AuthV2Service,
    JwtV2Guard,
    WhatsappService,
    MetaWhatsappService,
    EmailService,
    OtpDeliveryService,
  ],
  // WhatsappService مُصدَّرة لتستعملها وحدة التواصل نفسَها — بوابة واحدة
  // وجلسة واحدة للنظام كله، لا مثيل ثانٍ ولا مصادقة ثانية.
  exports: [AuthV2Service, JwtV2Guard, WhatsappService, OtpDeliveryService],
})
export class AuthV2Module {}
