import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * فحوص الصحّة — بلا حراسة دخول عمداً: موازن التحميل يستدعيها بلا توكن،
 * وحمايتها تعني تعطيل الفحص نفسه.
 *
 * **الحيّ (liveness) والجاهز (readiness) مساران منفصلان لسبب تشغيلي لا
 * أكاديمي:** حاوية تستجيب على `/health/live` لكن قاعدتها منقطعة يجب أن
 * تبقى في دوران Docker/systemd (لا تُعاد بلا داعٍ — العملية سليمة، والمشكلة
 * خارجها) لكن تخرج من دوران موازن التحميل (لا تصلح لخدمة طلبات الآن).
 * دمجهما في فحص واحد يجعل عطلاً في القاعدة يبدو وكأنه عطل في الحاوية،
 * فيُعاد تشغيلها بلا فائدة بينما المشكلة في مكان آخر تماماً.
 */
@Controller('health')
export class HealthController {
  constructor(private health: HealthService) {}

  /**
   * حيّ: العملية تستجيب. لا يفحص قاعدة ولا Redis عمداً — انهيار تبعية
   * خارجية لا يعني أن العملية نفسها معطوبة، وخلط الاثنين يحوّل استخدام
   * Docker `restart: on-failure` إلى حلقة إعادة تشغيل لا تصلح شيئاً.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok' };
  }

  /**
   * جاهز: هذه الحاوية بعينها تصلح لخدمة إنتاج الآن. 200 يُبقيها في دوران
   * موازن التحميل، و503 يُخرجها منه فوراً بلا انتظار فشل طلب زبون حقيقي.
   */
  @Get('ready')
  async ready(@Res() res: Response) {
    const result = await this.health.readiness();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result);
  }

  /**
   * `/api/health` — المسار المعياري الذي تتوقعه فحوص المنصّات جاهزاً بلا
   * إعداد إضافي (Railway `healthcheckPath`، وموازن DigitalOcean، وDocker
   * `HEALTHCHECK`). دلالته دلالة الجاهزية نفسها: 200 يعني «وجّه إليّ
   * طلبات»، و503 يعني «أخرجني من الدوران» — وهو ما يريده موازن التحميل
   * فعلاً؛ فحصٌ يجيب 200 بينما القاعدة مقطوعة يوجّه إليه طلباتٍ ستفشل.
   *
   * الشكل مسطَّح لا متداخل عمداً: `{"status":"ok","database":"ok",
   * "redis":"ok"}` يُقرأ بلا معرفة ببنيتنا الداخلية، وبعض أدوات المراقبة
   * لا تقرأ إلا حقولاً من المستوى الأول.
   */
  @Get()
  async health_(@Res() res: Response) {
    const r = await this.health.readiness();
    res.status(r.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: r.ready ? 'ok' : 'degraded',
      database: r.checks.database,
      redis: r.checks.redis,
      role: r.role,
      latencyMs: r.latencyMs,
    });
  }
}
