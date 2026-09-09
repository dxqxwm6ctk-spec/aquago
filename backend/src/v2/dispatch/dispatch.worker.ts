import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { isWorker } from '../common/role';
import { instrumentJobOutcomes } from '../observability/job-metrics';
import { attachQueueErrorLogger, bullConnection, DISPATCH_QUEUE_NAME } from './dispatch.queue';
import { DispatchService } from './dispatch.service';

/**
 * مستهلك مؤقتات المحرك:
 *   offer-timeout   العرض ما زال PENDING؟ → EXPIRED → السائق التالي
 *   manual-timeout  لم يعيّن موظف الوكالة سائقاً → وكالة أخرى
 *   wait-retry      تكة انتظار: هل ظهرت وكالة بسائق متاح؟
 *   wait-timeout    انقضى سقف الانتظار → إلغاء تلقائي مع اعتذار
 *   redispatch-timeout  لم يردّ الزبون بعد انسحاب سائق → إلغاء بلا خصم
 */
@Injectable()
export class DispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchWorker.name);
  private worker?: Worker;

  constructor(private dispatch: DispatchService) {}

  onModuleInit() {
    // ROLE=api لا يستهلك: الاستهلاك وظيفة العامل وحده. الخدمة تبقى مسجَّلة
    // في الوحدة لأن DispatchService يعتمد عليها، لكن لا يُنشأ Worker هنا.
    if (!isWorker()) {
      this.logger.log('ROLE=api — لا يُشغَّل مستهلك dispatch-offers');
      return;
    }
    this.worker = new Worker(
      DISPATCH_QUEUE_NAME,
      async (job) => {
        if (job.name === 'dispatch-order') {
          // بدء التوزيع لطلب جديد. `dispatchOrder` ترمي إن لم يعد الطلب
          // في حالة CREATED — وهذا صحيح لا خطأ: نداءٌ مكرَّر أو طلبٌ
          // أُلغي بين الإدراج والمعالجة. نبتلعه هنا بدل أن يُعاد ثلاثاً
          // ويُسجَّل فشلاً كاذباً يلوّث تنبيه «فشل مهام العامل».
          try {
            await this.dispatch.dispatchOrder(job.data.orderId as string);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/لا يمكن بدء التوزيع|غير موجود/.test(msg)) {
              this.logger.log(`تُخطّي توزيع ${job.data.orderId}: ${msg}`);
              return;
            }
            throw e;
          }
        } else if (job.name === 'offer-timeout') {
          await this.dispatch.handleOfferTimeout(job.data.offerId as string);
        } else if (job.name === 'manual-timeout') {
          await this.dispatch.handleManualTimeout(
            job.data.orderId as string,
            job.data.agencyId as string,
          );
        } else if (job.name === 'wait-retry') {
          await this.dispatch.handleWaitRetry(job.data.orderId as string);
        } else if (job.name === 'wait-timeout') {
          await this.dispatch.handleWaitTimeout(job.data.orderId as string);
        } else if (job.name === 'redispatch-timeout') {
          await this.dispatch.handleRedispatchTimeout(job.data.orderId as string);
        }
      },
      { connection: bullConnection() },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`فشلت مهمة ${job?.name} (${job?.id}): ${err.message}`),
    );
    // انظر التوثيق الكامل عند attachQueueErrorLogger — بلا هذا يُسقط
    // انقطاع Redis العملية كلها بخطأ غير ملتقَط لا برسالة سجلّ واحدة.
    attachQueueErrorLogger(this.worker, DISPATCH_QUEUE_NAME);
    instrumentJobOutcomes(this.worker, DISPATCH_QUEUE_NAME);
  }

  onModuleDestroy() {
    return this.worker?.close();
  }
}
