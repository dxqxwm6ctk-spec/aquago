import { Injectable, Logger } from '@nestjs/common';
import { MetaCloudProvider } from '../outreach/meta-cloud.provider';

/**
 * رمز التحقق عبر واتساب Meta الرسمي.
 *
 * **لا يتصل بـMeta بنفسه** — يفوّض إلى `MetaCloudProvider` الموجود أصلاً
 * لحملات التواصل. إعداد Meta واحد للنظام كله
 * (META_ACCESS_TOKEN، META_PHONE_NUMBER_ID)، لا إعدادان بأسماء مختلفة
 * يفترقان فيعمل أحدهما ويصمت الآخر بلا سبب ظاهر لمن يقرأ الإعدادات.
 *
 * **ولماذا قالب لا نصّ حرّ**: Meta لا تسمح برسالة مبتدأة من العمل إلا داخل
 * نافذة أربع وعشرين ساعة من آخر رسالة أرسلها المستخدم — ورمز التحقق يُطلب
 * ممن لم يراسلنا قط. فالقالب المعتمد هو الطريق الوحيد، والرمز يُمرَّر
 * متغيّراً في جسمه.
 *
 * اسم القالب في `META_OTP_TEMPLATE` (افتراضياً `otp_code`) ولغته في
 * `META_OTP_LANG` — ليُبدَّلا من الإعدادات بلا نشر جديد.
 */
@Injectable()
export class MetaWhatsappService {
  private readonly logger = new Logger(MetaWhatsappService.name);

  constructor(private meta: MetaCloudProvider) {}

  get isRealProvider(): boolean {
    return this.meta.isConfigured();
  }

  /** يرمي عند الفشل — المنادي يقرّر السقوط إلى قناة أخرى */
  async sendOtp(phone: string, code: string): Promise<void> {
    if (!this.isRealProvider) {
      this.logger.log(`[dev] Meta WhatsApp إلى ${phone}: رمز التحقق ${code}`);
      return;
    }
    await this.meta.sendTemplateOrSupportedMessage(phone, code, {
      name: process.env.META_OTP_TEMPLATE || 'otp_code',
      language: process.env.META_OTP_LANG || 'ar',
      params: [code],
    });
  }
}
