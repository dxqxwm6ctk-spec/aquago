/**
 * ترقيم الطلبات تحت التزامن — حارس ضدّ عودة الاختناق المقيس.
 *
 * **متطلبات التشغيل:** حزمة Docker المحلية عاملة (db على الأقل).
 *
 * ما يُثبته هذا الملف ثلاثة أشياء، كلها انكسرت فعلاً أو كادت:
 *
 *   ١. `nextval` **لا يقفل**: جلستان متزامنتان تأخذان رقمين دون أن تنتظر
 *      إحداهما الأخرى. هذا جوهر الإصلاح — قياس DigitalOcean أظهر انتظار
 *      قفل يبلغ تسع ثوانٍ على `OrderCounter(id=1)` لأن الصفّ كان يبقى
 *      مقفلاً حتى نهاية معاملة الإنشاء كلها.
 *
 *   ٢. **لا رقمين متطابقين** مهما بلغ التزامن.
 *
 *   ٣. **التراجع لا يعيد الرقم** — وهذا مقصود لا عيب: التسلسل المتّصل
 *      تماماً يتطلب بالضبط القفل الذي أزلناه. نثبته صراحةً حتى لا يظنّه
 *      أحدٌ لاحقاً عطلاً فيعيد القفل.
 */
// عميل Prisma المولَّد لا `pg`: الأخير ليس تبعية للمشروع، وإضافته لأجل
// اختبار وحده توسيعٌ لسطح الاعتماد بلا داعٍ — وPrisma يفتح اتصالات مستقلة
// تكفي لإثبات التزامن.
import { URL as URL_ } from 'node:url';
import { PrismaClient } from '@prisma-v2/client';

const URL = process.env.DATABASE_URL_V2
  || 'postgresql://gas:gas_secret@localhost:5433/jordan_gas_v2?schema=public';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

/**
 * كل عميل اتصالٌ مستقل — وهو ما يجعل التزامن حقيقياً لا متسلسلاً.
 *
 * `connection_limit=2` مقصود: بلا سقف يفتح كل عميل تجمّعاً بحجم
 * (عدد الأنوية × 2 + 1)، فعشرون عميلاً يستنفدون اتصالات القاعدة
 * (`FATAL: sorry, too many clients already`) — وهو عطل أدواتٍ لا نتيجة
 * اختبار. اتصالان لكل عميل يكفيان لإثبات التزامن ويتركان هامشاً.
 */
async function conn() {
  const u = new URL_(URL);
  u.searchParams.set('connection_limit', '2');
  u.searchParams.set('pool_timeout', '20');
  const c = new PrismaClient({ datasources: { db: { url: u.toString() } } });
  await c.$connect();
  return c;
}

async function main() {
  const setup = await conn();
  await setup.$executeRawUnsafe(`
    DO $$ BEGIN
      IF to_regclass('order_code_seq') IS NULL THEN
        CREATE SEQUENCE order_code_seq AS bigint START WITH 1 MINVALUE 1;
      END IF;
    END $$;`);

  console.log('\n— ١) nextval لا يقفل عبر المعاملات —');
  // الجوهر: جلسة تفتح معاملة وتأخذ رقماً ثم **تبقيها مفتوحة**. الجلسة
  // الثانية يجب أن تأخذ رقمها فوراً. بالعدّاد الصفّي القديم كانت تنتظر
  // انتهاء الأولى — وهو ما شلّ الإنشاء تحت الحمل.
  const a = await conn(), b = await conn();
  // لا BEGIN صريح: نفتح معاملة تفاعلية تبقى مفتوحة أثناء قياس الجلسة الأخرى
  let n1 = '';
  let waited = 0;
  let n2 = '';
  await a.$transaction(async (tx) => {
    const [x] = await tx.$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n");
    n1 = String(x.n);
    // المعاملة ما زالت مفتوحة هنا — الجلسة الثانية يجب ألّا تنتظرها
    const t0 = Date.now();
    const [y] = await b.$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n");
    waited = Date.now() - t0;
    n2 = String(y.n);
    throw new Error('rollback-on-purpose');
  }).catch((e: Error) => { if (e.message !== 'rollback-on-purpose') throw e; });
  const r1 = { rows: [{ n: n1 }] }; const r2 = { rows: [{ n: n2 }] };
  check('الجلسة الثانية لا تنتظر معاملة مفتوحة', waited < 500, `${waited}ms`);
  check('الرقمان مختلفان', String(r1.rows[0].n) !== String(r2.rows[0].n),
    `${r1.rows[0].n} vs ${r2.rows[0].n}`);

  console.log('\n— ٢) التراجع لا يعيد الرقم (مقايضة مقصودة) —');
  const c = await conn();
  let beforeN = 0n;
  await c.$transaction(async (tx) => {
    const [x] = await tx.$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n");
    beforeN = x.n;
    throw new Error('rollback-on-purpose');
  }).catch((e: Error) => { if (e.message !== 'rollback-on-purpose') throw e; });
  const [afterRow] = await c.$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n");
  const before = { rows: [{ n: beforeN }] }; const after = { rows: [{ n: afterRow.n }] };
  check('الرقم بعد التراجع أكبر لا مُعاد',
    Number(after.rows[0].n) > Number(before.rows[0].n));
  await c.$disconnect();

  console.log('\n— ٣) مئتا طلب متزامن: لا تكرار —');
  const N = 200;
  const clients = await Promise.all(Array.from({ length: 10 }, () => conn()));
  const start = Date.now();
  const nums = (await Promise.all(
    Array.from({ length: N }, (_, i) =>
      clients[i % clients.length]
        .$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n")
        .then((r) => String(r[0].n))),
  ));
  const elapsed = Date.now() - start;
  const unique = new Set(nums);
  check(`${N} رقماً بلا تكرار`, unique.size === N, `فريدة=${unique.size}`);
  check('كلها أرقام صحيحة', nums.every((n) => /^\d+$/.test(n)));
  console.log(`  (زمن ${N} حجزاً متزامناً: ${elapsed}ms — ${Math.round(N / (elapsed / 1000))}/ث)`);

  console.log('\n— ٤) صيغة الرمز تبقى JOR-xxxxx —');
  const fmt = await setup.$queryRawUnsafe<{ code: string }[]>(`
    SELECT coalesce((SELECT prefix FROM "OrderCounter" WHERE id=1),'JOR')
           ||'-'||lpad(nextval('order_code_seq')::text, 5, '0') AS code`);
  const code = fmt[0].code;
  check('الصيغة متوافقة', /^[A-Z]{2,6}-\d{5,}$/.test(code), code);

  console.log('\n— ٥) setval يحرّك ما يُمنح فعلاً (تصفير الأدمن) —');
  await setup.$executeRawUnsafe("SELECT setval('order_code_seq', 700, false)");
  const [ar] = await setup.$queryRawUnsafe<{ n: bigint }[]>("SELECT nextval('order_code_seq') AS n");
  check('أول رقم بعد التصفير = 700', String(ar.n) === '700', String(ar.n));

  // أعِد المتتالية فوق أي رقم مستعمل حتى لا يفسد الاختبارُ بيانات محلية
  await setup.$executeRawUnsafe(`
    SELECT setval('order_code_seq',
      greatest((SELECT coalesce(max(NULLIF(regexp_replace(code,'^[A-Z]+-',''),'')::bigint),0)
                FROM "Order" WHERE code ~ '^[A-Z]+-[0-9]+$') + 1, 1000), false)`);

  await Promise.all([a.$disconnect(), b.$disconnect(), setup.$disconnect(),
    ...clients.map((x) => x.$disconnect())]);
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`نجح ${pass} — فشل ${fail}`);
  console.log(fail === 0 ? 'النتيجة: نجاح' : 'النتيجة: فشل');
  process.exit(fail === 0 ? 0 : 1);
}

void main();
