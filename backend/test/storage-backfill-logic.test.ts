/**
 * منطق سكربت الترحيل — بلا قاعدة حقيقية (غير متاحة محلياً).
 *
 * لا يشغّل السكربت نفسه (يفتح PrismaClient حقيقياً عند الاستيراد)، بل
 * يثبّت الافتراضات التي يقوم عليها: شرط «لم يُرحَّل بعد» يلتقط الصفوف
 * الصحيحة، وjson.APPLY/BATCH تُقرأ من argv بلا مفاجآت.
 *
 * هذا تحقّق منطقي لا اختبار تكامل — السكربت الفعلي لم يُشغَّل ضد قاعدة
 * حقيقية. التقرير يوضّح هذا الفرق صراحة.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

// محاكاة شرط findMany نفسه من backfill-object-storage.ts، لا نسخة مختلفة
function needsMigration(row: { storageKey: string | null; data: Buffer | null }): boolean {
  return row.storageKey === null && row.data !== null;
}

function main() {
  console.log('شرط «صف بانتظار الترحيل»:');
  check(
    'صف قديم (data فقط) يُلتقط',
    needsMigration({ storageKey: null, data: Buffer.from('x') }),
  );
  check(
    'صف مُرحَّل بالفعل (storageKey موجود) لا يُلتقط ثانية — idempotent',
    !needsMigration({ storageKey: 'uploaded-images/abc', data: Buffer.from('x') }),
  );
  check(
    'صف بلا بيانات أصلاً (data null, storageKey null) لا يُلتقط — لا شيء لترحيله',
    !needsMigration({ storageKey: null, data: null }),
  );
  check(
    'صف مُرحَّل وdata مُفرَّغ (الحالة النهائية بعد حذف لاحق منفصل) لا يُلتقط',
    !needsMigration({ storageKey: 'x/y', data: null }),
  );

  console.log('\nقراءة أعلام سطر الأوامر:');
  const argsApply = ['node', 'script.ts', '--apply', '--batch=50'];
  const APPLY = argsApply.includes('--apply');
  const BATCH = Number(argsApply.find((a) => a.startsWith('--batch='))?.split('=')[1] || 200);
  check('‎--apply يُلتقط', APPLY === true);
  check('‎--batch=50 يُحلَّل رقماً صحيحاً', BATCH === 50);

  const argsDry = ['node', 'script.ts'];
  const APPLY2 = argsDry.includes('--apply');
  const BATCH2 = Number(argsDry.find((a) => a.startsWith('--batch='))?.split('=')[1] || 200);
  check('بلا أعلام: جفاف افتراضاً (APPLY=false)', APPLY2 === false);
  check('بلا --batch: القيمة الافتراضية 200', BATCH2 === 200);

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

const failed = main();
console.log(failed ? 'النتيجة: فشل' : 'النتيجة: نجاح');
process.exit(failed ? 1 : 0);
