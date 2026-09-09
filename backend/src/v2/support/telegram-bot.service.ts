import { Injectable, Logger } from '@nestjs/common';

/**
 * بوت الدعم ثنائي الاتجاه — منفصل عن TelegramService عمداً: ذاك تنبيهات
 * أحادية الاتجاه لقناة العمليات، وهذا محادثة بأزرار وحالة لكل تذكرة.
 *
 *  - TELEGRAM_PROVIDER=dev  (الافتراضي): لا إرسال حقيقي — تسجيل بالـ log فقط.
 *  - TELEGRAM_PROVIDER=real: إرسال فعلي عبر Bot API.
 *
 * الفشل بالإرسال لا يُسقط التذكرة نفسها — الشكوى محفوظة بالقاعدة ومرئية
 * بلوحة الدعم حتى لو تعذّر تيليجرام.
 */
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  /** عدّاد معرّفات صورية لوضع التطوير فقط */
  private _devMessageId = 1000;

  get isRealProvider(): boolean {
    return (
      process.env.TELEGRAM_PROVIDER === 'real' && !!process.env.TELEGRAM_BOT_TOKEN
    );
  }

  /** معرّفات محادثات الأدمنين — مفصولة بفواصل بمتغيّر البيئة */
  get adminChatIds(): string[] {
    return (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  isAdmin(chatId: string | number): boolean {
    return this.adminChatIds.includes(String(chatId));
  }

  private async call(method: string, body: unknown): Promise<any> {
    if (!this.isRealProvider) {
      this.logger.log(`[dev] Telegram ${method}: ${JSON.stringify(body)}`);
      // نُرجع معرّف رسالة صورياً كما يفعل تيليجرام: بدونه لا تُسجَّل مراسي
      // الرد محلياً فيبدو مسار «الرد على رسالة متابعة» سليماً بينما هو غير
      // مُختبَر إطلاقاً بوضع التطوير.
      return method === 'sendMessage' ? { message_id: ++this._devMessageId } : null;
    }
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!json.ok) {
        this.logger.error(`فشل ${method}: ${JSON.stringify(json)}`);
        return null;
      }
      return json.result;
    } catch (err) {
      this.logger.error(`فشل ${method}: ${(err as Error).message}`);
      return null;
    }
  }

  /** أزرار البطاقة حسب حالة التذكرة — المغلقة بلا أزرار */
  private keyboard(ticketId: string, status: string) {
    if (status === 'CLOSED' || status === 'RESOLVED') return undefined;
    return {
      inline_keyboard: [
        [
          { text: '✅ تم الرد', callback_data: `replied:${ticketId}` },
          { text: '🔒 إغلاق الشكوى', callback_data: `close:${ticketId}` },
        ],
      ],
    };
  }

  private statusLabel(status: string): string {
    return (
      {
        OPEN: '🟡 مفتوحة',
        IN_PROGRESS: '🔵 تم الرد',
        RESOLVED: '🟢 مُنجَزة',
        CLOSED: '🔴 مغلقة',
      }[status] ?? status
    );
  }

  ticketCard(t: {
    code: string;
    status: string;
    topicAr: string;
    authorName: string;
    authorPhone: string | null;
    bodyAr: string;
    orderCode?: string | null;
  }): string {
    return [
      `🎫 ${t.code} — ${this.statusLabel(t.status)}`,
      '',
      `👤 ${t.authorName}`,
      `📱 ${t.authorPhone ?? '—'}`,
      t.orderCode ? `📦 الطلب: ${t.orderCode}` : null,
      `🗂️ ${t.topicAr}`,
      '',
      '📝 المشكلة:',
      t.bodyAr,
      '',
      'للرد: اعمل Reply على هذه الرسالة واكتب ردّك.',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  /**
   * يرسل بطاقة التذكرة لكل أدمن، ويعيد خريطة chatId → messageId ليُحفظ في
   * التذكرة، فتُحدَّث البطاقة نفسها لاحقاً بدل إرسال رسائل متتابعة.
   */
  async sendTicketToAdmins(
    ticketId: string,
    text: string,
    status: string,
  ): Promise<Record<string, number>> {
    const sent: Record<string, number> = {};
    for (const chatId of this.adminChatIds) {
      const result = await this.call('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: this.keyboard(ticketId, status),
      });
      if (result?.message_id) sent[chatId] = result.message_id;
    }
    return sent;
  }

  /** يحدّث بطاقة التذكرة عند كل أدمن بعد تغيّر حالتها */
  async updateAdminCards(
    messageIds: Record<string, number>,
    ticketId: string,
    text: string,
    status: string,
  ): Promise<void> {
    for (const [chatId, messageId] of Object.entries(messageIds ?? {})) {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: this.keyboard(ticketId, status),
      });
    }
  }

  /**
   * يُرجع معرّف الرسالة المُرسلة (أو null بوضع dev / عند الفشل) — يحتاجه
   * المُستدعي ليسجّلها مرساةً للرد على التذكرة.
   *
   * [replyTo] يجعلها رداً على بطاقة التذكرة فتظهر مترابطة في المحادثة بدل
   * رسالة معلّقة لا يُعرف سياقها.
   */
  async sendToChat(
    chatId: string,
    text: string,
    replyTo?: number,
  ): Promise<number | null> {
    const result = await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    });
    return result?.message_id ?? null;
  }

  /** يطلب من المستخدم مشاركة رقمه — زر تيليجرام الجاهز لا إدخال يدوي */
  async askForPhone(chatId: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text:
        'أهلاً بك في دعم AquaGo 👋\n\n' +
        'لنتمكّن من متابعة شكواك وربطها بحسابك، شارك رقم هاتفك بالضغط على الزر أدناه.',
      reply_markup: {
        keyboard: [[{ text: '📱 مشاركة رقمي', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  /** يُنهي دوّامة الانتظار على زر inline (تيليجرام يتوقعه خلال ثوانٍ) */
  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}
