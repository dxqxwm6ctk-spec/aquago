import {
  Body,
  Controller,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { SupportService } from './support.service';
import { TelegramBotService } from './telegram-bot.service';

/**
 * مستقبِل تحديثات بوت الدعم — **المسار الوحيد غير المحمي بـJwtV2Guard**
 * في v2، لأن تيليجرام هو من يستدعيه ولا يملك توكن مستخدم.
 *
 * الحماية بديلاً عن التوكن:
 *  1. السرّ في المسار نفسه (نمط تيليجرام الموصى به): من لا يعرفه يحصل على
 *     404 كأن المسار غير موجود، فلا يكشف وجوده أصلاً.
 *  2. كل إجراء إداري (رد/إغلاق) يُفحص ضد TELEGRAM_ADMIN_CHAT_IDS، فحتى لو
 *     تسرّب المسار لا يستطيع غريب تغيير حالة تذكرة.
 *
 * نُعيد 200 دائماً بعد اجتياز الفحص: تيليجرام يعيد المحاولة على أي خطأ،
 * فخطأ منطقي واحد كان سيتحوّل إلى تكرار لا ينتهي لنفس التحديث.
 */
@Controller('v2/support/telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private support: SupportService,
    private bot: TelegramBotService,
  ) {}

  @Post(':secret')
  async receive(@Param('secret') secret: string, @Body() update: any) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    // بلا سرّ معرَّف لا يعمل المسار إطلاقاً — لا نترك بوابة مفتوحة بالغلط
    if (!expected || secret !== expected) {
      throw new NotFoundException();
    }

    try {
      if (update?.callback_query) {
        await this.onCallback(update.callback_query);
      } else if (update?.message) {
        await this.onMessage(update.message);
      }
    } catch (err) {
      this.logger.error(`فشل معالجة تحديث تيليجرام: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  /** اسم يُعرض في سجل التذكرة — الأدمنون بلا حسابات منصة */
  private adminLabel(from: any): string {
    return (
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
      from?.username ||
      String(from?.id ?? 'أدمن')
    );
  }

  private async onMessage(message: any) {
    const chatId = String(message.chat?.id ?? '');
    if (!chatId) return;

    // ردّ أدمن على بطاقة تذكرة → رسالة للزبون
    if (this.bot.isAdmin(chatId) && message.reply_to_message?.message_id) {
      const ticketId = await this.support.ticketByAdminMessage(
        chatId,
        message.reply_to_message.message_id,
      );
      if (ticketId && message.text) {
        const res = await this.support.replyFromAdmin(
          ticketId,
          this.adminLabel(message.from),
          message.text.trim(),
        );
        await this.bot.sendToChat(chatId, `✅ أُرسل ردّك على ${res.code}`);
      }
      return;
    }

    // مشاركة رقم الهاتف → ربط المحادثة بالحساب
    if (message.contact?.phone_number) {
      const res = await this.support.linkTelegramByPhone(
        chatId,
        message.contact.phone_number,
      );
      if (res.linked) {
        await this.bot.sendToChat(
          chatId,
          `تم التحقق ✅ أهلاً ${res.name}.\n\nاكتب مشكلتك الآن وسنفتح لك شكوى ونتابعها معك.`,
        );
      } else {
        await this.bot.sendToChat(
          chatId,
          res.reason === 'NO_ACCOUNT'
            ? 'لم نجد حساباً بهذا الرقم. سجّل الدخول بالتطبيق أولاً ثم عد إلينا.'
            : 'الرقم غير صالح — شاركه من زر «مشاركة رقمي».',
        );
      }
      return;
    }

    const text: string = (message.text ?? '').trim();
    if (!text) return;

    const user = await this.support.userByChatId(chatId);
    // غير مرتبط (أو أرسل /start) → نطلب الرقم قبل أي شيء
    if (!user || text === '/start') {
      await this.bot.askForPhone(chatId);
      return;
    }

    // من البوت: بطاقة كاملة للأدمن يردّ عليها بـ Reply كأي بوت تواصل
    const res = await this.support.handleUserMessage(user.id, text, 'TELEGRAM');
    if (!res.ok) {
      await this.bot.sendToChat(
        chatId,
        'اكتب وصفاً أوضح للمشكلة (10 أحرف على الأقل) حتى يتمكّن الدعم من مساعدتك.',
      );
      return;
    }
    await this.bot.sendToChat(
      chatId,
      res.isNew
        ? `🎫 فُتحت شكواك برقم ${res.code}.\n\nسيتواصل معك الدعم قريباً، ويمكنك إرسال تفاصيل إضافية هنا.`
        : `أُضيفت رسالتك إلى شكواك ${res.code}.`,
    );
  }

  private async onCallback(cb: any) {
    const chatId = String(cb.message?.chat?.id ?? '');
    if (!this.bot.isAdmin(chatId)) {
      await this.bot.answerCallback(cb.id, 'غير مصرَّح لك');
      return;
    }

    const [action, ticketId] = String(cb.data ?? '').split(':');
    if (!ticketId) {
      await this.bot.answerCallback(cb.id, 'طلب غير مفهوم');
      return;
    }

    const status =
      action === 'replied'
        ? ('IN_PROGRESS' as const)
        : action === 'close'
          ? ('CLOSED' as const)
          : null;
    if (!status) {
      await this.bot.answerCallback(cb.id, 'إجراء غير معروف');
      return;
    }

    // نُجيب على الـcallback **قبل** تنفيذ الإجراء: تيليجرام يُبقي دوّامة
    // التحميل على الزر حتى تصله الإجابة، والإجراء نفسه يشمل كتابةً في
    // القاعدة وإشعار FCM ورسالةً للزبون وتحديثَ بطاقة كل أدمن — ثوانٍ عدة
    // على الإنتاج. والأسوأ: لو أخفق أيٌّ منها لم تُرسَل الإجابة أصلاً، فيبقى
    // الزر يدور بلا نهاية وكأنه لا يعمل.
    await this.bot.answerCallback(
      cb.id,
      status === 'CLOSED' ? 'جارٍ إغلاق الشكوى…' : 'جارٍ التحديث…',
    );

    const label = this.adminLabel(cb.from);
    try {
      await this.support.setStatusFromTelegram(ticketId, status, label);
    } catch (err) {
      this.logger.error(`فشل تنفيذ ${action}: ${(err as Error).message}`);
      // الزر توقّف عن الدوران، لكن الإجراء لم يتم — نقولها صراحةً بدل صمتٍ
      // يوحي بالنجاح.
      await this.bot.sendToChat(chatId, '⚠️ تعذّر تنفيذ الإجراء على التذكرة.');
    }
  }
}
