import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { isWorker } from '../common/role';
import {
  attachQueueErrorLogger,
  bullConnection,
  DISPATCH_QUEUE_NAME,
} from '../dispatch/dispatch.queue';
import { WHATSAPP_QUEUE_NAME } from '../outreach/whatsapp.queue';
import { SCHEDULER_QUEUE_NAME } from '../scheduler/scheduler.queue';

export interface QueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/** أقصى انتظار لقراءة الأعماق — القياس لا يجوز أن يعلّق طلب المقاييس */
const READ_TIMEOUT_MS = 1500;

const QUEUES = [DISPATCH_QUEUE_NAME, SCHEDULER_QUEUE_NAME, WHATSAPP_QUEUE_NAME] as const;

/**
 * أعماق الطوابير — الإشارة التي يُبنى عليها تنبيه «طابور ينمو».
 *
 * **لماذا القراءة من Redis لا من ذاكرة العملية:** العمق حالة مشتركة بين
 * كل المنتجين والمستهلكين، لا حالة عملية. وهذا ما يجعله قابلاً للقراءة من
 * الـAPI رغم أن المستهلك هو العامل — والعامل بلا HTTP، فلو كان العمق في
 * ذاكرته لما وصل إلى أي مجمّع.
 *
 * **`delayed` ليس ازدحاماً:** مهلات العروض كلها مهام مؤجَّلة بطبيعتها،
 * فعددها يعكس الطلبات الجارية لا تأخّراً. الازدحام الحقيقي هو `waiting`
 * المرتفع مع `active` منخفض — مهامٌ جاهزة ولا مستهلك يأخذها. لذلك تُفصل
 * الحقول الأربعة ولا تُجمع في رقم واحد: الرقم المجموع يخفي بالضبط ما
 * يميّز الطابور الصحّي من المتوقّف.
 *
 * `failed` تراكميّ لأن الطوابير تحتفظ بالفاشلة عمداً (`removeOnFail: 500`
 * في طابور واتساب) — قفزته لا قيمته المطلقة هي الإشارة.
 */
@Injectable()
export class QueueDepthService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueDepthService.name);
  private readonly queues = new Map<string, Queue>();

  constructor() {
    // **العامل لا يفتح هذه الاتصالات:** لا نقطة `/api/metrics` فيه (بلا
    // خادم HTTP)، فلا قارئ لها إطلاقاً. فتحها هناك كان يكلّف ثلاثة
    // اتصالات Redis لكل عملية عامل بلا أي قارئ — ظهر ذلك في التشغيل
    // الحيّ سطورَ `BullMQ:depth:*` في سجلّ العامل أثناء انقطاع Redis.
    // الأعماق حالة مشتركة في Redis: قراءتها من الـAPI تصف العامل أيضاً.
    if (isWorker()) return;
    for (const name of QUEUES) {
      const q = new Queue(name, { connection: bullConnection() });
      // بلا هذا يُسقط انقطاع Redis العملية — انظر التوثيق في dispatch.queue.ts
      attachQueueErrorLogger(q, `depth:${name}`);
      this.queues.set(name, q);
    }
  }

  /**
   * أعماق كل الطوابير. الطابور الذي تتعذّر قراءته يُحذف من النتيجة ولا
   * يُصفَّر: الصفر يعني «فارغ» وهو خبرٌ مطمئِن كاذب حين تكون الحقيقة
   * «لا نعرف». غياب الحقل يُظهر الجهل جهلاً.
   */
  async depths(): Promise<Record<string, QueueDepth>> {
    const out: Record<string, QueueDepth> = {};
    await Promise.all(
      [...this.queues].map(async ([name, q]) => {
        try {
          const counts = await withTimeout(
            q.getJobCounts('waiting', 'active', 'delayed', 'failed'),
            READ_TIMEOUT_MS,
          );
          out[name] = {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch (e) {
          this.logger.warn(`تعذّرت قراءة عمق ${name}: ${(e as Error).message}`);
        }
      }),
    );
    return out;
  }

  /** أسطر Prometheus — تُدمج مع مخرَج MetricsService */
  async render(): Promise<string> {
    const role = process.env.ROLE || 'api';
    const depths = await this.depths();
    const lines: string[] = [
      '# HELP aquago_queue_depth عدد المهام في الطابور بحسب الحالة',
      '# TYPE aquago_queue_depth gauge',
    ];
    for (const [queue, d] of Object.entries(depths)) {
      for (const [state, n] of Object.entries(d)) {
        lines.push(`aquago_queue_depth{role="${role}",queue="${queue}",state="${state}"} ${n}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('queue read timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
