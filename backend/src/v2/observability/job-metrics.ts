import type { Worker } from 'bullmq';
import { MetricsService } from './metrics.service';

/**
 * مقياسٌ واحدٌ للمهام تشترك فيه العملية كلها.
 *
 * **لماذا مفردة على مستوى الوحدة لا حقنة DI:** عمّال BullMQ الثلاثة
 * يُنشَؤون داخل `onModuleInit` في وحدات لا تعرف المراقبة ولا يجوز أن
 * تعرفها. حقن `MetricsService` فيها يعني تعديل ثلاثة مُنشئات وثلاث وحدات
 * لأجل عدّاد. والأهم: العامل عملية بلا HTTP — لا `/api/metrics` فيه أصلاً،
 * فالحقن يضيف اعتمادية لقراءةٍ لا تحدث.
 *
 * ما يُقرأ فعلاً في عملية العامل هو **عمق الطوابير** من Redis، وهو مشترك
 * بين العمليات كلها ويُقرأ من الـAPI (انظر `queue-depth.service.ts`).
 * أما هذه العدّادات فتصف «ما فعلته هذه العملية»، وتظهر حين يعرض العامل
 * مقاييسه — واليوم قيمتها في تسجيل الفشل، وهو ما يصل السجلّ حتماً.
 */
let sink: MetricsService | undefined;

/** يربط العدّادات بخدمة المقاييس — يُستدعى مرة عند إقلاع العملية */
export function bindJobMetrics(metrics: MetricsService): void {
  sink = metrics;
}

/** للاختبار: يعيد الحالة إلى ما قبل الربط */
export function resetJobMetrics(): void {
  sink = undefined;
}

/**
 * يعدّ نتائج مهام عاملٍ واحد.
 *
 * لا يستبدل مسجّلات `failed` القائمة في العمّال الثلاثة — يضيف إليها.
 * تلك تكتب *لماذا* فشلت المهمة بعينها (رسالة الخطأ ومعرّف المهمة)، وهذه
 * تجيب «كم فشلت؟» — وهو السؤال الذي يبني عليه التنبيه عتبةً، إذ لا
 * تُبنى عتبة على نصّ رسالة.
 */
export function instrumentJobOutcomes(
  worker: Worker,
  queue: string,
  /**
   * ما لا يُعدّ فشلاً رغم وصوله بحدث `failed`. طابور واتساب يؤجّل المهمة
   * عمداً برمي `DelayedError` — وهو تدفّق طبيعي لا عطل. عدّه فشلاً يجعل
   * التنبيه يشتعل من حملةٍ تسير كما صُمّمت تماماً، وتنبيهٌ يكذب مرةً
   * يُتجاهَل بعدها دائماً.
   */
  ignoreFailure?: (err: Error) => boolean,
): void {
  worker.on('completed', () => sink?.recordJob(queue, 'completed'));
  worker.on('failed', (_job, err) => {
    if (err && ignoreFailure?.(err)) return;
    sink?.recordJob(queue, 'failed');
  });
}
