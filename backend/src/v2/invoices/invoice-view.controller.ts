import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { InvoicesService } from './invoices.service';

/**
 * أمان الصفحات هنا: لا تُخزَّن في أي وسيط (متصفح/CDN/proxy) — المستند
 * شخصي حتى لو وصل الرابط بلا سرّ ظاهر.
 */
const SENSITIVE_PAGE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

/**
 * فتح الفاتورة في متصفح الجهاز — مسارين: رمز قصير الأجل بالرابط نفسه
 * (القديم، :token) أو كوكي جلسة قصيرة الأجل صادرة عن الرابط الدائم
 * (الجديد، بلا معامل — راجع InvoicePublicController). كلاهما بلا حارس
 * دخول عمداً: المتصفح لا يحمل ترويسة Authorization، والرمز/الكوكي نفسه هو
 * الإذن — موقّع، ينتهي خلال دقائق، ومقيّد بفاتورة واحدة. ومع ذلك تُعاد
 * الملكية فحصاً من هوية صاحب الادّعاء، فادّعاء صحيح لا يفتح مستند غيره.
 */
@Controller('v2/invoices/view')
export class InvoiceViewController {
  constructor(private invoices: InvoicesService) {}

  /** المسار الجديد: كوكي invoice_session بدل رمز في الرابط — راجع خطة الرابط الدائم */
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', SENSITIVE_PAGE_HEADERS['Cache-Control'])
  @Header('Pragma', SENSITIVE_PAGE_HEADERS.Pragma)
  @Header('Referrer-Policy', SENSITIVE_PAGE_HEADERS['Referrer-Policy'])
  @Header('X-Content-Type-Options', SENSITIVE_PAGE_HEADERS['X-Content-Type-Options'])
  async viewFromSession(@Req() req: Request) {
    const claim = this.invoices.verifyViewToken(
      (req.cookies as Record<string, string> | undefined)?.invoice_session ?? '',
    );
    return this.invoices.renderOrderInvoiceForClaim(claim);
  }

  /** المسار القديم — يبقى للروابط المؤقتة المُشارَكة قبل هذا التحديث */
  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', SENSITIVE_PAGE_HEADERS['Cache-Control'])
  async view(@Param('token') token: string) {
    const claim = this.invoices.verifyViewToken(token);
    return this.invoices.renderOrderInvoiceForClaim(claim);
  }
}
