import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `StorageService` الحقيقية — لا نظير. يثبّت متغيّرات البيئة قبل كل
 * استيراد لأن الصنف يقرأها في الـconstructor لا كوسائط، مطابقاً لكيف
 * تُشغَّل الخدمة فعلياً عبر النمط الحقن في Nest.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

async function freshImport() {
  // كسر كاش require حتى تُقرأ متغيّرات البيئة من جديد في كل حالة
  const p = require.resolve('../src/v2/storage/storage.service');
  delete require.cache[p];
  return (await import('../src/v2/storage/storage.service')) as
    typeof import('../src/v2/storage/storage.service');
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'aquago-storage-'));

  // ---- 1) قيمة STORAGE_PROVIDER غير معروفة توقف الإقلاع ----
  console.log('قيمة STORAGE_PROVIDER غير صالحة:');
  delete process.env.STORAGE_PROVIDER;
  let threwOnMissing = false;
  try {
    const { StorageService } = await freshImport();
    new StorageService();
  } catch { threwOnMissing = true; }
  check('STORAGE_PROVIDER غائب يرمي لا يفترض local', threwOnMissing);

  process.env.STORAGE_PROVIDER = 'azure-blob-something';
  let threwOnUnknown = false;
  try {
    const { StorageService } = await freshImport();
    new StorageService();
  } catch { threwOnUnknown = true; }
  check('قيمة غير معروفة ترمي (لا تُفسَّر local بصمت)', threwOnUnknown);

  // ---- 2) s3 بلا إعداد كافٍ يرمي ----
  console.log('\nSTORAGE_PROVIDER=s3 بلا متغيّرات الاتصال:');
  process.env.STORAGE_PROVIDER = 's3';
  delete process.env.STORAGE_S3_ENDPOINT;
  delete process.env.STORAGE_S3_BUCKET;
  delete process.env.STORAGE_S3_ACCESS_KEY;
  delete process.env.STORAGE_S3_SECRET_KEY;
  let threwOnS3Missing = false;
  try {
    const { StorageService } = await freshImport();
    new StorageService();
  } catch { threwOnS3Missing = true; }
  check('s3 بلا endpoint/bucket/مفاتيح يرمي عند الإنشاء', threwOnS3Missing);

  // ---- 3) local: حفظ وقراءة فعليان على القرص ----
  console.log('\nSTORAGE_PROVIDER=local — حفظ وقراءة حقيقيان:');
  process.env.STORAGE_PROVIDER = 'local';
  process.env.STORAGE_LOCAL_PATH = dir;
  const { StorageService } = await freshImport();
  const svc = new StorageService();

  const payload = Buffer.from('صورة توقيع تجريبية — بايتات عربية للتأكد من عدم تلفها', 'utf8');
  const stored = await svc.put(payload, 'image/png', 'test-prefix');
  check('put() يعيد مفتاحاً تحت البادئة المطلوبة', stored.key.startsWith('test-prefix/'));
  check('sizeBytes يطابق طول البيانات', stored.sizeBytes === payload.length);

  const onDisk = await readFile(join(dir, stored.key));
  check('الملف موجود فعلياً على القرص بالمسار المتوقَّع', onDisk.equals(payload));

  const back = await svc.get(stored.key);
  check('get() يعيد نفس البايتات تماماً (لا تلف ترميز)', back.equals(payload));

  // ---- 4) الحذف يزيل الملف فعلياً ----
  await svc.delete(stored.key);
  let goneAfterDelete = false;
  try { await readFile(join(dir, stored.key)); }
  catch { goneAfterDelete = true; }
  check('delete() يزيل الملف من القرص', goneAfterDelete);

  // ---- 5) local لا رابط عام — القراءة تمر بمسار محروس دوماً ----
  check('publicUrl() تعيد null في وضع local', svc.publicUrl('test-prefix/x') === null);

  // ---- 6) مفتاحان لملفين مختلفين لا يتصادمان ----
  const a = await svc.put(Buffer.from('A'), 'text/plain', 'p');
  const b = await svc.put(Buffer.from('B'), 'text/plain', 'p');
  check('مفتاحان لرفعتين منفصلتين مختلفان', a.key !== b.key);
  check('كل ملف يحتفظ بمحتواه الخاص', (await svc.get(a.key)).toString() === 'A' &&
                                        (await svc.get(b.key)).toString() === 'B');

  console.log(`\n${pass} نجح، ${fail} فشل`);
  await rm(dir, { recursive: true, force: true });
  return fail;
}

main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
