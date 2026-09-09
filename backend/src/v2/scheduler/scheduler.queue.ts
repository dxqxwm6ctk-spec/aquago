import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { isWorker } from '../common/role';
import { attachQueueErrorLogger, bullConnection } from '../dispatch/dispatch.queue';

export const SCHEDULER_QUEUE_NAME = 'scheduled-jobs';

/** أسماء المهام المجدولة — الاسم هو مفتاح التكرار في BullMQ */
export const SCHEDULED_JOBS = {
  contractAlerts: 'contract-alerts',
  subscriptionCycle: 'subscription-cycle',
} as const;

export type ScheduledJobName =
  (typeof SCHEDULED_JOBS)[keyof typeof SCHEDULED_JOBS];

/**
 * جدولة المهام الدورية.
 *
 * **لماذا طابور بدل `setInterval`:** المؤقّت يعيش داخل العملية، فكل حاوية
 * API تشغّل نسختها منه. حاويتان تعنيان مسحين متوازيين للقاعدة وسباقاً على
 * نفس الصفوف. الفواتير محميّة بقيد `@@unique([agencyId, periodStart])`
 * والتنبيهات بقيد مماثل — فلم يكن الضرر فوترةً مزدوجة، لكنه عملٌ مضاعف
 * وسباقٌ لا داعي له، وكلاهما يسوء كلما زادت الحاويات.
 *
 * `repeat` في BullMQ يضمن التشغيل مرة واحدة لكل فترة مهما كثر المنتجون:
 * المفتاح مشتقّ من (الاسم + نمط التكرار)، والمهمة المتأخرة تُدرَج مرة واحدة
 * في Redis لا مرة لكل عملية.
 */
@Injectable()
export class SchedulerQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerQueue.name);
  private queue = new Queue(SCHEDULER_QUEUE_NAME, {
    connection: bullConnection(),
  });

  constructor() {
    // انظر التوثيق الكامل عند attachQueueErrorLogger — بلا هذا يُسقط
    // انقطاع Redis العملية كلها بخطأ غير ملتقَط لا برسالة سجلّ واحدة.
    attachQueueErrorLogger(this.queue, SCHEDULER_QUEUE_NAME);
  }

  /**
   * تُسجَّل من العامل وحده. لو سجّلها كل API لتنافست العمليات على كتابة نفس
   * مفتاح التكرار — غير ضارّ لكنه ضجيج، والعامل هو من يملك هذه المهام أصلاً.
   */
  async onModuleInit() {
    if (!isWorker()) return;
    const every = (h: number) => h * 60 * 60 * 1000;
    await this.register(SCHEDULED_JOBS.contractAlerts, every(1));
    await this.register(SCHEDULED_JOBS.subscriptionCycle, every(6));
  }

  private async register(name: ScheduledJobName, everyMs: number) {
    // إزالة المجدولات القديمة لنفس الاسم: تغيير الفترة بين إصدارين يترك
    // المفتاح القديم حيّاً في Redis، فتعمل المهمة بفترتين معاً.
    for (const r of await this.queue.getRepeatableJobs()) {
      // `every` نصّ في BullMQ v5 لا رقم — المقارنة المباشرة لا تطابق أبداً
      // فتبقى المجدولات القديمة حيّة إلى الأبد بجانب الجديدة.
      if (r.name === name && Number(r.every) !== everyMs) {
        await this.queue.removeRepeatableByKey(r.key);
        this.logger.log(`أُزيل تكرار قديم لـ${name} (${r.every}ms)`);
      }
    }
    await this.queue.add(
      name,
      {},
      {
        repeat: { every: everyMs },
        // المهمة الدورية لا تُراكم تاريخاً: تُنظَّف فور نجاحها
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log(`جُدولت ${name} كل ${everyMs / 60_000} دقيقة`);
  }

  onModuleDestroy() {
    return this.queue.close();
  }
}
