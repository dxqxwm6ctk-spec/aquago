import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { attachQueueErrorLogger, bullConnection } from '../dispatch/dispatch.queue';

export const WHATSAPP_QUEUE_NAME = 'aquago-whatsapp';

/** حمولة مهمة الإرسال — كل ما يحتاجه العامل بلا استعلام إضافي للتوجيه */
export interface WhatsAppJob {
  campaignId: string;
  recipientId: string;
  /// موجود لمستلمي الوكالات المحتملة وحدهم — المستخدمون والقوائم بلا سجل وكالة
  leadId: string | null;
  phoneNumber: string;
  /** نص الرسالة بعد ملء متغيّرات القالب لهذا المستلم تحديداً */
  body: string;
  /** قالب Meta المعتمد ومتغيّراته — يُتجاهَل حين تكون القناة OpenWA */
  template?: { name: string; language?: string; params?: string[] };
}

/**
 * طابور إرسال الحملات.
 *
 * **بلا بنية طوابير ثانية**: `bullConnection()` مستوردة حرفياً من طابور
 * المحرك (dispatch.queue.ts) — نفس Redis، نفس معالجة بيانات اعتماد Railway
 * وTLS. طابور منفصل بالاسم فقط لأن الإرسال الجماعي البطيء لا يجوز أن يزاحم
 * مؤقتات التوزيع الحسّاسة زمنياً على نفس العمّال.
 *
 * `jobId` = معرّف المستلم. هذا هو الحاجز الثاني ضد الازدواج (الأول قيد
 * `@@unique([campaignId, leadId])` في القاعدة): استئناف حملة أو نداء «ابدأ»
 * مرتين لا ينشئ مهمة ثانية لنفس المستلم ما دامت الأولى في الطابور.
 */
@Injectable()
export class WhatsAppQueue implements OnModuleDestroy {
  private queue = new Queue(WHATSAPP_QUEUE_NAME, {
    connection: bullConnection(),
  });

  constructor() {
    // انظر التوثيق الكامل عند attachQueueErrorLogger — بلا هذا يُسقط
    // انقطاع Redis العملية كلها بخطأ غير ملتقَط لا برسالة سجلّ واحدة.
    attachQueueErrorLogger(this.queue, WHATSAPP_QUEUE_NAME);
  }

  /**
   * `delayMs` تباعدٌ بسيط بين الرسائل يمليه أدب التعامل مع بوابة واحدة
   * وجلسة واحدة — ليس التفافاً على حدٍّ ولا إخفاءً لسلوك: البطء مقصود
   * وظاهر، والحملة تُرى وهي تسير.
   */
  async enqueueSend(job: WhatsAppJob, delayMs = 0): Promise<void> {
    await this.queue.add('send-message', job, {
      delay: delayMs,
      jobId: job.recipientId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      // الفاشلة تبقى للتشخيص — لماذا لم تصل رسالة إلى وكالة بعينها سؤالٌ يُسأل
      removeOnFail: 500,
    });
  }

  /** إلغاء ما لم يبدأ بعد — الإيقاف والإلغاء يجب أن يوقفا فعلاً لا اسماً */
  async removePending(recipientIds: string[]): Promise<number> {
    let removed = 0;
    for (const id of recipientIds) {
      const job = await this.queue.getJob(id);
      if (!job) continue;
      // مهمة قيد التنفيذ لا تُنتزع من تحت العامل — تُترك لتكمل، والعامل
      // نفسه يتحقق من حالة الحملة قبل أن يرسل.
      const state = await job.getState();
      if (state === 'active') continue;
      await job.remove();
      removed++;
    }
    return removed;
  }

  onModuleDestroy() {
    return this.queue.close();
  }
}
