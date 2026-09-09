import { PrismaV2Service } from '../database/prisma-v2.service';

/**
 * موظفو الوكالة دون سائقيها.
 *
 * السائق دوره في الوكالة (`UserRole` بـ`agencyId`) مثل المالك والموظف
 * تماماً، فاستعلام «كل من له دور في هذه الوكالة» يشمله — وهذا خطأ في كل
 * إشعار إداري أو مالي: فاتورة الاشتراك، نفاد رصيد المحفظة، طلب بانتظار
 * تعيين سائق. كلها أمور لا يملك السائق فعل شيء حيالها، ولا يفترض أن يرى
 * أرقام وكالته المالية أصلاً. السائق يصله ما يخصّه وحده: عرض طلب، ورسالة
 * زبون.
 */
export async function agencyStaffIds(
  prisma: PrismaV2Service,
  agencyId: string,
): Promise<string[]> {
  const roles = await prisma.userRole.findMany({
    where: { agencyId, role: { name: { not: 'DRIVER' } } },
    select: { userId: true },
    distinct: ['userId'],
  });
  return roles.map((r) => r.userId);
}
