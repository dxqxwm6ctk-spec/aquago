import { Injectable, Logger } from '@nestjs/common';
import type { IWhatsAppProvider, OutboundTemplate } from './whatsapp-provider';

/**
 * WhatsApp Cloud API الرسمية من Meta.
 *
 * **لماذا أُضيفت بجانب OpenWA لا بدلاً منها.** OpenWA جلسة على رقم واتساب
 * عادي: ممتازة للردّ داخل محادثة قائمة ولرموز التحقق، ويحظرها واتساب عن بدء
 * محادثات جديدة مع غرباء — وهو بالضبط ما تحتاجه حملة تواصل. Cloud API هي
 * الطريق المسموح لذلك، بشرطها: **الرسالة الأولى لمن لم يراسلك قالبٌ معتمد
 * مسبقاً، لا نصّ حرّ.**
 *
 * النصّ الحرّ مسموح داخل نافذة الأربع والعشرين ساعة بعد آخر رسالة أرسلها
 * المستخدم إليك. فالمزوّد يقبل الاثنين: قالباً حين يُمرَّر، ونصّاً حين لا
 * يُمرَّر — ومسؤولية اختيار الصحيح على من ينادي.
 */
@Injectable()
export class MetaCloudProvider implements IWhatsAppProvider {
  private readonly logger = new Logger(MetaCloudProvider.name);

  private get version(): string {
    return process.env.META_API_VERSION || 'v23.0';
  }

  isConfigured(): boolean {
    return (
      !!process.env.META_ACCESS_TOKEN &&
      !!process.env.META_PHONE_NUMBER_ID
    );
  }

  /**
   * صيغة `to` عند Meta: أرقام فقط بلا `+`. أرقامنا مخزَّنة `+9627…`
   * فتُجرَّد هنا في مكان واحد بدل أن يتذكّرها كل منادٍ.
   */
  private toRecipient(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private async post(body: Record<string, unknown>): Promise<{ externalMessageId: string | null }> {
    const url = `https://graph.facebook.com/${this.version}/${process.env.META_PHONE_NUMBER_ID}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });

    const payload = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
    };

    if (!res.ok) {
      // رسالة Meta مفيدة فعلاً (قالب غير معتمد، رقم خارج قائمة الاختبار،
      // تجاوز السقف) — تُمرَّر كما هي لأن تعميمها يضيّع التشخيص
      const e = payload.error;
      const detail = e?.error_data?.details || e?.message || `HTTP ${res.status}`;
      this.logger.error(`فشل إرسال Meta: ${detail} (code ${e?.code ?? '?'})`);
      throw new Error(detail);
    }
    return { externalMessageId: payload.messages?.[0]?.id ?? null };
  }

  /** نصّ حرّ — صالح فقط داخل نافذة الأربع والعشرين ساعة */
  async sendTextMessage(phone: string, body: string) {
    if (!this.isConfigured()) {
      this.logger.log(`[dev] Meta إلى ${phone}: ${body}`);
      return { externalMessageId: null };
    }
    return this.post({
      to: this.toRecipient(phone),
      type: 'text',
      text: { body, preview_url: false },
    });
  }

  /**
   * قالب حين يُمرَّر، وإلا نصّ حرّ.
   *
   * متغيّرات القالب مرقّمة بالترتيب عند Meta (`{{1}}`, `{{2}}`) لا مسمّاة،
   * فترتيب `params` هو العقد — وتغييره بعد اعتماد القالب يقلب الأسماء
   * والمناطق في رسائل تصل إلى ناس.
   */
  async sendTemplateOrSupportedMessage(
    phone: string,
    renderedBody: string,
    template?: OutboundTemplate,
  ) {
    if (!template?.name) return this.sendTextMessage(phone, renderedBody);
    if (!this.isConfigured()) {
      this.logger.log(`[dev] Meta قالب ${template.name} إلى ${phone}`);
      return { externalMessageId: null };
    }

    const params = (template.params ?? []).map((text) => ({ type: 'text', text }));
    return this.post({
      to: this.toRecipient(phone),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language || 'ar' },
        // مكوّن الجسم يُحذف كلياً حين لا متغيّرات: إرساله فارغاً يرفضه Meta
        ...(params.length ? { components: [{ type: 'body', parameters: params }] } : {}),
      },
    });
  }

  /**
   * Cloud API خدمة مُدارة لا جلسة تُقطع — «الاتصال» هنا يعني أن بيانات
   * الاعتماد مقبولة، فنسأل عن الرقم نفسه. الفشل بالمصادقة يعني رمزاً منتهياً
   * أو صلاحيات ناقصة، وهو ما يهمّ من يفتح الشاشة.
   */
  async getConnectionStatus(): Promise<'connected' | 'disconnected' | 'unknown'> {
    if (!this.isConfigured()) return 'disconnected';
    try {
      const res = await fetch(
        `https://graph.facebook.com/${this.version}/${process.env.META_PHONE_NUMBER_ID}` +
          `?fields=verified_name,quality_rating,code_verification_status`,
        {
          headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(6000),
        },
      );
      return res.ok ? 'connected' : 'disconnected';
    } catch {
      return 'unknown';
    }
  }

  async isReady(): Promise<boolean> {
    return (await this.getConnectionStatus()) !== 'disconnected';
  }

  /** بيانات الرقم كما تراها Meta — تُعرض في شاشة البوابة */
  async phoneInfo(): Promise<Record<string, unknown> | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(
        `https://graph.facebook.com/${this.version}/${process.env.META_PHONE_NUMBER_ID}` +
          `?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
        {
          headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
          signal: AbortSignal.timeout(6000),
        },
      );
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
