import { Injectable } from '@nestjs/common';
import { WhatsappService } from '../auth/whatsapp.service';

/**
 * الواجهة التي تراها وحدة التواصل عن واتساب.
 *
 * وجودها ليس تمهيداً لاستبدال OpenWA — بل ليبقى منطق الحملات (الأهلية،
 * التوقيت، العدّادات، الأحداث) مستقلاً عن تفاصيل بوابة بعينها، ولتكون
 * الحملات قابلة للاختبار بلا بوابة حقيقية.
 */
/**
 * قالب معتمد مسبقاً. Meta تشترطه لأي رسالة أولى إلى من لم يراسلك، وOpenWA
 * لا تعرف القوالب فتتجاهله وترسل النصّ المُهيّأ.
 */
export interface OutboundTemplate {
  name: string;
  language?: string;
  /** بالترتيب — يقابل {{1}} و{{2}} في القالب المعتمد */
  params?: string[];
}

export interface IWhatsAppProvider {
  /** رسالة نصية إلى رقم واحد. يرمي عند فشل الإرسال. */
  sendTextMessage(
    phone: string,
    body: string,
  ): Promise<{ externalMessageId: string | null }>;

  /**
   * الرسالة الصادرة للحملة. `template` يُمرَّر حين تشترطه القناة (Meta لكل
   * رسالة باردة)، ويُتجاهَل حين لا تعرفه (OpenWA) فيُرسَل النصّ المُهيّأ.
   */
  sendTemplateOrSupportedMessage(
    phone: string,
    renderedBody: string,
    template?: OutboundTemplate,
  ): Promise<{ externalMessageId: string | null }>;

  getConnectionStatus(): Promise<'connected' | 'disconnected' | 'unknown'>;

  /**
   * هل المزوّد مضبوط للإرسال الحقيقي؟
   *
   * في وضع `dev` تكتب الخدمة الرسالة في السجل وتُرجع نجاحاً — وهو تصرّف
   * صحيح لرمز تحقق أثناء التطوير، وكارثيّ لحملة: تُسجَّل مئة رسالة
   * «أُرسلت» ولا تخرج واحدة. من يطلق حملة يحتاج معرفة الفرق قبل الإطلاق.
   */
  isConfigured(): boolean;

  /** هل يجوز بدء معالجة مهام الآن؟ `unknown` تُعامَل كنعم — انظر التوثيق */
  isReady(): Promise<boolean>;
}

export const WHATSAPP_PROVIDER = 'WHATSAPP_PROVIDER';

/**
 * التنفيذ الوحيد: يلفّ [WhatsappService] القائمة كما هي.
 *
 * **لا مكتبة واتساب جديدة، ولا جلسة ثانية، ولا مصادقة ثانية.** نفس البوابة
 * ونفس `WHATSAPP_SESSION_ID` اللذان يرسلان رموز التحقق منذ اليوم الأول —
 * كل ما يضيفه هذا الصف هو قراءة معرّف الرسالة وفحص الاتصال قبل الإرسال
 * الجماعي.
 */
@Injectable()
export class OpenWaProvider implements IWhatsAppProvider {
  constructor(private whatsapp: WhatsappService) {}

  sendTextMessage(phone: string, body: string) {
    return this.whatsapp.sendText(phone, body);
  }

  /** القالب لا معنى له هنا: البوابة ترسل نصّاً حرّاً ولا تعرف قوالب Meta */
  sendTemplateOrSupportedMessage(phone: string, renderedBody: string) {
    return this.whatsapp.sendText(phone, renderedBody);
  }

  getConnectionStatus() {
    return this.whatsapp.getConnectionStatus();
  }

  isConfigured(): boolean {
    return this.whatsapp.isRealProvider;
  }

  /**
   * `unknown` تمرّ: مسار فحص الحالة يختلف بين نسخ البوابة، وإيقاف كل
   * الحملات لأننا لم نتعرّف على شكل ردٍّ أسوأ من محاولة إرسال تفشل وتُعاد
   * بتراجع أُسّي. أما `disconnected` — بوابة لا تردّ أو جلسة مفصولة —
   * فتوقف المعالجة.
   */
  async isReady(): Promise<boolean> {
    return (await this.getConnectionStatus()) !== 'disconnected';
  }
}
