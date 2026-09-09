import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DelayedError, Worker } from 'bullmq';
import { isWorker } from '../common/role';
import { attachQueueErrorLogger, bullConnection } from '../dispatch/dispatch.queue';
import { instrumentJobOutcomes } from '../observability/job-metrics';
import {
  ProviderNotReadyError,
  WhatsAppSenderService,
} from './whatsapp-sender.service';
import { WHATSAPP_QUEUE_NAME, type WhatsAppJob } from './whatsapp.queue';

/** كم تنتظر مهمة قبل أن تسأل عن البوابة ثانيةً */
const PROVIDER_RETRY_DELAY_MS = Number(
  process.env.WHATSAPP_PROVIDER_RETRY_MS || 60_000,
);

/**
 * عامل إرسال الحملات.
 *
 * `concurrency: 1` قرار لا إغفال: البوابة جلسة واتساب واحدة، والتوازي عليها
 * لا يضاعف الطاقة — يضاعف احتمال أن تخلط الجلسة الرسائل أو تُقطع. الرسائل
 * تخرج واحدة تلو الأخرى بتباعد ظاهر في الطابور.
 */
@Injectable()
export class WhatsAppWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppWorker.name);
  private worker?: Worker;

  constructor(private sender: WhatsAppSenderService) {}

  onModuleInit() {
    // ROLE=api لا يستهلك — انظر التعليق في dispatch.worker.ts. يزيد هنا سببٌ
    // خاص: البوابة جلسة واتساب واحدة، ومستهلكان عليها يخلطان الرسائل.
    if (!isWorker()) {
      this.logger.log('ROLE=api — لا يُشغَّل مستهلك طابور واتساب');
      return;
    }
    this.worker = new Worker<WhatsAppJob>(
      WHATSAPP_QUEUE_NAME,
      async (job, token) => {
        try {
          await this.sender.processSend(job.data);
        } catch (e) {
          if (e instanceof ProviderNotReadyError) {
            // تأجيل لا فشل: `moveToDelayed` لا تستهلك محاولة، فبوابة نائمة
            // ساعةً لا تحرق محاولات الحملة كلها ولا تُغرقها بطلبات متلاحقة.
            this.logger.warn(
              `بوابة واتساب غير جاهزة — تأجيل ${job.id} ${PROVIDER_RETRY_DELAY_MS / 1000}s`,
            );
            await job.moveToDelayed(Date.now() + PROVIDER_RETRY_DELAY_MS, token);
            throw new DelayedError();
          }
          throw e;
        }
      },
      { connection: bullConnection(), concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      if (err instanceof DelayedError) return; // تأجيل مقصود لا فشل
      this.logger.error(`فشلت مهمة واتساب ${job?.id}: ${err.message}`);
    });
    // انظر التوثيق الكامل عند attachQueueErrorLogger — بلا هذا يُسقط
    // انقطاع Redis العملية كلها بخطأ غير ملتقَط لا برسالة سجلّ واحدة.
    attachQueueErrorLogger(this.worker, WHATSAPP_QUEUE_NAME);
    // نفس استثناء التأجيل أعلاه — التأجيل المقصود ليس فشلاً يُعدّ
    instrumentJobOutcomes(this.worker, WHATSAPP_QUEUE_NAME, (e) => e instanceof DelayedError);
  }

  onModuleDestroy() {
    return this.worker?.close();
  }
}
