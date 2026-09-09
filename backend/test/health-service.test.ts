import Redis from 'ioredis';
import type { PrismaV2Service } from '../src/v2/database/prisma-v2.service';
import { HealthService } from '../src/v2/health/health.service';
import { MiniRedis } from './support/mini-redis';

/**
 * `HealthService` الحقيقية — Redis حقيقي (عبر MiniRedis، لا Postgres محلي
 * متاح). القاعدة مُمثَّلة بكائن أضيق يوفّر `$queryRaw` فقط — ما تستدعيه
 * HealthService فعلياً ولا شيء غيره — لا PrismaClient كاملاً، فالاختبار
 * تكاملي على Redis ومنطقي على القاعدة صراحة، لا يُخفى الفرق.
 *
 * الحكم الصحيح على هذا الاختبار: **Redis حقيقي، القاعدة محاكاة دقيقة
 * لسطح HealthService المستخدَم منها فقط.**
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function fakePrisma(behavior: 'ok' | 'throw'): PrismaV2Service {
  return {
    $queryRaw: async () => {
      if (behavior === 'throw') throw new Error('connection terminated unexpectedly');
      return [{ '?column?': 1 }];
    },
  } as unknown as PrismaV2Service;
}

async function main() {
  const mini = new MiniRedis();
  const port = await mini.start();
  const goodRedis = new Redis(`redis://127.0.0.1:${port}`);
  goodRedis.on('error', () => undefined);

  // ---- 1) كل شيء سليم — api role (بلا ROLE مضبوط = api افتراضياً) ----
  console.log('كل التبعيات سليمة (ROLE=api الافتراضي):');
  delete process.env.ROLE;
  const svcOk = new HealthService(fakePrisma('ok'), goodRedis);
  const r1 = await svcOk.readiness();
  check('ready = true', r1.ready === true);
  check('role = api (افتراضي بلا ROLE)', r1.role === 'api');
  check('database = ok', r1.checks.database === 'ok');
  check('redis = ok', r1.checks.redis === 'ok');
  check('latencyMs.database رقم غير سالب', typeof r1.latencyMs.database === 'number' && r1.latencyMs.database! >= 0);
  check('latencyMs.redis رقم غير سالب', typeof r1.latencyMs.redis === 'number' && r1.latencyMs.redis! >= 0);

  // ---- 2) ROLE=worker ينعكس في النتيجة ----
  console.log('\nROLE=worker:');
  process.env.ROLE = 'worker';
  const r2 = await svcOk.readiness();
  check('role = worker', r2.role === 'worker');
  check('نفس منطق الجاهزية يُطبَّق (ready = true)', r2.ready === true);
  delete process.env.ROLE;

  // ---- 3) القاعدة معطوبة — غير جاهز، وRedis لا يزال يُفحص باستقلالية ----
  console.log('\nالقاعدة معطوبة (Redis سليم):');
  const svcDbDown = new HealthService(fakePrisma('throw'), goodRedis);
  const r3 = await svcDbDown.readiness();
  check('ready = false', r3.ready === false);
  check('database = down', r3.checks.database === 'down');
  check('redis يبقى ok رغم عطل القاعدة (فحصان مستقلان)', r3.checks.redis === 'ok');
  check('لا latencyMs.database عند العطل (لا معنى لزمن استجابة فشل)',
        r3.latencyMs.database === undefined);

  // ---- 4) Redis معطوب — غير جاهز، والقاعدة تُفحص باستقلالية ----
  console.log('\nRedis معطوب (اتصال لمنفذ ميت):');
  const deadRedis = new Redis('redis://127.0.0.1:1', {
    retryStrategy: () => null, lazyConnect: true, connectTimeout: 300,
  });
  deadRedis.on('error', () => undefined);
  const svcRedisDown = new HealthService(fakePrisma('ok'), deadRedis);
  const r4 = await svcRedisDown.readiness();
  check('ready = false', r4.ready === false);
  check('redis = down', r4.checks.redis === 'down');
  check('database يبقى ok رغم عطل Redis', r4.checks.database === 'ok');

  // ---- 5) الاثنان معطوبان ----
  console.log('\nالقاعدة وRedis معاً معطوبان:');
  const svcBothDown = new HealthService(fakePrisma('throw'), deadRedis);
  const r5 = await svcBothDown.readiness();
  check('ready = false', r5.ready === false);
  check('database = down', r5.checks.database === 'down');
  check('redis = down', r5.checks.redis === 'down');

  console.log(`\n${pass} نجح، ${fail} فشل`);

  goodRedis.disconnect();
  deadRedis.disconnect();
  await mini.stop();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
