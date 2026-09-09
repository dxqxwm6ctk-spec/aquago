import { Queue } from 'bullmq';
import { execSync } from 'child_process';

/**
 * المرحلة 3.6 — BullMQ/العامل على Redis حقيقي وDocker حقيقي.
 *
 * يستعمل `handleOfferTimeout` الحقيقية عبر `offerId` وهمي (uuid عشوائي لا
 * يطابق أي صفّ حقيقي): `updateMany` تُطابق صفراً من الصفوف، فتعود الدالة
 * فوراً بلا أي أثر جانبي — لا بيانات عمل حقيقية تُلمس، لكن المسار الفعلي
 * (الطابور → العامل → DispatchService.handleOfferTimeout) يُختبَر حرفياً.
 */

const DISPATCH_QUEUE_NAME = 'dispatch-offers';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function bullConnection() {
  const url = new URL(REDIS_URL);
  return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null as null };
}

async function main() {
  const queue = new Queue(DISPATCH_QUEUE_NAME, { connection: bullConnection() });
  queue.on('error', () => undefined);

  // ---- 1) مهمة تمثيلية آمنة تُستهلَك فعلياً من العامل الحقيقي ----
  console.log('العامل الحقيقي يستهلك مهمة dispatch حقيقية (offerId وهمي — لا أثر بيانات):');
  const fakeOfferId = `phase3-fake-${Date.now()}`;
  const job = await queue.add(
    'offer-timeout',
    { offerId: fakeOfferId },
    { jobId: fakeOfferId, removeOnComplete: false, removeOnFail: false },
  );
  check('المهمة أُضيفت فعلياً إلى طابور Redis الحقيقي', !!job.id);

  // انتظار معالجتها من العامل الحقيقي — نتحقق من حالتها عبر BullMQ نفسها
  let finalState: string | null = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') { finalState = state; break; }
  }
  check('العامل الحقيقي عالج المهمة (completed)', finalState === 'completed',
        `الحالة النهائية: ${finalState}`);

  // ---- 2) الـAPI لا يستهلك — سجلّ الإقلاع نفسه يؤكد هذا صراحةً ----
  console.log('\nحاويتا API لا تستهلكان (سجلّ الإقلاع الحقيقي يؤكد ذلك):');
  // api2 من تراكب المرحلة 3 فقط — بلا -f الصريح لا يعرفه compose الأساسي
  const apiLogs = execSync(`docker compose -f docker-compose.yml -f docker-compose.portability.yml logs api api2`, {
    cwd: process.cwd() + '/..', encoding: 'utf8',
  });
  const noConsumeApi1 = /jordan_gas_api\s+\|.*ROLE=api — لا يُشغَّل مستهلك dispatch-offers/.test(apiLogs);
  const noConsumeApi2 = /jordan_gas_api2\s+\|.*ROLE=api — لا يُشغَّل مستهلك dispatch-offers/.test(apiLogs);
  check('API#1 يعلن صراحةً أنه لا يستهلك dispatch-offers', noConsumeApi1);
  check('API#2 يعلن صراحةً أنه لا يستهلك dispatch-offers', noConsumeApi2);

  // ---- 3) المهام المجدولة تُنشأ مرة واحدة فقط رغم حاويتَي API ----
  console.log('\nالمهام المجدولة — تسجيل واحد فقط رغم تشغيل حاويتَي API:');
  const schedulerQueue = new Queue('scheduled-jobs', { connection: bullConnection() });
  schedulerQueue.on('error', () => undefined);
  const repeatables = await schedulerQueue.getRepeatableJobs();
  const contractAlertsEntries = repeatables.filter((r) => r.name === 'contract-alerts');
  const subscriptionEntries = repeatables.filter((r) => r.name === 'subscription-cycle');
  check('contract-alerts مسجَّلة مرة واحدة فقط في Redis (لا مرتين رغم حاويتَي API)',
        contractAlertsEntries.length === 1, `عدد التسجيلات: ${contractAlertsEntries.length}`);
  check('subscription-cycle مسجَّلة مرة واحدة فقط في Redis',
        subscriptionEntries.length === 1, `عدد التسجيلات: ${subscriptionEntries.length}`);

  // ---- 4) إعادة تشغيل العامل لا تُفقد مهمة مؤجَّلة في الطابور ----
  console.log('\nإعادة تشغيل العامل لا تُفقد مهمة مؤجَّلة في Redis:');
  const delayedOfferId = `phase3-delayed-${Date.now()}`;
  await queue.add(
    'offer-timeout',
    { offerId: delayedOfferId },
    { jobId: delayedOfferId, delay: 15_000, removeOnComplete: false, removeOnFail: false },
  );
  const beforeRestart = await queue.getDelayedCount();
  check('المهمة المؤجَّلة موجودة في Redis قبل إعادة التشغيل', beforeRestart >= 1,
        `عدد المهام المؤجَّلة: ${beforeRestart}`);

  execSync('docker compose restart worker', { cwd: process.cwd() + '/..', stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 3000));

  const afterRestart = await queue.getDelayedCount();
  check('المهمة المؤجَّلة لا تزال موجودة بعد إعادة تشغيل العامل (Redis يحفظها لا الذاكرة)',
        afterRestart >= 1, `عدد المهام المؤجَّلة بعد إعادة التشغيل: ${afterRestart}`);

  // تنظيف: إزالة المهمة المؤجَّلة الاختبارية بدل انتظار 15 ثانية
  const delayedJob = await queue.getJob(delayedOfferId);
  if (delayedJob) await delayedJob.remove();

  console.log(`\n${pass} نجح، ${fail} فشل`);
  await queue.close();
  await schedulerQueue.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
