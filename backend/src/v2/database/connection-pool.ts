/**
 * حجم تجمّع اتصالات Prisma — صريح ومُشتَقّ من البيئة، لا افتراضياً ولا متخمَّناً.
 *
 * **لماذا هذا موجود:** كل عملية (API أو Worker) تُنشئ **عميلَي** Prisma
 * منفصلين — PrismaService (legacy) وPrismaV2Service (v2)، كلٌّ باتصاله
 * الخاص بقاعدة بياناته. بلا `connection_limit` صريح في رابط الاتصال،
 * يستعمل Prisma الصيغة الافتراضية `num_physical_cpus * 2 + 1` — على حاوية
 * DigitalOcean بمعالجين هذا يعني 5 اتصالات **لكل عميل**، أي 10 لكل عملية
 * (2 × 5)، أي 20 عبر حاويتَي API فقط، قبل أن يُحسب العامل أو الترحيل أو
 * أي عملية إدارية. القيمة الافتراضية تكبر مع نوى المعالج لا مع عدد
 * الحاويات — عكس ما نحتاجه فعلاً عند التوسّع أفقياً.
 *
 * **الحساب هنا صريح بدل ذلك:** حدٌّ أقصى معروف لقاعدة DigitalOcean
 * المُدارة (`DB_MAX_CONNECTIONS`)، مقسوماً على عدد العمليات المتوقَّع
 * (`API_INSTANCE_COUNT` + `WORKER_INSTANCE_COUNT`)، مع هامش محجوز صراحة
 * لاتصالات الترحيل ولوحة الإدارة المُدارة (`DB_RESERVED_CONNECTIONS`) —
 * لا خطوة سرّية، بل رقمٌ يظهر في السجلّ عند كل إقلاع.
 *
 * **التوسّع من حاويتين إلى أكثر:** رفع `API_INSTANCE_COUNT` عند إضافة
 * حاوية API ثالثة يُنقص نصيب كل عملية تلقائياً بدل أن يُترك على القيمة
 * القديمة فيُغرق القاعدة اتصالاتٍ لم تعد الحسابات تفترضها.
 */

export interface PoolPlan {
  /** الحد الأقصى لاتصالات القاعدة المُدارة (كل الأدوار مجتمعة) */
  dbMaxConnections: number;
  /** محجوزة لأدوات لا تمرّ بهذا الحساب: هجرات، psql يدوي، لوحة المزوّد */
  reservedConnections: number;
  apiInstances: number;
  workerInstances: number;
  /** لكل عملية عميلا Prisma (legacy + v2) — كلٌّ يأخذ نصيبه من حصة العملية */
  clientsPerProcess: number;
  /** نصيب اتصالات كل عملية واحدة من الحصة القابلة للتوزيع */
  connectionsPerProcess: number;
  /** نصيب كل عميل Prisma داخل العملية — هذا ما يُكتب في connection_limit */
  connectionLimitPerClient: number;
}

// PrismaService (legacy) + PrismaV2Service — القيمة تُبقي هامشاً محافظاً
// حتى لو لم يتصل أحد العميلين فعلياً في لحظة معيّنة. تحقّقٌ فعلي بالمرحلة
// 3.8 على Docker Compose أظهر أن PrismaService لا يُستورَد فعلياً في
// AppModule الحالية (النظام القديم أُزيل بالكامل — pg_stat_activity على
// قاعدة jordan_gas الحقيقية سجّل صفر اتصالات تطبيقية) فالعميل الفعلي
// الوحيد اليوم هو PrismaV2Service. الثابت هنا يبقى 2 عمداً لا 1: لو
// أُعيد تفعيل النظام القديم يوماً أو أُعيد استيراد PrismaService لأي
// سبب، لا يصبح الحساب فجأة متفائلاً بحصة ضعف ما تحتمله القاعدة فعلاً.
const CLIENTS_PER_PROCESS = 2;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name}=${raw} غير صالح — يجب أن يكون عدداً صحيحاً موجباً`);
  }
  return n;
}

/** أول اسم معرَّف من بين عدة أسماء، أو undefined إن لم يُعرَّف أيٌّ منها */
function envIntOptional(...names: string[]): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${name}=${raw} غير صالح — يجب أن يكون عدداً صحيحاً موجباً`);
    }
    return n;
  }
  return undefined;
}

/**
 * الخطة الكاملة — تُحسب من متغيرات البيئة فقط، بلا اتصال بأي شيء.
 * قابلة للاستدعاء من الاختبارات بأي تركيبة env بلا قاعدة حقيقية.
 */
export function computePoolPlan(): PoolPlan {
  // **الافتراضي 22 لا 500 عمداً — الاتجاه الآمن للخطأ.**
  //
  // كان 500، وهو رقمٌ لا تعطيه أي خطة DigitalOcean دون 32 GiB: الخطط
  // الفعلية 22 (1 GiB) و47 (2 GiB) و97 (4 GiB) و197 (8 GiB). افتراضٌ
  // أعلى من الحقيقة يوزّع اتصالات لا تملكها القاعدة، فتُرفض الاتصالات
  // عند الحمل — وهو عطل يظهر تحت الضغط تحديداً، أي في أسوأ وقت. أما
  // الافتراض الأدنى فأثره تقييد الإنتاجية وحده: بطءٌ مرئي وقابل للقياس
  // بدل رفضٍ مفاجئ.
  //
  // 22 هو حدّ أصغر خطة مُدارة — أي أن القيمة الافتراضية آمنة على أي
  // خطة مهما صغرت. القيمة الحقيقية تُضبط من `DB_MAX_CONNECTIONS` بعد
  // قراءتها من القاعدة نفسها (`SHOW max_connections;`)، لا من وثيقة:
  // صورة PostGIS المحلية أعلنت 100 بينما كان الافتراض 500.
  // انظر deployment/database-plan.md.
  const dbMaxConnections = envInt('DB_MAX_CONNECTIONS', 22);
  // هجرة تعمل يدوياً + psql عرضي + مراقبة المزوّد.
  //
  // **الافتراضي نسبةٌ لا رقم ثابت:** 20 اتصالاً محجوزاً معقولةٌ على خطة
  // 97 اتصالاً، لكنها تبتلع 91% من خطة 22 فلا يبقى ما يُوزَّع — والحارس
  // أدناه يرمي، أي أن التركيبة الافتراضية بحدّها الافتراضي كانت **تمنع
  // الإقلاع**. وهذا أسوأ من رقم خاطئ: العطل يقع عند كل إقلاع بلا ضبط.
  // الربع (بحدّ أدنى 4 وأقصى 20) يبقى معقولاً على امتداد الخطط كلها.
  const reservedConnections = envInt(
    'DB_RESERVED_CONNECTIONS',
    Math.min(20, Math.max(4, Math.floor(dbMaxConnections / 4))),
  );
  const apiInstances = envInt('API_INSTANCE_COUNT', 2);
  const workerInstances = envInt('WORKER_INSTANCE_COUNT', 1);

  const totalProcesses = apiInstances + workerInstances;
  const distributable = dbMaxConnections - reservedConnections;
  if (distributable <= totalProcesses * CLIENTS_PER_PROCESS) {
    throw new Error(
      `DB_MAX_CONNECTIONS=${dbMaxConnections} لا يكفي: بعد حجز ${reservedConnections} ` +
        `يبقى ${distributable} اتصالاً لـ${totalProcesses} عملية (${CLIENTS_PER_PROCESS} عميل لكل ` +
        `عملية) — أقل من اتصال واحد للعميل. ارفع DB_MAX_CONNECTIONS أو رقِّ خطة القاعدة، ` +
        'أو أنقص API_INSTANCE_COUNT/WORKER_INSTANCE_COUNT.',
    );
  }

  const connectionsPerProcess = Math.floor(distributable / totalProcesses);
  // `DATABASE_POOL_SIZE` (أو `DATABASE_CONNECTION_LIMIT`) تتجاوز الحساب
  // كلياً: بعض المزوّدين المُدارين يفرضون حدّاً لكل مستخدم لا لكل خادم،
  // أو يوصون برقم بعينه لخطتهم — وفي تلك الحالة الحساب المشتقّ تخمينٌ
  // مقابل رقمٍ معروف. القيمة الصريحة تُحترم كما هي، ويظهر أثرها في سطر
  // السجلّ عند الإقلاع فلا تصير قيمة خفيّة.
  const override = envIntOptional('DATABASE_POOL_SIZE', 'DATABASE_CONNECTION_LIMIT');
  const connectionLimitPerClient =
    override ?? Math.max(1, Math.floor(connectionsPerProcess / CLIENTS_PER_PROCESS));

  return {
    dbMaxConnections,
    reservedConnections,
    apiInstances,
    workerInstances,
    clientsPerProcess: CLIENTS_PER_PROCESS,
    connectionsPerProcess,
    connectionLimitPerClient,
  };
}

/**
 * يضيف `connection_limit` وpool_timeout وconnect_timeout إلى رابط اتصال —
 * يحترم أي قيمة موضوعة مسبقاً في الرابط نفسه ولا يكتب فوقها، فمن يريد
 * ضبطاً يدوياً دقيقاً لعميل بعينه يبقى قادراً على تجاوز الحساب التلقائي.
 *
 * `connect_timeout` تحديداً — لا رفاهية: بلا حدّ صريح، محاولة `$connect()`
 * ضد قاعدة غير قابلة للوصول (شبكة خاصة لم تُحلّ بعد، خطأ إعداد) تنتظر
 * مهلة TCP الافتراضية لنظام التشغيل، وهذه قد تمتد دقائق. عملية إقلاعها
 * معلَّق على هذا الاتصال تبدو حيّة لـDocker (لم تُغلق بعد) بينما هي
 * فعلياً عالقة — أسوأ حالة لفحص جاهزية يُفترض أن يكتشف هذا العطل بعينه.
 */
export function withPoolParams(url: string, limit: number): string {
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) {
    u.searchParams.set('connection_limit', String(limit));
  }
  if (!u.searchParams.has('pool_timeout')) {
    // 10s لا الافتراضي (10s أيضاً في Prisma الحديث، لكن صراحةً هنا حتى
    // تتضح النية عند قراءة الرابط في السجلّ لا الرجوع لوثائق Prisma)
    u.searchParams.set('pool_timeout', '10');
  }
  if (!u.searchParams.has('connect_timeout')) {
    u.searchParams.set('connect_timeout', '5');
  }
  return u.toString();
}

/** رسالة سجلّ واحدة تلخّص الخطة — تُطبع مرة عند إقلاع كل عملية */
export function describePoolPlan(plan: PoolPlan): string {
  return (
    `تجمّع الاتصالات: ${plan.dbMaxConnections} إجمالي، ${plan.reservedConnections} محجوزة، ` +
    `${plan.apiInstances} API + ${plan.workerInstances} Worker = ${plan.apiInstances + plan.workerInstances} عملية، ` +
    `${plan.connectionsPerProcess} اتصال/عملية، ${plan.connectionLimitPerClient} اتصال/عميل Prisma ` +
    `(${plan.clientsPerProcess} عميل لكل عملية)`
  );
}
