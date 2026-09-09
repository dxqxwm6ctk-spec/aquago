import { Injectable, Logger } from '@nestjs/common';

/**
 * طبقة إرسال واتساب قابلة للاستبدال عبر متغيرات البيئة — بنمط SmsService
 * (backend/src/auth/sms.service.ts) تماماً:
 *
 *  - WHATSAPP_PROVIDER=dev  (الافتراضي): لا إرسال حقيقي — يُسجَّل الرمز
 *    باللوغ فقط، للتطوير المحلي بلا حاجة لبوابة واتساب حقيقية.
 *  - WHATSAPP_PROVIDER=openwa: إرسال حقيقي عبر بوابة OpenWA ذاتية
 *    الاستضافة (rmyndharis/OpenWA)، جلسة Baileys متصلة فعلياً.
 *
 * الشكل مؤكَّد من /api/docs-json الحية على البوابة المنشورة، لا تخمين:
 *   POST {WHATSAPP_API_URL}/api/sessions/{WHATSAPP_SESSION_ID}/messages/send-text
 *   Header: X-API-Key: {WHATSAPP_API_KEY}
 *   Body:   { chatId: "<digits>@c.us", text: string }
 *
 * **جلسة واحدة للنظام كله.** الجلسة تعيش داخل البوابة لا داخل هذه العملية،
 * ويُشار إليها بـ`WHATSAPP_SESSION_ID`. لا تُنشأ جلسة لكل رسالة ولا لكل
 * حملة، ولا تُفتح جلسة ثانية بحال — رموز التحقق وحملات التواصل تمرّان من
 * هنا معاً على نفس الجلسة المصادَق عليها.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  get isRealProvider(): boolean {
    return (
      process.env.WHATSAPP_PROVIDER === 'openwa' &&
      !!process.env.WHATSAPP_API_URL &&
      !!process.env.WHATSAPP_SESSION_ID
    );
  }

  /** يحوّل +9627XXXXXXXX إلى chatId يفهمه OpenWA: أرقام فقط + @c.us */
  private toChatId(phone: string): string {
    return `${phone.replace(/^\+/, '')}@c.us`;
  }

  private get baseUrl(): string {
    return process.env.WHATSAPP_API_URL!.replace(/\/$/, '');
  }

  /**
   * إرسال رمز تحقق ونحوه — السلوك الأصلي بلا تغيير: يرمي عند الفشل ولا
   * يعني المنادي بمعرّف الرسالة.
   */
  async send(phone: string, message: string): Promise<void> {
    await this.sendText(phone, message);
  }

  /**
   * نفس الإرسال، لكنه يُرجع معرّف الرسالة لدى البوابة حين توفّره.
   *
   * حملات التواصل تحتاجه لتربط أحداث الحالة اللاحقة (SENT/DELIVERED/READ)
   * بالرسالة الصحيحة، ورموز التحقق لا تحتاجه — ولذلك هما نفس المسار ونفس
   * الجلسة، والفرق في ما يُقرأ من الرد فقط.
   *
   * قراءة المعرّف دفاعية: شكل رد البوابة قد يختلف بين نسخها، وغياب المعرّف
   * ليس فشلاً في الإرسال — تبقى الرسالة مرسَلة بلا تتبّع حالة، وهذا أفضل من
   * اعتبارها فاشلة وإعادة إرسالها إلى نفس الشخص.
   */
  async sendText(
    phone: string,
    message: string,
  ): Promise<{ externalMessageId: string | null }> {
    if (!this.isRealProvider) {
      this.logger.log(`[dev] WhatsApp إلى ${phone}: ${message}`);
      return { externalMessageId: null };
    }
    const sessionId = process.env.WHATSAPP_SESSION_ID!;
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/messages/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.WHATSAPP_API_KEY!,
        },
        body: JSON.stringify({
          chatId: this.toChatId(phone),
          text: message,
        }),
      },
    );
    if (!res.ok) {
      // فشل الإرسال لا يكشف تفاصيل البوابة للعميل — يُسجَّل فقط
      this.logger.error(`فشل إرسال WhatsApp إلى ${phone}: HTTP ${res.status}`);
      throw new Error('WHATSAPP_SEND_FAILED');
    }
    return { externalMessageId: await this.readMessageId(res) };
  }

  /** المفاتيح المحتملة لمعرّف الرسالة عبر نسخ البوابة — أول ما يوجد يُؤخذ */
  private async readMessageId(res: Response): Promise<string | null> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null; // رد بلا JSON — أُرسلت الرسالة ولا معرّف لها
    }
    const pick = (o: unknown, path: string[]): unknown =>
      path.reduce<unknown>(
        (acc, k) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[k]
            : undefined,
        o,
      );
    for (const path of [
      ['id'],
      ['messageId'],
      ['key', 'id'],
      ['data', 'id'],
      ['data', 'messageId'],
      ['data', 'key', 'id'],
    ]) {
      const v = pick(body, path);
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  /**
   * حالة اتصال الجلسة لدى البوابة.
   *
   * `unknown` قيمة أولى الاعتبار لا حالة خطأ: مسار فحص الحالة يختلف بين نسخ
   * البوابة، ونحن لا نخترع مساراً. من يستهلك هذه الدالة يعامل `unknown`
   * كـ«جرّب» لا كـ«توقف» — الإرسال نفسه هو الحكم عندها. أما `disconnected`
   * فمؤكَّدة، وعندها يؤجَّل العمل بدل قصف بوابة نائمة.
   *
   * المسار قابل للضبط بـWHATSAPP_STATUS_PATH حين تعرف مسار نسختك، ويقبل
   * `{sessionId}` كعنصر نائب.
   */
  async getConnectionStatus(): Promise<'connected' | 'disconnected' | 'unknown'> {
    if (!this.isRealProvider) return 'disconnected';
    const template =
      process.env.WHATSAPP_STATUS_PATH || '/api/sessions/{sessionId}';
    const path = template.replace(
      '{sessionId}',
      process.env.WHATSAPP_SESSION_ID!,
    );
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { 'X-API-Key': process.env.WHATSAPP_API_KEY! },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return 'unknown';
      const body = (await res.json()) as Record<string, unknown>;
      const raw = JSON.stringify(body).toLowerCase();
      // مفردات البوابات المعروفة — لا نطالب بشكل واحد بعينه
      if (/"(connected|ready|authenticated)"|"status":"open"/.test(raw)) {
        return 'connected';
      }
      if (/"(disconnected|unpaired|closed|logged_out)"/.test(raw)) {
        return 'disconnected';
      }
      return 'unknown';
    } catch {
      // البوابة لا تردّ أصلاً — هذه ليست «غير معروفة»، هذه مقطوعة
      return 'disconnected';
    }
  }
}
