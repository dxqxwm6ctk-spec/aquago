import { execSync } from 'child_process';

/**
 * المرحلة 3.7 — مخزن الكائنات عبر مسارات التطبيق الحقيقية، داخل حاوية API
 * حقيقية على Docker (مزوّد local، لا S3/DigitalOcean Spaces).
 *
 * ينفّذ سكربتاً واحداً داخل الحاوية عبر `docker compose exec` يستعمل
 * StorageService الحقيقية (المُصرَّفة فعلياً في الصورة) وPrisma الحقيقي —
 * لا نظير محلي لأي منهما. يكتب صفّاً واحداً في AgencyOnboardingDocument
 * مرتبطاً بوكالة بذور حقيقية موجودة، ويحذفه هو وكل كائن تخزين أنشأه في
 * نهاية التشغيل — لا يترك أثراً في البيانات المشتركة.
 */

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

const REAL_AGENCY_ID = '0dfe2dab-6ad8-4f2e-8026-79bebe4b3d24'; // وكالة مياه الوحدات — بذور حقيقية

/**
 * يُنفَّذ داخل حاوية API الحقيقية — لا مكافئ محلي. السكربت يمرّ Base64
 * ضمن أمر `node -e` واحد لا كمسار ملف: أي وسيط بصيغة `/tmp/...` يمرّ عبر
 * Git Bash على Windows يصطدم بتحويل مسارات MSYS التلقائي الذي يُحوّله
 * صمتاً إلى مسار Windows (`/tmp/x.js` → `C:/Users/.../Temp/x.js`) — ثبت
 * هذا فعلياً أثناء بناء هذا الاختبار: `docker compose cp` + مسار ملف
 * فشل بهذا التحويل تحديداً. Base64 داخل `-e` يتفادى المشكلة كلياً لأنه
 * لا يحتوي حرف `/` بصيغة يُطابقها التحويل.
 */
function runInContainer(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const inline = `eval(Buffer.from('${encoded}','base64').toString('utf8'))`;
  return execSync(`docker compose exec -T api node -e "${inline}"`, {
    cwd: process.cwd() + '/..',
    encoding: 'utf8',
  });
}

async function main() {
  console.log('مخزن الكائنات عبر التطبيق الحقيقي داخل حاوية API (مزوّد local):\n');

  // ---- السكربت الذي يعمل داخل الحاوية الحقيقية ----
  const script = `
    (async () => {
      const { PrismaClient } = require('/app/node_modules/@prisma-v2/client');
      const { StorageService } = require('/app/dist/src/v2/storage/storage.service');
      const prisma = new PrismaClient();
      const storage = new StorageService();
      const results = {};

      // تنظيف أي بقايا اختبار سابقة أولاً — idempotent
      const onboarding = await prisma.agencyOnboarding.upsert({
        where: { agencyId: '${REAL_AGENCY_ID}' },
        create: { agencyId: '${REAL_AGENCY_ID}', legalNameAr: 'اختبار المرحلة 3.7' },
        update: {},
      });

      // 1) رفع حقيقي — StorageService.put فعلياً على القرص داخل الحاوية
      const contentAr = Buffer.from('محتوى عربي حقيقي — اختبار المرحلة 3.7 ✓', 'utf8');
      const stored = await storage.put(contentAr, 'text/plain', 'phase3-test');
      results.putKey = stored.key;
      results.putSize = stored.sizeBytes;

      // 2) كتابة صفّ بـstorageKey فقط (نمط ما بعد الترحيل من المرحلة 1.4)
      const doc = await prisma.agencyOnboardingDocument.upsert({
        where: { onboardingId_key: { onboardingId: onboarding.id, key: 'PHASE3_TEST' } },
        create: {
          onboardingId: onboarding.id, key: 'PHASE3_TEST',
          storageKey: stored.key, data: null, mimeType: 'text/plain',
          fileName: 'phase3.txt', sizeBytes: stored.sizeBytes,
        },
        update: { storageKey: stored.key, data: null, sizeBytes: stored.sizeBytes },
      });

      // 3) قراءة حقيقية عبر storageKey — نفس منطق documentBytes() حرفياً
      const resolvedNew = doc.storageKey ? await storage.get(doc.storageKey) : doc.data;
      results.storageKeyReadMatches = resolvedNew.toString('utf8') === contentAr.toString('utf8');

      // 4) صفّ قديم بـdata فقط (محاكاة ما قبل الترحيل) — سبيل السقوط للخلف
      const legacyBytes = Buffer.from('بايتات قديمة قبل مخزن الكائنات', 'utf8');
      const legacyDoc = await prisma.agencyOnboardingDocument.upsert({
        where: { onboardingId_key: { onboardingId: onboarding.id, key: 'PHASE3_LEGACY' } },
        create: {
          onboardingId: onboarding.id, key: 'PHASE3_LEGACY',
          storageKey: null, data: legacyBytes, mimeType: 'text/plain',
          sizeBytes: legacyBytes.length,
        },
        update: { storageKey: null, data: legacyBytes },
      });
      const resolvedLegacy = legacyDoc.storageKey ? await storage.get(legacyDoc.storageKey) : legacyDoc.data;
      results.legacyFallbackMatches = resolvedLegacy.toString('utf8') === legacyBytes.toString('utf8');

      // 5) استبدال — put جديد، ثم حذف القديم (نمط uploadDocument الحقيقي)
      const previousKey = doc.storageKey;
      const replacement = Buffer.from('محتوى بديل — نفس الوثيقة، كائن جديد', 'utf8');
      const stored2 = await storage.put(replacement, 'text/plain', 'phase3-test');
      await prisma.agencyOnboardingDocument.update({
        where: { id: doc.id },
        data: { storageKey: stored2.key, data: null, sizeBytes: stored2.sizeBytes },
      });
      await storage.delete(previousKey);
      results.replacementKey = stored2.key;
      results.replacementDiffersFromOriginal = stored2.key !== stored.key;
      let oldStillExists = true;
      try { await storage.get(previousKey); } catch { oldStillExists = false; }
      results.oldObjectDeletedAfterReplace = !oldStillExists;
      let newExists = true;
      try { await storage.get(stored2.key); } catch { newExists = false; }
      results.newObjectExistsAfterReplace = newExists;

      // 6) publicUrl على مزوّد local يعيد null (لا رابط عام بلا S3)
      results.publicUrlNullOnLocal = storage.publicUrl(stored2.key) === null;

      // ---- تنظيف كامل: حذف الصفوف وكائنات التخزين التي أنشأها هذا الاختبار ----
      await storage.delete(stored2.key).catch(() => {});
      await prisma.agencyOnboardingDocument.delete({ where: { id: doc.id } }).catch(() => {});
      await prisma.agencyOnboardingDocument.delete({ where: { id: legacyDoc.id } }).catch(() => {});
      // onboarding نفسه: لا نحذفه إن كان له وثائق أخرى غير اختبارية؛ هنا
      // أُنشئ بهذا الاختبار تحديداً (upsert بلا صفوف سابقة) فحذفه آمن.
      const remaining = await prisma.agencyOnboardingDocument.count({ where: { onboardingId: onboarding.id } });
      if (remaining === 0) {
        await prisma.agencyOnboarding.delete({ where: { id: onboarding.id } }).catch(() => {});
      }

      console.log('RESULT_JSON:' + JSON.stringify(results));
      await prisma.$disconnect();
      process.exit(0);
    })().catch((e) => { console.error('SCRIPT_ERROR:', e.message); process.exit(1); });
  `;

  let output: string;
  try {
    output = runInContainer(script);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.error('فشل تشغيل السكربت داخل الحاوية:', err.stderr || err.stdout || e);
    console.log('\n0 نجح، 1 فشل\nالنتيجة: فشل');
    process.exit(1);
  }

  const line = output.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  if (!line) {
    console.error('لم يصل RESULT_JSON من داخل الحاوية. الخرج الكامل:\n', output);
    process.exit(1);
  }
  const r = JSON.parse(line.slice('RESULT_JSON:'.length));

  check('رفع حقيقي (put) يعيد مفتاحاً تحت البادئة المطلوبة',
        typeof r.putKey === 'string' && r.putKey.startsWith('phase3-test/'), r.putKey);
  check('قراءة عبر storageKey تطابق المحتوى العربي المرفوع تماماً', r.storageKeyReadMatches === true);
  check('سقوط للخلف على data القديمة (بلا storageKey) يعمل صحيحاً', r.legacyFallbackMatches === true);
  check('الاستبدال يولّد مفتاحاً مختلفاً عن الأصلي', r.replacementDiffersFromOriginal === true);
  check('الكائن القديم يُحذف فعلياً من القرص بعد الاستبدال', r.oldObjectDeletedAfterReplace === true);
  check('الكائن الجديد موجود فعلياً على القرص بعد الاستبدال', r.newObjectExistsAfterReplace === true);
  check('publicUrl على مزوّد local تعيد null (لا رابط عام بلا S3)', r.publicUrlNullOnLocal === true);

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
