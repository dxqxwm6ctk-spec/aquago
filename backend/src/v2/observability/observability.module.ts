import { Global, MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { bindJobMetrics } from './job-metrics';
import { MetricsController } from './metrics.controller';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';
import { QueueDepthService } from './queue-depth.service';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

/**
 * طبقة المراقبة.
 *
 * **`@Global` لأنها ليست ميزة نطاقها وحدة:** المرشّح والمعترض يُسجَّلان
 * عبر `APP_FILTER`/`APP_INTERCEPTOR` فيسريان على التطبيق كله، ولا معنى
 * لاستيراد هذه الوحدة في كل وحدة نطاق.
 *
 * **التسجيل عبر رموز Nest لا `app.useGlobalFilters` في main.ts:** المسجَّل
 * هكذا يمرّ بحقن الاعتماديات، وهو ما يحتاجه المعترض ليصل إلى
 * `MetricsService`. المسجَّل في `main.ts` يُنشأ يدوياً بلا حاوية.
 *
 * تعمل في الدورين معاً: العامل لا يخدم HTTP فلا يمرّ به المعترض، لكن
 * المرشّح يلتقط استثناءاته خارج سياق HTTP، وعدّادات المهام تُربط هنا.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    QueueDepthService,
    MetricsMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
  exports: [MetricsService, QueueDepthService],
})
export class ObservabilityModule implements NestModule, OnModuleInit {
  constructor(private metrics: MetricsService) {}

  onModuleInit() {
    bindJobMetrics(this.metrics);
  }

  /**
   * `'*'` عمداً: المقصود عدّ كل ما يدخل الخادم — بما فيه 404 لا يطابق أي
   * مسار مسجَّل، وهو بذاته إشارة (عميل يستدعي نسخة API قديمة مثلاً).
   *
   * في دور العامل لا يوجد خادم HTTP، فلا تُستدعى هذه أصلاً.
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
