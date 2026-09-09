import { Module } from '@nestjs/common';
import { ReviewAccountController } from './review-account.controller';
import { ReviewAccountService } from './review-account.service';

/**
 * تُصدَّر الخدمة لأن مسار الدخول (AuthV2) يستهلكها قبل رمز الواتساب —
 * الوحدة ليست لوحة إدارة فقط.
 */
@Module({
  controllers: [ReviewAccountController],
  providers: [ReviewAccountService],
  exports: [ReviewAccountService],
})
export class ReviewAccountV2Module {}
