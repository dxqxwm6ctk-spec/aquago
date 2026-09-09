import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * `health-cli.js` المُصرَّف فعلياً — لا نظير الكود المصدري.
 *
 * يثبّت خللاً حقيقياً وُجد أثناء البناء: النسخة الأولى استعملت
 * `process.exitCode = ...` بدل `process.exit(...)`، فانتظر Node تفريغ
 * حلقة الحدث طبيعياً بعد الفشل — وioredis يُبقي مؤقّتات إعادة محاولة
 * داخلية حيّة نحو ثانيتين حتى بعد `disconnect()` الظاهري، فامتدّ فحصٌ
 * يُفترض أن يستغرق ~2.5s (مهلة Prisma الفعلية) إلى أكثر من 4.4s — قريباً
 * جداً من `HEALTHCHECK --timeout` في Dockerfile، وكان سيتجاوزه أحياناً
 * تحت حِمل حقيقي فيبدو العامل "غير صحّي" بمعزل عن حالة تبعياته الفعلية.
 *
 * الاختبار يُشغّل dist/src/v2/health/health-cli.js **كعملية منفصلة
 * حقيقية** (execFile لا استيراد) ضد قاعدة وRedis غير موجودين، ويقيس
 * الزمن الفعلي — لا افتراضاً نظرياً عن سلوك Node.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

async function main() {
  const cliPath = join(__dirname, '..', 'dist', 'src', 'v2', 'health', 'health-cli.js');
  if (!existsSync(cliPath)) {
    console.log('  تخطّي — dist/ غير مبني. شغّل `npm run build` أولاً.');
    return 0;
  }

  console.log('health-cli.js ضد قاعدة وRedis ميتين (عملية حقيقية منفصلة):');
  const start = Date.now();
  let exitCode = 0;
  let stdout = '';
  try {
    const r = await execFileAsync('node', [cliPath], {
      env: {
        ...process.env,
        DATABASE_URL_V2: 'postgresql://ci:ci@127.0.0.1:1/ci_v2',
        REDIS_URL: 'redis://127.0.0.1:1',
        ROLE: 'worker',
      },
      timeout: 10_000, // حزام أمان للاختبار نفسه — لا يجوز أن يُعلَّق CI
    });
    stdout = r.stdout;
  } catch (e) {
    // execFile يرمي عند رمز خروج غير صفري — متوقَّع هنا (النتيجة "غير جاهز")
    const err = e as { code?: number; stdout?: string; killed?: boolean };
    exitCode = err.code ?? 1;
    stdout = err.stdout ?? '';
    check('لم تُقتل العملية بمهلة execFile (10s) — لم تعلّق', !err.killed);
  }
  const elapsedMs = Date.now() - start;

  check('رمز الخروج 1 (غير جاهز، لا خطأ غير متوقَّع)', exitCode === 1,
        `فعلياً ${exitCode}`);
  check('طُبعت نتيجة JSON صالحة', (() => {
    try { JSON.parse(stdout.trim().split('\n').pop() || ''); return true; }
    catch { return false; }
  })());
  check(
    'ينتهي خلال 4 ثوانٍ — لا التعليق القديم (كان يتجاوز 4.4s فعلياً)',
    elapsedMs < 4000,
    `استغرق ${elapsedMs}ms`,
  );
  console.log(`  (الزمن الفعلي: ${elapsedMs}ms)`);

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
