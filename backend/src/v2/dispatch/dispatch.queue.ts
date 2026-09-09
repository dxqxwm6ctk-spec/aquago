import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

export const DISPATCH_QUEUE_NAME = 'dispatch-offers';

/**
 * خيارات اتصال (وليس مثيل Redis) — BullMQ ينشئ اتصالاته بنفسه بنسخته من ioredis.
 * لا بد من تمرير بيانات الاعتماد و TLS: مزودات مثل Railway تعطي
 * `redis://default:PASSWORD@host:port` (أو `rediss://` مع TLS)، وإسقاطها
 * يعني فشل المصادقة (NOAUTH) فتبقى العروض بلا مهلة والطلبات عالقة في SEARCHING.
 */
export function bullConnection() {
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  // `REDIS_TLS=true` للمزوّد الذي يفرض TLS لكنه يعطي رابط `redis://` —
  // نفس منطق redisTlsOption() في redis.module.ts، مكرَّراً هنا لأن BullMQ
  // يبني اتصاله من كائن خيارات لا من رابط، ولأن استيراد الوحدة هنا يعكس
  // اتجاه الاعتماد (redis.module يستورد من هذا الملف لا العكس).
  const forcedTls = ['true', '1'].includes(
    (process.env.REDIS_TLS || '').trim().toLowerCase(),
  );
  const useTls = url.protocol === 'rediss:' || forcedTls;
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(useTls ? { tls: { servername: url.hostname } } : {}),
    maxRetriesPerRequest: null as null,
  };
}

/**
 * تسجّل خطأ اتصال — لا تتجاهله: `Queue` و`Worker` من BullMQ يرثان
 * EventEmitter، وحدث 'error' بلا مستمع واحد يرمي استثناءً غير ملتقَط يُسقط
 * العملية كلها — ثبت هذا فعلياً بتشغيل حقيقي (المرحلة 3.4): إيقاف Redis
 * أثناء عمل حاويتَي API أسقطهما كليهما بـ`MaxRetriesPerRequestError` غير
 * ملتقَطة، رغم أن `RedisV2Module` (طابور آخر تماماً) كان يسجّل أخطاءه بلا
 * تعطّل — لأن عميل BullMQ الداخلي لا يمرّ بذلك المصنع، وليس له مستمع خطأ
 * خاص به. التسجيل هنا لا يُصلح الاتصال — يمنع فقط أن يقتل غيابُ المستمع
 * العملية. تنطبق نفس المخاطرة على `Worker` (طرف الاستهلاك) بقدر `Queue`
 * (طرف الإضافة)، فكلاهما يستدعي هذه الدالة.
 */
export function attachQueueErrorLogger(emitter: Queue, label: string): void;
export function attachQueueErrorLogger(emitter: Worker, label: string): void;
export function attachQueueErrorLogger(emitter: Queue | Worker, label: string): void {
  const logger = new Logger(`BullMQ:${label}`);
  // كلا الصنفين يُصدر 'error' بحمولة Error واحدة — التحميل الزائد أعلاه
  // يفصل التوقيعين لأن TypeScript يرفض استدعاء .on() على نوع اتحاد
  // (تعارض تحميل QueueListener وWorkerListener الزائد)، لا لأن السلوك يختلف.
  (emitter as Queue).on('error', (e: Error) =>
    logger.error(`خطأ اتصال الطابور: ${e.message}`),
  );
}

/**
 * مهلات العروض كـ delayed jobs — تصمد أمام إعادة تشغيل الخادم،
 * بعكس setTimeout الذي كان سيترك الطلب عالقاً في SEARCHING للأبد.
 */
@Injectable()
export class DispatchQueue implements OnModuleDestroy {
  private queue = new Queue(DISPATCH_QUEUE_NAME, { connection: bullConnection() });

  constructor() {
    attachQueueErrorLogger(this.queue, DISPATCH_QUEUE_NAME);
  }

  async scheduleOfferTimeout(offerId: string, delayMs: number): Promise<void> {
    await this.queue.add(
      'offer-timeout',
      { offerId },
      { delay: delayMs, jobId: offerId, removeOnComplete: true, removeOnFail: true },
    );
  }

  /**
   * بدء التوزيع لطلب أُنشئ للتوّ — **خارج مسار طلب HTTP**.
   *
   * **لماذا:** كان المتحكّم ينتظر `dispatchOrder` كاملةً قبل الردّ، وهي
   * دورة ثقيلة: `ST_DWithin` على الفروع (١٠٥ms من ١٢٧ms محلياً)، ثم
   * تحميل الوكالات بجداولها ومحافظها وسائقيها، ثم ترشيح بستّة أوزان،
   * ثم عروض وإشعارات FCM. قياس staging أظهر وسيط **٣٢ ثانية** لطلب
   * ناجح تحت الحمل بينما CPU الحاويتين ٩٣–٩٩٪ والقاعدة عند اتصالين
   * نشطين — أي أن الزبون كان ينتظر حسابات لا قاعدة.
   *
   * **لا يضيع شيء:** المهمة في Redis تصمد أمام إعادة تشغيل الحاوية،
   * و`attempts: 3` يغطّي عطلاً عابراً. والزبون يعرف النتيجة عبر
   * `order:status` على Socket.IO — وهو ما تستمع له شاشة المتابعة
   * أصلاً، فلا شيء جديد يُضاف للعميل.
   *
   * `jobId` مشتقّ من معرّف الطلب: نداءان متزامنان لا ينشئان توزيعين
   * لنفس الطلب. بالشرطة لا بالنقطتين — BullMQ يرفض ':' في المعرّفات
   * المخصّصة (توافقاً مع مفاتيح المهام المتكررة)، وهو نفس السبب الموثَّق
   * عند `scheduleWaitJobs` أدناه.
   */
  async enqueueDispatch(orderId: string): Promise<void> {
    await this.queue.add(
      'dispatch-order',
      { orderId },
      {
        jobId: `dispatch-${orderId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        // الفاشلة تبقى للتشخيص: طلبٌ بلا توزيع سؤالٌ يُسأل
        removeOnFail: 500,
      },
    );
  }

  /** مهلة التعيين اليدوي — إن لم يعيّن موظف الوكالة سائقاً تُنقل لوكالة أخرى */
  async scheduleManualTimeout(
    orderId: string,
    agencyId: string,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(
      'manual-timeout',
      { orderId, agencyId },
      {
        delay: delayMs,
        // jobId فريد لكل (طلب، وكالة) — إعادة المحاولة مع وكالة أخرى تنشئ مهمة جديدة
        jobId: `manual:${orderId}:${agencyId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * مهلة رد الزبون على «نبحث لك عن سائق آخر؟» بعد انسحاب سائق لسبب يخصّه —
   * إن لم يردّ يُلغى الطلب. jobId ثابت لكل طلب: انسحاب سائق ثانٍ بعد أن
   * استأنف الزبون البحث يجدول مهلة جديدة، والقديمة انتهت أصلاً.
   */
  async scheduleRedispatchTimeout(orderId: string, delayMs: number): Promise<void> {
    await this.queue.add(
      'redispatch-timeout',
      { orderId },
      {
        delay: delayMs,
        jobId: `redispatch-${orderId}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * طابور انتظار سائق: كل التكات ومهلة الإلغاء تُجدول دفعة واحدة لحظة دخول
   * الطابور. الجدولة المسبقة تتجنب سباق إعادة الجدولة من داخل المعالج (jobId
   * مكرر ما دامت المهمة قيد التنفيذ) وتصمد أمام إعادة تشغيل الخادم.
   * كل تكة no-op إن لم يعد الطلب منتظراً.
   *
   * ملاحظة: BullMQ يرفض jobId فيه ':' إلا بجزأين اثنين بالضبط (توافق مع
   * المهام المتكررة القديمة) — لذا معرّفات هذه المهام بالشرطة لا بالنقطتين.
   */
  async scheduleWaitJobs(
    orderId: string,
    intervalMs: number,
    deadlineMs: number,
  ): Promise<void> {
    const ticks = Math.min(60, Math.max(0, Math.ceil(deadlineMs / intervalMs) - 1));
    for (let n = 1; n <= ticks; n++) {
      await this.queue.add(
        'wait-retry',
        { orderId },
        {
          delay: n * intervalMs,
          jobId: `wait-retry-${orderId}-${n}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
    await this.queue.add(
      'wait-timeout',
      { orderId },
      {
        delay: deadlineMs,
        jobId: `wait-end-${orderId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  onModuleDestroy() {
    return this.queue.close();
  }
}
