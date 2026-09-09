/**
 * ترحيل الملفات من بايتات داخل القاعدة إلى مخزن كائنات (StorageService).
 *
 * **لا يحذف بايتة واحدة.** يقرأ كل صفّ لم يُرحَّل بعد (storageKey IS NULL،
 * data IS NOT NULL)، يرفع بايتاته إلى المخزن، ويكتب المفتاح — العمود
 * القديم يبقى كما هو. الحذف اللاحق قرار منفصل صريح بعد التحقق الكامل، لا
 * جزء من هذا السكربت.
 *
 * idempotent: صفّ يملك storageKey لا يُلمَس ثانية — إعادة التشغيل بعد فشل
 * جزئي تكمل من حيث توقفت.
 *
 * الاستخدام:
 *   npm run v2:storage:backfill              # جفاف — يعرض العدد بلا كتابة
 *   npm run v2:storage:backfill -- --apply   # ينفّذ فعلياً
 *   npm run v2:storage:backfill -- --apply --batch=100
 */
import { PrismaClient } from '@prisma-v2/client';
import { StorageService } from '../src/v2/storage/storage.service';

const prisma = new PrismaClient();
const storage = new StorageService(); // نفس قراءة متغيرات البيئة التي يعتمدها الخادم

const APPLY = process.argv.includes('--apply');
const BATCH = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] || 200);

async function migrateUploadedImage() {
  const rows = await prisma.uploadedImage.findMany({
    where: { storageKey: null, data: { not: null } },
    select: { id: true, data: true, mimeType: true },
    take: APPLY ? BATCH : undefined,
  });
  console.log(`UploadedImage: ${rows.length} صفاً بانتظار الترحيل${APPLY ? '' : ' (جفاف)'}`);
  if (!APPLY) return rows.length;
  for (const r of rows) {
    const stored = await storage.put(r.data!, r.mimeType, 'uploaded-images');
    await prisma.uploadedImage.update({ where: { id: r.id }, data: { storageKey: stored.key } });
  }
  return rows.length;
}

async function migrateOnboardingDocuments() {
  const rows = await prisma.agencyOnboardingDocument.findMany({
    where: { storageKey: null, data: { not: null } },
    select: { id: true, data: true, mimeType: true },
    take: APPLY ? BATCH : undefined,
  });
  console.log(`AgencyOnboardingDocument: ${rows.length} صفاً بانتظار الترحيل${APPLY ? '' : ' (جفاف)'}`);
  if (!APPLY) return rows.length;
  for (const r of rows) {
    const stored = await storage.put(r.data!, r.mimeType, 'onboarding-docs');
    await prisma.agencyOnboardingDocument.update({
      where: { id: r.id },
      data: { storageKey: stored.key },
    });
  }
  return rows.length;
}

async function migrateContractDocuments() {
  const rows = await prisma.contractDocument.findMany({
    where: { storageKey: null, data: { not: null } },
    select: { id: true, data: true, mimeType: true },
    take: APPLY ? BATCH : undefined,
  });
  console.log(`ContractDocument: ${rows.length} صفاً بانتظار الترحيل${APPLY ? '' : ' (جفاف)'}`);
  if (!APPLY) return rows.length;
  for (const r of rows) {
    const stored = await storage.put(r.data!, r.mimeType, 'contract-docs');
    await prisma.contractDocument.update({ where: { id: r.id }, data: { storageKey: stored.key } });
  }
  return rows.length;
}

async function migrateSignatures() {
  const rows = await prisma.contractSignature.findMany({
    where: { signatureImageKey: null, signatureImage: { not: null } },
    select: { id: true, signatureImage: true },
    take: APPLY ? BATCH : undefined,
  });
  console.log(`ContractSignature: ${rows.length} صفاً بانتظار الترحيل${APPLY ? '' : ' (جفاف)'}`);
  if (!APPLY) return rows.length;
  for (const r of rows) {
    const stored = await storage.put(r.signatureImage!, 'image/png', 'contract-signatures');
    await prisma.contractSignature.update({
      where: { id: r.id },
      data: { signatureImageKey: stored.key },
    });
  }
  return rows.length;
}

async function main() {
  console.log(`وضع: ${APPLY ? `تنفيذ فعلي (دفعة ${BATCH})` : 'جفاف — لا كتابة'}\n`);
  const counts = {
    uploadedImage: await migrateUploadedImage(),
    onboarding: await migrateOnboardingDocuments(),
    contractDoc: await migrateContractDocuments(),
    signature: await migrateSignatures(),
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n${APPLY ? 'رُحِّل' : 'بانتظار الترحيل'}: ${total} صفاً`);
  if (!APPLY && total > 0) {
    console.log('أعد التشغيل بـ--apply للتنفيذ الفعلي.');
  }
}

main()
  .catch((e) => { console.error('فشل الترحيل:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
