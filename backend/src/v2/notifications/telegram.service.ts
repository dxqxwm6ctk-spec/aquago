import { Injectable, Logger } from '@nestjs/common';

/**
 * تنبيهات تشغيلية فورية لفريق العمليات عبر بوت تيليجرام — بنفس نمط
 * SmsService/FcmService (provider toggle بمتغيرات بيئة):
 *
 *  - TELEGRAM_PROVIDER=dev  (الافتراضي): لا إرسال حقيقي — تسجيل بالـ log فقط.
 *  - TELEGRAM_PROVIDER=real: إرسال حقيقي عبر Bot API لقناة واحدة — الفئة
 *    (مالية/طلبات/أعطال) مكتوبة داخل نص الرسالة نفسه، لا موضوع منفصل.
 *
 * الفشل بالإرسال لا يُسقط أي شيء آخر — كل شيء هنا يبتلع أخطاءه بنفسه.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  get isRealProvider(): boolean {
    return (
      process.env.TELEGRAM_PROVIDER === 'real' &&
      !!process.env.TELEGRAM_BOT_TOKEN &&
      !!process.env.TELEGRAM_CHAT_ID
    );
  }

  async send(text: string): Promise<void> {
    try {
      if (!this.isRealProvider) {
        this.logger.log(`[dev] Telegram: ${text.replace(/\n/g, ' | ')}`);
        return;
      }
      const res = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text,
          }),
        },
      );
      if (!res.ok) {
        this.logger.error(`فشل إرسال تنبيه Telegram: HTTP ${res.status}`);
      }
    } catch (err) {
      this.logger.error(`فشل إرسال تنبيه Telegram: ${(err as Error).message}`);
    }
  }
}
