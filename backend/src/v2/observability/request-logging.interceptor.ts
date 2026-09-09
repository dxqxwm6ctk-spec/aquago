import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/** مسارات صاخبة بلا معلومة — فحص الموازن يضرب كل بضع ثوانٍ على كل حاوية */
const QUIET_PATHS = new Set(['/api/health', '/api/health/live', '/api/health/ready']);

/** أبطأ من هذا يُسجَّل تحذيراً لا معلومة — عتبة قابلة للضبط */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 1000);

/**
 * سطر سجلّ واحد لكل استجابة. **العدّ ليس هنا** — `MetricsMiddleware`
 * يتولّاه لأنه يسبق الحرّاس فيرى ما يرفضونه، وهذا المعترض لا يراه.
 *
 * **المسار النمطي لا الفعلي:** `/api/v2/orders/:id` لا
 * `/api/v2/orders/8f3c…`. لولا ذلك لأنتج كل طلبٍ سلسلةَ مقاييس جديدة —
 * انفجار أبعاد يُسقط أي مجمّع خلال ساعات، وهو الخطأ الكلاسيكي في هذه
 * الطبقة بالذات.
 *
 * **فحوص الصحّة تُسجَّل فقط حين تفشل:** الموازن يستدعيها كل عشر ثوانٍ على
 * كل حاوية — تسجيلها ناجحةً يغرق السجلّ بما لا يُقرأ ويخفي ما يُقرأ.
 * فشلها يُسجَّل دائماً: هو بالضبط ما نراقبه.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.record(ctx, req, http.getResponse<Response>().statusCode, started),
        // الخطأ يمرّ بالمرشّح الذي يحدّد الرمز النهائي؛ نقيس هنا بما نعرفه
        // ونترك التفاصيل له، فلا يُسجَّل الخطأ مرتين بصيغتين.
        error: (e: { status?: number }) => this.record(ctx, req, e?.status ?? 500, started),
      }),
    );
  }

  private record(ctx: ExecutionContext, req: Request, status: number, started: number) {
    const ms = Date.now() - started;
    const route = routeOf(ctx, req);
    // العدّ ليس هنا: `MetricsMiddleware` يعدّ كل استجابة بما فيها ما
    // يرفضه الحارس قبل بلوغ هذه الطبقة. العدّ في الموضعين يضاعف كل طلب
    // ناجح ويُبقي المرفوض مبكراً ناقصاً — أسوأ من الاثنين.
    const quiet = QUIET_PATHS.has(req.path) && status < 400;
    if (quiet) return;

    const msg = `${req.method} ${route} ${status} ${ms}ms`;
    if (status >= 500) this.logger.error(msg);
    else if (status >= 400 || ms >= SLOW_MS) this.logger.warn(msg);
    else this.logger.log(msg);
  }
}

/**
 * النمط المسجَّل في Nest إن توفّر، وإلا المسار الفعلي بعد تعقيم المقاطع
 * التي تبدو معرّفات — حارسٌ ثانٍ ضد انفجار الأبعاد حين لا يوفّر Express
 * `route.path` (استجابات 404 مثلاً لا تطابق أي معالج).
 */
function routeOf(ctx: ExecutionContext, req: Request): string {
  const pattern = (req as Request & { route?: { path?: string } }).route?.path;
  if (pattern) {
    const base = req.baseUrl || '';
    return (base + pattern) || pattern;
  }
  return req.path
    .split('/')
    .map((seg) => (looksLikeId(seg) ? ':id' : seg))
    .join('/');
}

function looksLikeId(seg: string): boolean {
  if (!seg) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return true; // uuid
  if (/^\d+$/.test(seg)) return true;                       // رقم
  if (seg.length >= 20 && /^[a-z0-9]+$/i.test(seg)) return true; // cuid وما شابه
  return false;
}
