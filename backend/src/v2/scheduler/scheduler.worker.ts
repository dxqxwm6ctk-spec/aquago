import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { isWorker } from '../common/role';
import { ContractAlertsService } from '../contracts/contract-alerts.service';
import { attachQueueErrorLogger, bullConnection } from '../dispatch/dispatch.queue';
import { instrumentJobOutcomes } from '../observability/job-metrics';
import { SubscriptionService } from '../finance/subscription.service';
import { SCHEDULED_JOBS, SCHEDULER_QUEUE_NAME } from './scheduler.queue';

/**
 * منفّذ المهام الدورية — بديل مؤقّتات `setInterval` التي كانت داخل الخدمات.
 *
 * `concurrency: 1`: المهمتان تمسحان جداول كاملة وتكتبان إشعارات. تشغيلهما
 * متوازيتين على نفس العامل لا يفيد — العمل مقيَّد بالقاعدة لا بالمعالج.
 *
 * الفشل يُسجَّل ولا يُسقط العملية: مهمة فاشلة تعيد المحاولة في الدورة
 * التالية، ودورة ضائعة أهون من عاملٍ ميت يوقف مؤقتات التوزيع كلها معه.
 */
@Injectable()
export class SchedulerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerWorker.name);
  private worker?: Worker;

  constructor(
    private contractAlerts: ContractAlertsService,
    private subscriptions: SubscriptionService,
  ) {}

  onModuleInit() {
    if (!isWorker()) {
      this.logger.log('ROLE=api — لا تُشغَّل المهام المجدولة');
      return;
    }
    this.worker = new Worker(
      SCHEDULER_QUEUE_NAME,
      async (job) => {
        switch (job.name) {
          case SCHEDULED_JOBS.contractAlerts:
            await this.contractAlerts.tick();
            break;
          case SCHEDULED_JOBS.subscriptionCycle:
            // الاثنتان في مهمة واحدة: كانتا تُنفَّذان معاً في نفس المؤقّت،
            // وفصلهما يعني مسحين للجدول نفسه بلا سبب.
            await this.subscriptions.issueMonthlyInvoices();
            await this.subscriptions.warnExpiring();
            break;
          default:
            this.logger.warn(`مهمة مجدولة غير معروفة: ${job.name}`);
        }
      },
      { connection: bullConnection(), concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`فشلت المهمة المجدولة ${job?.name}: ${err.message}`),
    );
    // انظر التوثيق الكامل عند attachQueueErrorLogger — بلا هذا يُسقط
    // انقطاع Redis العملية كلها بخطأ غير ملتقَط لا برسالة سجلّ واحدة.
    attachQueueErrorLogger(this.worker, SCHEDULER_QUEUE_NAME);
    instrumentJobOutcomes(this.worker, SCHEDULER_QUEUE_NAME);
    this.logger.log('ROLE=worker — المهام المجدولة تعمل');
  }

  onModuleDestroy() {
    return this.worker?.close();
  }
}
