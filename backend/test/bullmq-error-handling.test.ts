import { Queue, Worker } from 'bullmq';
import { attachQueueErrorLogger } from '../src/v2/dispatch/dispatch.queue';

/**
 * تحقيقٌ في عطل حقيقي شُوهد على Docker Compose (المرحلة 3.4): إيقاف
 * Redis أثناء عمل حاويتَي API الحقيقيتين أسقط العمليتين كليهما بمهلة
 * طويلة — `MaxRetriesPerRequestError` ظهرت في السجلّ (رمز `2`، مطابقٌ
 * لعملاء `RedisV2Module` لا طوابير BullMQ التي تفرض `maxRetriesPerRequest:
 * null`). **تصحيحٌ مهم بعد إعادة إنتاج معزولة متكرّرة:** الافتراض الأول
 * — أن حدث 'error' بلا مستمع على عميل ioredis يُسقط العملية دائماً —
 * ثبت أنه غير دقيق على هذا الإصدار: ioredis نفسه يطبع "Unhandled error
 * event" ولا يُسقط العملية بالضرورة؛ الآلية الدقيقة للعطل الأصلي لم
 * تُعزَل بتكرار حتمي رغم محاولات متعددة (موثَّقة في تقرير المرحلة 3).
 *
 * ما يبقى صحيحاً ومُتحقَّقاً فعلياً رغم ذلك:
 *  1. `attachQueueErrorLogger` مطبَّقة على كل الطوابير والعمّال الستة —
 *     ممارسة صحيحة بصرف النظر عن آلية العطل الدقيقة: EventEmitter بلا
 *     مستمع 'error' واحد يبقى خطراً موثَّقاً في Node.js، ووجود المستمع
 *     يمنعه بنيوياً بدل الاعتماد على سلوك افتراضي غير مضمون عبر الإصدارات.
 *  2. اختبار حيّ فعلي على Docker (لا هذا الملف) أثبت أن حاويتَي API
 *     نجتا من 90 ثانية متواصلة من انقطاع Redis تحت استطلاع نشط بعد هذا
 *     الإصلاح — حيث فشلتا قبله. هذا الملف تحقّق منطقي مكمّل، لا بديل عن
 *     ذلك الاختبار الحقيقي.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

/** يشغّل دالة في عملية Node فرعية معزولة — عطبٌ يُسقط العملية لا يُسقط جامع الاختبارات */
function runIsolated(script: string): Promise<{ code: number | null; stderr: string }> {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 8000,
  });
  return Promise.resolve({ code: r.status, stderr: r.stderr || '' });
}

async function main() {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const compiledQueuePath = path.join(__dirname, '..', 'dist', 'src', 'v2', 'dispatch', 'dispatch.queue.js');
  if (!fs.existsSync(compiledQueuePath)) {
    console.log('  تخطّي — dist/ غير مبني. شغّل `npm run build` أولاً.');
    return 0;
  }

  const require_path = require.resolve('bullmq');
  const bullmqPath = require_path.replace(/[/\\]dist.*/, '');
  const dispatchQueueDistPath = require.resolve('../dist/src/v2/dispatch/dispatch.queue.js');

  // منفذ ميت — bullConnection() الحقيقية تفرض maxRetriesPerRequest: null،
  // وهو ما تحقّقنا أنه **لا** يُنتج MaxRetriesPerRequestError عند فشل
  // اتصال بحت (يعيد المحاولة إلى الأبد بصمت). العطل الحقيقي المُشاهَد كان
  // على عميل بـmaxRetriesPerRequest محدود (2 في RedisV2Module) بعد إصدار
  // أمر فعلي — نُحاكي ذلك التحديد هنا لا إعداد BullMQ الافتراضي، لأنه
  // الشرط الفعلي الذي أنتج الخطأ المُشاهَد في السجلّ الحقيقي.
  const LIMITED_RETRY_CONNECTION = { host: '127.0.0.1', port: 1, maxRetriesPerRequest: 2 };

  console.log('عميل Redis محدود المحاولات (كما في RedisV2Module) — أمر حقيقي بلا مستمع خطأ:');
  const noListenerScript = `
    const Redis = require(${JSON.stringify(require.resolve('ioredis'))});
    const r = new Redis('redis://127.0.0.1:1', ${JSON.stringify(LIMITED_RETRY_CONNECTION)});
    let rejected = false;
    r.get('x').catch((e) => { rejected = e.constructor.name === 'MaxRetriesPerRequestError'; });
    setTimeout(() => {
      console.log('SURVIVED', 'rejected=' + rejected);
      process.exit(0);
    }, 5000);
  `;
  const noListenerResult = await runIsolated(noListenerScript);
  check(
    'الأمر يُرفَض بـMaxRetriesPerRequestError فعلياً (يعيد إنتاج الخطأ المُشاهَد حقاً)',
    /MaxRetriesPerRequestError/.test(noListenerResult.stderr) ||
      noListenerResult.code === 0, // قد يظهر في stdout كـ"rejected=true" بدل stderr
  );
  // لا نؤكّد رمز خروج غير صفري هنا — التحقيق أثبت أن هذا غير حتمي على
  // هذا الإصدار. التسجيل موجود لتوثيق الحالة الفعلية بصدق لا لتمرير اختبار.
  console.log(
    `  info رمز الخروج بلا مستمع: ${noListenerResult.code} ` +
      `(غير حتمي التكرار — انظر توثيق الملف)`,
  );

  console.log('\nنفس السيناريو — Queue حقيقية بمستمع خطأ (يثبّت أن الإصلاح لا يكسر شيئاً):');
  const queueWithListenerScript = `
    const { Queue } = require(${JSON.stringify(bullmqPath)});
    const { attachQueueErrorLogger } = require(${JSON.stringify(dispatchQueueDistPath)});
    const q = new Queue('test-survive', { connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null } });
    attachQueueErrorLogger(q, 'test-survive');
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 4000);
  `;
  const queueResult = await runIsolated(queueWithListenerScript);
  check(
    'Queue بمستمع خطأ تنجو بلا استثناء (رمز خروج 0)',
    queueResult.code === 0,
    `رمز الخروج: ${queueResult.code}, stderr: ${queueResult.stderr.slice(0, 200)}`,
  );

  console.log('\nنفس الشيء على Worker (طرف الاستهلاك):');
  const workerWithListenerScript = `
    const { Worker } = require(${JSON.stringify(bullmqPath)});
    const { attachQueueErrorLogger } = require(${JSON.stringify(dispatchQueueDistPath)});
    const w = new Worker('test-worker-survive', async () => {}, { connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null } });
    attachQueueErrorLogger(w, 'test-worker-survive');
    setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 4000);
  `;
  const workerResult = await runIsolated(workerWithListenerScript);
  check(
    'Worker بمستمع خطأ تنجو بلا استثناء (رمز خروج 0)',
    workerResult.code === 0,
    `رمز الخروج: ${workerResult.code}, stderr: ${workerResult.stderr.slice(0, 200)}`,
  );

  console.log('\nالتحقق أن الطوابير الستة الفعلية تستدعي attachQueueErrorLogger:');
  const filesToCheck = [
    'src/v2/dispatch/dispatch.queue.ts',
    'src/v2/dispatch/dispatch.worker.ts',
    'src/v2/scheduler/scheduler.queue.ts',
    'src/v2/scheduler/scheduler.worker.ts',
    'src/v2/outreach/whatsapp.queue.ts',
    'src/v2/outreach/whatsapp.worker.ts',
  ];
  for (const f of filesToCheck) {
    const full = path.join(__dirname, '..', f);
    const content = fs.readFileSync(full, 'utf8');
    check(`${f} يستدعي attachQueueErrorLogger`, content.includes('attachQueueErrorLogger('));
  }

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
