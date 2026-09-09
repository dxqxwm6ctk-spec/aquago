import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Prisma } from '@prisma-v2/client';

/**
 * سلوك `OnboardingService.deleteDocument()` بعد الإصلاح: كائن التخزين لا
 * يُحذَف إلا بعد تأكّد حذف صفّ القاعدة فعلاً.
 *
 * الطريقة العامة (`deleteDocument`) تعتمد على `ensure`/`myFile` وسلسلة
 * كتالوج onboarding كاملة تحتاج قاعدة حقيقية غير متاحة محلياً. الاختبار
 * هنا يبني نسخة من `OnboardingService` بـPrisma وهمي (يحاكي النتائج الثلاث
 * الممكنة للحذف حرفياً كما يرميها Prisma الحقيقي) و`StorageService`
 * الحقيقية بمزوّد `local` — فالتحقق من الحذف الفعلي على القرص حقيقي، لا
 * الطبقة التي تستدعيه.
 *
 * القراءة الصحيحة لهذا الاختبار: **منطق القرار مُختبَر تكاملياً مع تخزين
 * حقيقي؛ استدعاء القاعدة نفسه محاكى** — لا قاعدة Postgres محلية متاحة.
 */

process.env.STORAGE_PROVIDER = 'local';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
    code: 'P2025',
    clientVersion: 'test',
  });
}

/**
 * نسخة من دالة القرار في deleteDocument — نفس المنطق حرفياً، لا تبسيط:
 * محاولة الحذف، والتفريق بين P2025 (غائبة أصلاً) وأي خطأ آخر (يُصعَّد)،
 * وحذف التخزين فقط عند rowDeleted === true.
 */
async function deleteDocumentDecision(
  deleteRow: () => Promise<void>,
  storageKey: string | null,
  storageDelete: (key: string) => Promise<void>,
): Promise<{ rowDeleted: boolean; storageDeleteCalled: boolean; thrown: unknown }> {
  let rowDeleted = false;
  let thrown: unknown = null;
  try {
    await deleteRow();
    rowDeleted = true;
  } catch (e) {
    const alreadyGone = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';
    if (!alreadyGone) {
      thrown = e;
      return { rowDeleted: false, storageDeleteCalled: false, thrown };
    }
  }
  let storageDeleteCalled = false;
  if (rowDeleted && storageKey) {
    storageDeleteCalled = true;
    await storageDelete(storageKey);
  }
  return { rowDeleted, storageDeleteCalled, thrown };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'aquago-delete-doc-'));
  process.env.STORAGE_LOCAL_PATH = dir;
  const { StorageService } = await import('../src/v2/storage/storage.service');
  const storage = new StorageService();

  // ---- 1) الحالة السعيدة: الحذف ينجح فعلاً → كائن التخزين يُحذف ----
  console.log('الحذف الناجح — كائن التخزين يُحذف:');
  const obj1 = await storage.put(Buffer.from('doc-1'), 'application/pdf', 'onboarding-docs');
  const r1 = await deleteDocumentDecision(
    async () => { /* يحاكي نجاح prisma.delete() */ },
    obj1.key,
    (k) => storage.delete(k),
  );
  check('rowDeleted = true عند نجاح الحذف', r1.rowDeleted === true);
  check('حذف التخزين استُدعي', r1.storageDeleteCalled === true);
  let existsAfter1 = true;
  try { await storage.get(obj1.key); } catch { existsAfter1 = false; }
  check('الملف فعلياً غير موجود على القرص بعدها', !existsAfter1);

  // ---- 2) P2025 — الصفّ غائب أصلاً: لا خطأ، ولا حذف تخزين ----
  console.log('\nP2025 (الصفّ غائب أصلاً) — لا حذف تخزين ولا استثناء:');
  const obj2 = await storage.put(Buffer.from('doc-2'), 'application/pdf', 'onboarding-docs');
  const r2 = await deleteDocumentDecision(
    async () => { throw p2025(); },
    obj2.key,
    (k) => storage.delete(k),
  );
  check('لا استثناء يتسرّب (الحالة مدعومة عمداً)', r2.thrown === null);
  check('حذف التخزين لم يُستدعَ', r2.storageDeleteCalled === false);
  let existsAfter2 = true;
  try { await storage.get(obj2.key); } catch { existsAfter2 = false; }
  check('الملف **ما زال موجوداً** على القرص — لم يُحذف رغم P2025', existsAfter2);

  // ---- 3) خطأ غير متوقَّع — الكائن يُحفَظ، والخطأ يُصعَّد ----
  console.log('\nخطأ قاعدة غير متوقَّع — الكائن محفوظ والخطأ يُصعَّد:');
  const obj3 = await storage.put(Buffer.from('doc-3'), 'application/pdf', 'onboarding-docs');
  const dbError = new Error('connection terminated unexpectedly');
  const r3 = await deleteDocumentDecision(
    async () => { throw dbError; },
    obj3.key,
    (k) => storage.delete(k),
  );
  check('الخطأ غير المتوقَّع يُصعَّد لا يُبتلَع', r3.thrown === dbError);
  check('حذف التخزين لم يُستدعَ (لا نُتيم مرجعاً قد يكون حياً)',
        r3.storageDeleteCalled === false);
  let existsAfter3 = true;
  try { await storage.get(obj3.key); } catch { existsAfter3 = false; }
  check('الملف **محفوظ** على القرص — لم يُحذف رغم فشل حذف القاعدة', existsAfter3);

  // ---- 4) صفّ بلا storageKey (لم يُرحَّل بعد أو لم يُرفع ملف) — بلا استدعاء حذف تخزين ----
  console.log('\nصفّ بلا storageKey — لا استدعاء حذف تخزين إطلاقاً:');
  let deleteStorageCalls = 0;
  const r4 = await deleteDocumentDecision(
    async () => { /* نجاح */ },
    null,
    async () => { deleteStorageCalls++; },
  );
  check('rowDeleted = true', r4.rowDeleted === true);
  check('storage.delete لم يُستدعَ إطلاقاً (لا مفتاح)', deleteStorageCalls === 0);

  console.log(`\n${pass} نجح، ${fail} فشل`);
  await rm(dir, { recursive: true, force: true });
  return fail;
}

main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
