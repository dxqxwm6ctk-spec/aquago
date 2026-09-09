import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * يعدّ **كل** استجابة، بما فيها ما ترفضه الحرّاس.
 *
 * **لماذا وسيطة لا معترضاً وحده:** Nest يشغّل الحرّاس *قبل* المعترضات،
 * فطلبٌ يرفضه `JwtV2Guard` بـ401 لا يمرّ بالمعترض إطلاقاً. ثبت هذا بقياس
 * حيّ على الحزمة: طلبان بـ401 على `/api/v2/orders/*` ظهرا في السجلّ عبر
 * المرشّح ولم يظهرا في `aquago_http_requests_total` بتاتاً، بينما ظهر رفض
 * `/api/metrics` لأنه صادر من داخل المتحكّم (بعد المعترض).
 *
 * أثر ذلك أسوأ من نقص عدد: العدّاد يصير **غير متّسق** — يعدّ بعض الـ4xx
 * ويُسقط بعضها بحسب موضع الرفض في السلسلة. وأخطر ما يُفقد بالضبط هو
 * موجة 401/403، وهي إشارة حشو بيانات اعتماد أو إصدار عميل مكسور — أي
 * الحالات التي وُجد التنبيه لأجلها.
 *
 * الوسيطة تسبق كل شيء وتستمع لحدث `finish` على الاستجابة، فتقيس ما خرج
 * فعلاً مهما كان مصدره: حارس أو مرشّح أو معالج أو 404 بلا مسار مطابق.
 *
 * **السجلّ يبقى في المعترض والمرشّح:** هذه للعدّ وحده. تسجيل السطر هنا
 * أيضاً يعني سطرين لكل طلب مرفوض.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const started = Date.now();
    // `finish` لا `close`: الأول يعني أن الاستجابة كُتبت كاملة، والثاني
    // يقع أيضاً حين يقطع العميل الاتصال — وذلك ليس استجابة نقيسها.
    res.once('finish', () => {
      this.metrics.recordRequest(
        req.method,
        // النمط غير متاح هنا في حالة الرفض المبكر (لم يُطابَق معالج بعد)،
        // فيُعقَّم المسار — نفس حارس الأبعاد الموجود في المعترض.
        routePattern(req),
        res.statusCode,
        Date.now() - started,
      );
    });
    next();
  }
}

/**
 * نمط المسار إن توفّر، وإلا المسار الفعلي بعد تعقيم ما يبدو معرّفاً.
 *
 * مكرَّرة عمداً مع `routeOf` في المعترض بدل استخراجها: هناك تُقرأ من
 * `ExecutionContext`، وهنا من `Request` وحده قبل أن يعرف Nest المعالج.
 * التوحيد كان سيفرض على إحداهما شكلاً لا يناسبها.
 */
function routePattern(req: Request): string {
  const pattern = (req as Request & { route?: { path?: string } }).route?.path;
  if (pattern) return (req.baseUrl || '') + pattern;
  return req.path
    .split('/')
    .map((seg) => (looksLikeId(seg) ? ':id' : seg))
    .join('/');
}

function looksLikeId(seg: string): boolean {
  if (!seg) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (seg.length >= 20 && /^[a-z0-9]+$/i.test(seg)) return true;
  return false;
}
