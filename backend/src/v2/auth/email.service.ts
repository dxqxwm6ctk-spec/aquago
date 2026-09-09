import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * إرسال البريد — بنفس نمط WhatsappService: قابل للاستبدال بمتغيّرات البيئة،
 * ويصمت إلى اللوغ في التطوير بدل أن يفشل.
 *
 *  - SMTP_HOST غائب (الافتراضي): لا إرسال حقيقي — الرسالة في اللوغ فقط.
 *  - SMTP_HOST موجود: إرسال فعلي عبر SMTP.
 *
 * المتغيّرات: SMTP_HOST، SMTP_PORT (587)، SMTP_USER، SMTP_PASS،
 * SMTP_FROM (العنوان الظاهر للمستلم)، SMTP_SECURE=1 لمنفذ 465.
 *
 * الناقل يُبنى مرة واحدة ويُعاد استعماله: بناؤه لكل رسالة يفتح اتصال TLS
 * جديداً في كل مرة، وهو أبطأ من الإرسال نفسه.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  get isRealProvider(): boolean {
    return !!process.env.SMTP_HOST;
  }

  private get from(): string {
    return process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@aquago.app';
  }

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    return this.transporter;
  }

  /**
   * يرمي عند الفشل — المنادي يقرّر السقوط إلى قناة أخرى. ابتلاع الفشل هنا
   * كان سيعني أن المستخدم ينتظر رمزاً لن يصل أبداً بلا أن يعرف أحد.
   */
  async sendOtp(to: string, code: string, ttlMinutes: number): Promise<void> {
    const subject = `رمز التحقق من AquaGo: ${code}`;
    const text =
      `رمز التحقق من AquaGo: ${code}\n` +
      `صالح لمدة ${ttlMinutes} دقائق. لا تشارك الرمز مع أي شخص.`;

    if (!this.isRealProvider) {
      this.logger.log(`[dev] Email إلى ${to}: ${text}`);
      return;
    }

    await this.getTransporter().sendMail({
      from: this.from,
      to,
      subject,
      text,
      // نسخة HTML بسيطة: الرمز كبيراً ومنفصلاً ليُنسخ بنظرة، وباتجاه RTL
      html:
        `<div dir="rtl" style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px">` +
        `<p>رمز التحقق من AquaGo:</p>` +
        `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>` +
        `<p style="color:#666">صالح لمدة ${ttlMinutes} دقائق. لا تشارك الرمز مع أي شخص.</p>` +
        `</div>`,
    });
  }
}
