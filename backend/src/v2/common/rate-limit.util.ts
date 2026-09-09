import { PrismaV2Service } from '../database/prisma-v2.service';

/**
 * يسجّل تجاوزاً فعلياً لحد ما — يُستدعى فقط لحظة الرفض، لا لكل طلب، حتى لا
 * يتضخم الجدول بالاستخدام العادي. فشل الكتابة لا يمنع الرفض نفسه (الحد
 * فُرض أصلاً عبر Redis قبل هذا الاستدعاء) — هذا سجل عرض للوحة المنصة فقط.
 */
export async function recordRateLimitViolation(
  prisma: PrismaV2Service,
  data: { scope: string; identifier: string; userId?: string; ip?: string },
): Promise<void> {
  try {
    await prisma.rateLimitViolation.create({
      data: {
        scope: data.scope,
        identifier: data.identifier,
        userId: data.userId,
        ip: data.ip,
      },
    });
  } catch {
    /* سجل عرض فقط — فشله لا يكسر الطلب الأصلي */
  }
}
