import {
  Controller,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WhatsAppEventsService } from './whatsapp-events.service';

/**
 * مستقبِل أحداث WhatsApp Cloud API.
 *
 * **هذا ما كان ناقصاً منذ البداية.** بوابة OpenWA لا ترسل إلينا شيئاً، فبقيت
 * كل رسالة عند «أُرسلت» ولم يصل ردّ واحد — ومعنى ذلك أن «إلغاء» لم تكن تدخل
 * قائمة المنع تلقائياً رغم كل ما بُني حولها. Meta ترسل الحالات والردود
 * رسمياً، فتكتمل الحلقة.
 *
 * مسار مستقل عن `v2/whatsapp/events/:secret` (نمط OpenWA): شكل الحمولة
 * مختلف، والتحقق هنا بتوقيع لا بسرّ في المسار.
 */
@Controller('v2/whatsapp/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(private events: WhatsAppEventsService) {}

  /**
   * تحقّق الاشتراك: تناديه Meta مرة واحدة عند حفظ الرابط، وتتوقع إعادة
   * `hub.challenge` نصّاً خاماً. أي جواب آخر يُفشل الاشتراك.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!expected || mode !== 'subscribe' || token !== expected) {
      // 404 لا 403: لا نؤكّد لمن يجرّب أن هنا مستقبِلاً أصلاً
      throw new NotFoundException();
    }
    return challenge;
  }

  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
  ) {
    if (!this.isAuthentic(req.rawBody, signature)) {
      this.logger.warn('حمولة Meta بتوقيع غير صالح — أُهملت');
      throw new NotFoundException();
    }

    try {
      const body = req.body as MetaWebhookBody;
      for (const entry of body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};

          // حالات التسليم: sent → delivered → read، أو failed مع سببها
          for (const st of value.statuses ?? []) {
            await this.events.handleStatusEvent({
              externalMessageId: st.id,
              status: st.status,
              // Meta ترسل ثوانٍ منذ الحقبة نصّاً — والمعالج ينتظر تاريخاً
              timestamp: st.timestamp
                ? new Date(Number(st.timestamp) * 1000).toISOString()
                : undefined,
              errorCode: st.errors?.[0]?.code ? String(st.errors[0].code) : undefined,
              errorMessage: st.errors?.[0]?.title ?? st.errors?.[0]?.message,
            });
          }

          // الرسائل الواردة — منها تُقرأ كلمة الانسحاب
          for (const msg of value.messages ?? []) {
            await this.events.handleInboundMessage({
              from: msg.from,
              // زرّ أو ردّ سريع: النصّ في مكان آخر، وتجاهله يعني ضياع
              // «إلغاء» حين تأتي كزرّ بدل كتابة
              body:
                msg.text?.body ??
                msg.button?.text ??
                msg.interactive?.button_reply?.title ??
                msg.interactive?.list_reply?.title,
              externalMessageId: msg.id,
              timestamp: msg.timestamp
                ? new Date(Number(msg.timestamp) * 1000).toISOString()
                : undefined,
            });
          }
        }
      }
    } catch (err) {
      // 200 دائماً بعد التحقق: Meta تعيد المحاولة على أي خطأ، فخطأٌ منطقي
      // واحد كان سيتحوّل إلى تكرار لا ينتهي لنفس الحدث
      this.logger.error(`فشل معالجة حدث Meta: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  /**
   * توقيع `X-Hub-Signature-256` محسوب على **البايتات الخام** بالمفتاح السرّي
   * للتطبيق. لهذا فُعِّل `rawBody` في main.ts: إعادة ترتيب مفاتيح JSON عند
   * التحليل تكسر التوقيع.
   *
   * بلا `META_APP_SECRET` لا يعمل المسار إطلاقاً — مستقبِلٌ عام بلا تحقق
   * يعني أن أي أحد يستطيع تلفيق «قُرئت» و«انسحب» على أرقام حقيقية.
   */
  private isAuthentic(raw: Buffer | undefined, signature: string | undefined): boolean {
    const secret = process.env.META_APP_SECRET;
    if (!secret || !raw || !signature?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const given = signature.slice('sha256='.length);
    if (given.length !== expected.length) return false;
    // مقارنة ثابتة الزمن — المقارنة العادية تسرّب التوقيع الصحيح بالقياس
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  }
}

interface MetaWebhookBody {
  entry?: {
    changes?: {
      value?: {
        statuses?: {
          id: string;
          status: string;
          timestamp?: string;
          errors?: { code?: number; title?: string; message?: string }[];
        }[];
        messages?: {
          id: string;
          from: string;
          timestamp?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          };
        }[];
      };
    }[];
  }[];
}
