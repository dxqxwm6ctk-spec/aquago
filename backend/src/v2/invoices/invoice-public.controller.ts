import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Ip,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { InvoicesService } from './invoices.service';

/** تُغرق محاولات تخمين الرمز العام مهما طال أمدها، لا تمنع فتح رابط صحيح */
const IP_FLOOD_MAX = 30;
const IP_FLOOD_WINDOW_SECONDS = 15 * 60;

/**
 * فكّ الرابط العام الدائم لفاتورة طلب إلى جلسة عرض قصيرة الأجل.
 *
 * بلا حارس دخول عمداً: هذا هو المسار الذي يفتحه متصفح خارجي بلا أي جلسة
 * تطبيق. الرمز نفسه — عشوائي 256-بت، بصمته فقط مخزَّنة — هو الإذن. لا نضع
 * أي هوية في الرابط الناتج بعد التحقق: نوقّع جلسة قصيرة (نفس آلية
 * signViewToken/verifyViewToken المستخدمة للرابط المؤقت القديم) ونحملها في
 * كوكي HttpOnly، ثم نُحوِّل لعنوان نظيف بلا سرّ ظاهر — راجع
 * InvoiceViewController.viewFromSession.
 */
@Controller('v2/invoices/public')
export class InvoicePublicController {
  constructor(
    private invoices: InvoicesService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  @Get(':token')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  async redeem(
    @Param('token') token: string,
    @Ip() ip: string,
    @Res() res: Response,
  ) {
    await this.assertIpNotFlooded(ip);
    const { orderId, customerId } =
      await this.invoices.redeemInvoicePublicLink(token);
    const sessionJwt = this.invoices.signViewToken(
      'order',
      orderId,
      customerId,
    );
    res.cookie('invoice_session', sessionJwt, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/api/v2/invoices',
    });
    res.redirect('/api/v2/invoices/view');
  }

  /**
   * نفس نمط assertIpNotFlooded في auth-v2.service.ts: عدّاد Redis بمفتاح
   * scope+ip، وفشل Redis لا يمنع الطلب (fail-open) — الحدّ حماية إضافية
   * لا خط الدفاع الوحيد (ذاك هو 256 بت من العشوائية).
   */
  private async assertIpNotFlooded(ip: string | undefined) {
    if (!ip) return;
    try {
      const key = `ipflood:invoice-public:${ip}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, IP_FLOOD_WINDOW_SECONDS);
      // نفس رسالة أي رمز غير صالح — لا يميّز مهاجم بين «رمز خاطئ» و«محاولات كثيرة»
      if (n > IP_FLOOD_MAX) throw new ForbiddenException('رابط غير صالح');
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      // فشل Redis لا يمنع الطلب (fail-open) — الحدّ حماية إضافية لا خط الدفاع الوحيد
    }
  }
}
