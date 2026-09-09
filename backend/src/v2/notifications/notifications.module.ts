import { Global, Module } from '@nestjs/common';
import { DeviceTokensController } from './device-tokens.controller';
import { FcmService } from './fcm.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { TelegramService } from './telegram.service';

/**
 * Global حتى تستطيع كل الوحدات المُنشئة للإشعارات (التوزيع، المالية) أن
 * تمرّ عبر الخدمة التي تحترم تفضيلات المستخدم، بدل الكتابة في الجدول مباشرة.
 */
@Global()
@Module({
  controllers: [NotificationsController, DeviceTokensController],
  providers: [NotificationsService, FcmService, TelegramService],
  exports: [NotificationsService, TelegramService],
})
export class NotificationsV2Module {}
