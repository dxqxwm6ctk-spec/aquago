import { execSync } from 'child_process';

/**
 * سلامة الصورة النهائية وقت التشغيل — انحداران وقعا فعلاً.
 *
 * **متطلبات التشغيل:**
 *   docker compose -f docker-compose.yml -f docker-compose.portability.yml up -d
 *
 * ما يحرسه هذا الملف عطلان **يعبران كل فحص بناء** ولا يظهران إلا عند أول
 * طلب حقيقي — وهو أسوأ توقيت ممكن لاكتشافهما:
 *
 *   ١. `npm prune --omit=dev` يحذف عميل Prisma v2 المولَّد، لأن مساره
 *      (`node_modules/@prisma-v2/client`) ليس حزمةً مثبَّتة في
 *      package.json فيراه npm دليلاً زائداً. الصورة تُقلع وتجتاز فحص
 *      الصحّة ثم ترمي `Cannot find module '@prisma-v2/client'` على أول
 *      مسار v2.
 *
 *   ٢. `ServeStaticModule` كان يردّ `index.html` جذرياً غير موجود على كل
 *      مسار غير معروف، فيرمي ENOENT ⇒ **500 بدل 404**.
 *
 * لذلك الفحص هنا على الحاوية الحيّة لا على شيفرة المصدر: العطلان في
 * الصورة المبنيّة تحديداً، ولا يظهر أيّهما في `tsc` ولا في الوحدات.
 */

const API = process.env.PORT_API1 || 'http://localhost:3000';
const COMPOSE = '-f docker-compose.yml -f docker-compose.portability.yml';
const REPO = process.cwd() + '/..';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function compose(cmd: string): string {
  return execSync(`docker compose ${COMPOSE} ${cmd}`, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * ينفّذ سكربت Node داخل حاوية API — base64 تفادياً لتحويل MSYS للمسارات.
 *
 * الفشل يُعاد نصّاً لا يُرمى: هذا الملف يختبر **غياب** وحدة تحديداً، وهو
 * ما يجعل `node -e` يخرج بغير صفر. رميُ الاستثناء كان يُسقط المشغّل قبل
 * أن يطبع سطر FAIL واحداً — أي أن الاختبار يكتشف العطل ثم يعجز عن
 * الإبلاغ عنه، وهو أسوأ من عدم اكتشافه لأنه يبدو خطأ أدوات لا نتيجة.
 */
function inContainer(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  try {
    return compose(
      `exec -T api node -e "eval(Buffer.from('${b64}','base64').toString())"`,
    ).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `ERROR: ${(err.stdout || '') + (err.stderr || '') || err.message || String(e)}`;
  }
}

async function status(path: string): Promise<number> {
  const res = await fetch(`${API}${path}`, { redirect: 'manual' });
  return res.status;
}

async function main() {
  console.log('\n— ١) عميلا Prisma في الصورة النهائية —');

  // الاستيراد وحده لا يكفي دليلاً: قد يوجد الدليل بلا محرّك صالح.
  const both = inContainer(`
    require('@prisma/client');
    require('@prisma-v2/client');
    console.log('BOTH_OK');
  `);
  check('العميلان يُستورَدان من الصورة النهائية', both.includes('BOTH_OK'), both);

  // محرّك الاستعلام لنظام الحاوية (musl) — غيابه يعطي استيراداً ناجحاً
  // ثم فشلاً عند أول استعلام، وهو بالضبط نمط العطل الذي نحرسه.
  const engine = inContainer(`
    const fs = require('fs');
    const dir = 'node_modules/@prisma-v2/client';
    const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.so.node'));
    console.log('ENGINES:' + JSON.stringify(hit));
  `);
  check('محرّك استعلام v2 مبنيّ لنظام الحاوية (musl)',
    engine.includes('musl'), engine);

  console.log('\n— ٢) استعلام v2 حقيقي من الصورة (لا فحص صحّة) —');

  const query = inContainer(`
    const { PrismaClient, AppTarget } = require('@prisma-v2/client');
    (async () => {
      const p = new PrismaClient();
      const zones = await p.zone.count();
      const roles = await p.role.count();
      console.log('COUNTS:' + JSON.stringify({ zones, roles }));
      console.log('ENUM:' + JSON.stringify(Object.keys(AppTarget || {})));
      await p.$disconnect();
      process.exit(0);
    })();
  `);
  check('استعلام v2 يعيد صفوفاً فعلية', /COUNTS:\{"zones":\d+/.test(query), query);
  // التعداد المولَّد جزء من العميل لا من المخطط — وجوده يثبت اكتمال التوليد
  check('التعدادات المولَّدة متاحة', query.includes('"CUSTOMER"'), query);

  // مسار HTTP عام يمرّ بالطبقة كاملة: متحكّم ⇒ خدمة ⇒ Prisma v2 ⇒ قاعدة.
  // هذا ما كان يفشل بـ`Cannot find module` بينما /api/health يمرّ سليماً.
  const res = await fetch(`${API}/api/v2/app-version/check?app=CUSTOMER&version=1.0.0`);
  const body = await res.text();
  check('مسار v2 عام يردّ 200 (findUnique حقيقي)', res.status === 200, `${res.status} ${body}`);
  check('الجسم JSON صالح من القاعدة', (() => {
    try { return typeof JSON.parse(body) === 'object'; } catch { return false; }
  })(), body);

  console.log('\n— ٣) PostGIS عبر عميل v2 —');
  const gis = inContainer(`
    const { PrismaClient } = require('@prisma-v2/client');
    (async () => {
      const p = new PrismaClient();
      const rows = await p.$queryRawUnsafe(
        'SELECT "nameAr" FROM "Zone" WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(35.91,31.95),4326)::geography, 20000) LIMIT 3'
      );
      console.log('GIS:' + JSON.stringify(rows.length));
      const idx = await p.$queryRawUnsafe(
        "SELECT indexname FROM pg_indexes WHERE indexdef ILIKE '%gist%'"
      );
      console.log('GIST:' + JSON.stringify(idx.map((r) => r.indexname).sort()));
      await p.$disconnect(); process.exit(0);
    })();
  `);
  check('ST_DWithin يعمل عبر عميل v2', /GIS:[1-9]/.test(gis), gis);
  // الفهارس تُنشئها بذور v2 ضمن خطوة الهجرة — غيابها يعني أن البذور لم
  // تعمل (كان `npx ts-node` ينهار بعد التقليم)، فيصير التوزيع مسحاً تسلسلياً.
  check('فهارس GIST الثلاثة موجودة',
    gis.includes('district_geom_gist') &&
    gis.includes('neighborhood_geom_gist') &&
    gis.includes('zone_geom_gist'), gis);

  console.log('\n— ٤) مسار غير معروف ⇒ 404 لا 500 —');

  // كانت كلها 500: المسار الجامع لـServeStatic يستدعي sendFile على
  // `public/index.html` غير الموجود فيرمي ENOENT.
  for (const p of ['/random', '/api/v2/nonexistent', '/notafile.js', '/images/', '/api/nope']) {
    check(`${p} ⇒ 404`, (await status(p)) === 404);
  }

  // الحارس المقابل: الإصلاح يجب ألّا يكسر اللوحات الحقيقية. كل دليل منها
  // يملك index.html خاصاً، وتخدمه express.static لا المسار الجامع.
  console.log('\n— ٥) اللوحات الحقيقية ما زالت تُخدَم —');
  for (const p of ['/admin/', '/agency/', '/platform/', '/app/', '/apply/', '/privacy/', '/support/', '/terms/']) {
    check(`${p} ⇒ 200`, (await status(p)) === 200);
  }

  console.log('\n— ٦) مسارات API لم تتأثر —');
  check('/api/health ⇒ 200', (await status('/api/health')) === 200);
  check('/api/health/live ⇒ 200', (await status('/api/health/live')) === 200);
  // محميّة لا مفقودة — تمييزٌ مهمّ: 404 هنا يعني أن الإصلاح ابتلع المسار
  check('/api/metrics ⇒ 403 (محميّة لا مفقودة)', (await status('/api/metrics')) === 403);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`نجح ${pass} — فشل ${fail}`);
  console.log(fail === 0 ? 'النتيجة: نجاح' : 'النتيجة: فشل');
  process.exit(fail === 0 ? 0 : 1);
}

void main();
