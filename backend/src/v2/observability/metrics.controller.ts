import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { MetricsService } from './metrics.service';
import { QueueDepthService } from './queue-depth.service';

/**
 * `/api/metrics` — نقطة الكشط للمجمّع.
 *
 * **لماذا محميّة والصحّة ليست كذلك:** فحص الصحّة يقول «حيّ/غير حيّ» ولا
 * شيء غيره، والموازن يستدعيه بلا توكن فحمايته تعطّله. أما المقاييس فتكشف
 * خريطة المسارات وأحجام الحركة وأزمنة الاستجابة وأعماق الطوابير — وهي
 * استطلاعٌ جاهز لمن يبحث عن مسار مثقل يهاجمه. المجمّع يستطيع حمل ترويسة،
 * والموازن لا يستطيع؛ فالحماية هنا بلا ثمن تشغيلي.
 *
 * **بلا `METRICS_TOKEN` تُغلق النقطة:** لا تُفتح للجميع «مؤقتاً». نقطة
 * مفتوحة بسبب متغيّر منسيّ تبقى مفتوحة سنة، والإغلاق يُكتشف فوراً عند أول
 * كشط بينما الانفتاح لا يُكتشف أبداً. الفشل هنا صاخب وآمن، والبديل صامت
 * وخطر.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private metrics: MetricsService,
    private queues: QueueDepthService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request): Promise<string> {
    this.authorize(req);
    // الأعماق تُقرأ من Redis: تعذّرها لا يُسقط بقية المقاييس، وهو
    // بالضبط الوقت الذي تكون فيه المقاييس الأخرى مطلوبة.
    const depth = await this.queues.render().catch(() => '');
    return this.metrics.render() + depth;
  }

  /** نفس الأرقام بصيغة JSON — للوحات لا تتكلم Prometheus وللفحص اليدوي */
  @Get('json')
  async json(@Req() req: Request) {
    this.authorize(req);
    return {
      ...this.metrics.snapshot(),
      queues: await this.queues.depths().catch(() => ({})),
    };
  }

  private authorize(req: Request) {
    const expected = (process.env.METRICS_TOKEN || '').trim();
    if (!expected) {
      throw new ForbiddenException('METRICS_TOKEN غير معرَّف — نقطة المقاييس مغلقة');
    }
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given || !safeEqual(given, expected)) {
      throw new ForbiddenException('توكن المقاييس غير صحيح');
    }
  }
}

/** مقارنة ثابتة الزمن — الفرق في زمن الرفض يسرّب التوكن حرفاً حرفاً */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual يرمي على اختلاف الطول — الطول ليس سرّاً، والمحتوى هو
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
