/**
 * حساب خطة تجمّع الاتصالات — منطق محض، بلا قاعدة ولا Prisma حقيقي.
 * كل حالة تضبط متغيرات البيئة ثم تستورد الوحدة من جديد (الدالة تقرأ
 * `process.env` عند كل استدعاء، لا عند التحميل، فإعادة الاستيراد غير
 * ضرورية فعلياً — لكن الفصل هنا يبقي كل حالة مستقلة القراءة).
 */
import { computePoolPlan, describePoolPlan, withPoolParams } from '../src/v2/database/connection-pool';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function main() {
  console.log('الوضع الافتراضي — لا متغيرات بيئة مضبوطة:');
  withEnv(
    { DB_MAX_CONNECTIONS: undefined, DB_RESERVED_CONNECTIONS: undefined,
      API_INSTANCE_COUNT: undefined, WORKER_INSTANCE_COUNT: undefined },
    () => {
      const plan = computePoolPlan();
      // 22 = حدّ أصغر خطة DigitalOcean مُدارة. الافتراض الأعلى من الحقيقة
      // يوزّع اتصالات لا تملكها القاعدة فتُرفض عند الحمل؛ الأدنى يقيّد
      // الإنتاجية وحدها. الاتجاه الآمن للخطأ هو الأدنى.
      check('الافتراضي: 22 اتصالاً (أصغر خطة مُدارة)', plan.dbMaxConnections === 22,
            `فعلياً ${plan.dbMaxConnections}`);
      // المحجوز نسبةٌ لا رقم ثابت: 20 على خطة 22 تبتلع 91% فلا يبقى
      // ما يُوزَّع — والحارس يرمي، أي أن الافتراضات وحدها تمنع الإقلاع.
      check('الافتراضي: المحجوز ربع الحدّ (5 من 22)', plan.reservedConnections === 5,
            `فعلياً ${plan.reservedConnections}`);
      check('الافتراضي: 2 API + 1 Worker', plan.apiInstances === 2 && plan.workerInstances === 1);
      // (22-5)/3 = 5 لكل عملية → 5/2 = 2 لكل عميل
      check('5 اتصالات لكل عملية', plan.connectionsPerProcess === 5,
            `فعلياً ${plan.connectionsPerProcess}`);
      check('اتصالان لكل عميل Prisma', plan.connectionLimitPerClient === 2,
            `فعلياً ${plan.connectionLimitPerClient}`);
    },
  );

  console.log('\nالافتراضات وحدها لا تمنع الإقلاع — على أي خطة:');
  // الانحدار الذي وقع فعلاً أثناء التطوير: DB_MAX_CONNECTIONS=22 مع
  // محجوز ثابت 20 يترك 2 اتصالاً لثلاث عمليات، فيرمي الحارس عند كل
  // إقلاع. تركيبةٌ افتراضية لا تقلع أسوأ من رقم خاطئ يقلع.
  for (const max of [22, 47, 97, 197]) {
    let plan: ReturnType<typeof computePoolPlan> | undefined;
    let err = '';
    try {
      plan = withEnv(
        { DB_MAX_CONNECTIONS: String(max), DB_RESERVED_CONNECTIONS: undefined },
        computePoolPlan,
      );
    } catch (e) { err = (e as Error).message; }
    check(`خطة ${max} اتصالاً تقلع بلا ضبط يدوي`,
          plan !== undefined && plan.connectionLimitPerClient >= 1, err);
  }

  console.log('\nالتوسّع من 2 إلى 4 حاويات API — يقلّ نصيب كل عملية:');
  const plan2 = withEnv({ API_INSTANCE_COUNT: '2', WORKER_INSTANCE_COUNT: '1' }, computePoolPlan);
  const plan4 = withEnv({ API_INSTANCE_COUNT: '4', WORKER_INSTANCE_COUNT: '1' }, computePoolPlan);
  check('4 حاويات API تعني نصيباً أقل لكل عملية من حاويتين',
        plan4.connectionLimitPerClient < plan2.connectionLimitPerClient,
        `2→${plan2.connectionLimitPerClient}, 4→${plan4.connectionLimitPerClient}`);
  check('لا تجاوز الحد الإجمالي مهما زاد العدد',
        plan4.connectionLimitPerClient * plan4.clientsPerProcess *
          (plan4.apiInstances + plan4.workerInstances) + plan4.reservedConnections
          <= plan4.dbMaxConnections);

  console.log('\nقيمة بيئة غير صالحة:');
  let threwOnZero = false;
  try { withEnv({ API_INSTANCE_COUNT: '0' }, computePoolPlan); }
  catch { threwOnZero = true; }
  check('API_INSTANCE_COUNT=0 يرمي (لا عملية = لا معنى للحساب)', threwOnZero);

  let threwOnNonNumeric = false;
  try { withEnv({ DB_MAX_CONNECTIONS: 'abc' }, computePoolPlan); }
  catch { threwOnNonNumeric = true; }
  check('قيمة غير رقمية ترمي بدل NaN صامت', threwOnNonNumeric);

  console.log('\nخطة مستحيلة — قاعدة صغيرة جداً لعدد العمليات المطلوب:');
  let threwOnImpossible = false;
  try {
    withEnv(
      { DB_MAX_CONNECTIONS: '10', DB_RESERVED_CONNECTIONS: '5',
        API_INSTANCE_COUNT: '10', WORKER_INSTANCE_COUNT: '5' },
      computePoolPlan,
    );
  } catch { threwOnImpossible = true; }
  check('حصة أقل من عميل واحد ترمي برسالة توجيهية بدل صفر صامت', threwOnImpossible);

  console.log('\nwithPoolParams:');
  const url1 = withPoolParams('postgresql://u:p@host:5432/db?schema=public', 42);
  check('يضيف connection_limit', url1.includes('connection_limit=42'));
  check('يضيف pool_timeout', url1.includes('pool_timeout=10'));
  check('يحافظ على المعامل الأصلي (schema)', url1.includes('schema=public'));

  const urlWithLimit = withPoolParams(
    'postgresql://u:p@host:5432/db?connection_limit=5', 42,
  );
  check('لا يكتب فوق connection_limit موضوع يدوياً',
        urlWithLimit.includes('connection_limit=5') && !urlWithLimit.includes('connection_limit=42'));

  console.log('\ndescribePoolPlan:');
  const desc = describePoolPlan(withEnv({}, computePoolPlan));
  check('الوصف نص غير فارغ يذكر الأرقام', desc.length > 20 && /\d/.test(desc));

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

const failed = main();
console.log(failed ? 'النتيجة: فشل' : 'النتيجة: نجاح');
process.exit(failed ? 1 : 0);
