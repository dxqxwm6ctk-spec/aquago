import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * يسجّل كل استثناء غير معالَج بأثر مكدّس كامل، ويردّ رسالة محايدة للعميل.
 *
 * **لماذا الفصل بين ما يُسجَّل وما يُرَدّ:** الاستثناء غير المتوقَّع قد
 * يحمل في رسالته اسم جدول أو جزء استعلام أو مسار ملف. إرساله للعميل
 * تسريبُ بنية داخلية؛ وإخفاؤه عن السجلّ يجعل التشخيص مستحيلاً. فالتفصيل
 * كاملاً إلى السجلّ، ورسالة عامة إلى العميل.
 *
 * **استثناءات Nest المقصودة تمرّ كما هي:** `BadRequestException('اكتب سبب
 * الرفض')` رسالة للمستخدم كتبها مطوّر عمداً، لا تسريب.
 *
 * لا يبتلع شيئاً: كل ما يمرّ هنا يُسجَّل، وما كان 5xx يُسجَّل خطأً بمكدّسه
 * فيظهر في تنبيه «أخطاء 5xx مرتفعة».
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    // WebSocket وسياقات أخرى: لا استجابة HTTP نكتبها — نسجّل ونعيد.
    if (host.getType() !== 'http') {
      this.logger.error(
        `استثناء خارج سياق HTTP: ${describe(exception)}`,
        stackOf(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const where = `${req.method} ${req.path}`;

    if (status >= 500) {
      this.logger.error(`${where} → ${status}: ${describe(exception)}`, stackOf(exception));
    } else {
      // 4xx متوقَّعة — تُسجَّل تحذيراً بلا مكدّس، فلا تغرق السجلّ
      this.logger.warn(`${where} → ${status}: ${describe(exception)}`);
    }

    if (res.headersSent) return; // بدأ البثّ فعلاً (ملف مثلاً) — لا نكتب فوقه

    const body = isHttp
      ? exception.getResponse()
      : { statusCode: status, message: 'حدث خطأ غير متوقَّع' };

    res.status(status).json(
      typeof body === 'string' ? { statusCode: status, message: body } : body,
    );
  }
}

function describe(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    return typeof r === 'string' ? r : JSON.stringify(r);
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function stackOf(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined;
}
