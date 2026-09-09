/**
 * تحقق المرحلة 1 — يُشغَّل بعد v2:deploy و v2:seed ويجب أن تنجح الفحوص الأربعة:
 *  1) ST_Contains يجد المنطقة الصحيحة لنقطة الزبون
 *  2) القيد الجزئي يمنع عرضين PENDING لنفس الطلب
 *  3) الـ Ledger يرفض UPDATE و DELETE
 *  4) رصيد المحفظة (الكاش) = مجموع حركات الـ Ledger
 */
process.env.DATABASE_URL_V2 ??=
  'postgresql://gas:gas_secret@localhost:5433/jordan_gas_v2?schema=public';

import { PrismaClient } from '@prisma-v2/client';

const prisma = new PrismaClient();
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // 1) الاستعلام المكاني: شارع الرينبو يقع في "جبل عمان"
  const zones = await prisma.$queryRaw<{ nameAr: string }[]>`
    SELECT "nameAr" FROM "Zone"
    WHERE active = true
      AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(35.9206, 31.9508), 4326))
  `;
  check(
    'ST_Contains يجد منطقة موقع الزبون',
    zones.some((z) => z.nameAr === 'جبل عمان'),
    zones.map((z) => z.nameAr).join('، ') || 'لا نتائج',
  );

  // 2) القيد الجزئي: عرضان PENDING لنفس الطلب يجب أن يفشل ثانيهما
  const customer = await prisma.user.findUniqueOrThrow({ where: { phone: '+962791111111' } });
  const address = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  const agency = await prisma.agency.findFirstOrThrow({ include: { drivers: true } });
  const zoneRow = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Zone" WHERE "nameAr" = 'جبل عمان' LIMIT 1`;
  const order = await prisma.order.create({
    data: {
      code: `TEST-${Date.now()}`,
      customerId: customer.id,
      addressId: address.id,
      zoneId: zoneRow[0].id,
      status: 'SEARCHING',
      deliveryLat: address.lat,
      deliveryLng: address.lng,
      addressText: 'اختبار',
      subtotal: 7,
      commissionAmount: 0.5,
      total: 7.5,
    },
  });
  const [d1, d2] = agency.drivers;
  const mkOffer = (driverId: string, attemptNo: number) =>
    prisma.driverOffer.create({
      data: {
        orderId: order.id,
        agencyId: agency.id,
        driverId,
        attemptNo,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 20000),
      },
    });
  await mkOffer(d1.userId, 1);
  let second = false;
  try {
    await mkOffer(d2.userId, 2);
    second = true;
  } catch {
    /* متوقع: unique_violation من one_pending_offer_per_order */
  }
  check('القيد الجزئي يمنع عرضين PENDING لنفس الطلب', !second);

  // 3) حصانة الـ Ledger — الـ Trigger يرمي استثناءً على أي UPDATE/DELETE
  const entry = await prisma.ledgerEntry.findFirstOrThrow();
  let updateBlocked = false;
  try {
    await prisma.$executeRaw`UPDATE "LedgerEntry" SET "noteAr" = 'محاولة عبث' WHERE id = ${entry.id}`;
  } catch {
    updateBlocked = true;
  }
  check('الـ Ledger يرفض UPDATE', updateBlocked);
  let deleteBlocked = false;
  try {
    await prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE id = ${entry.id}`;
  } catch {
    deleteBlocked = true;
  }
  const still = await prisma.ledgerEntry.findUnique({ where: { id: entry.id } });
  check('الـ Ledger يرفض DELETE', deleteBlocked && still !== null);

  // 4) الكاش = مجموع الحركات
  const wallet = await prisma.wallet.findFirstOrThrow({ include: { entries: true } });
  const sum = wallet.entries.reduce((s, e) => s + Number(e.amount), 0);
  check('Wallet.balance = SUM(LedgerEntry)', Number(wallet.balance) === sum, `${wallet.balance} = ${sum}`);

  // تنظيف بيانات الاختبار (الطلب والعروض فقط)
  await prisma.driverOffer.deleteMany({ where: { orderId: order.id } });
  await prisma.order.delete({ where: { id: order.id } });

  console.log(failures === 0 ? '\n🎉 كل الفحوص نجحت' : `\n⚠️ ${failures} فحص فشل`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
