import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AgencyStatus, Prisma } from '@prisma-v2/client';
import {
  assertValidUsername,
  generateTempPassword,
  hashPassword,
  verifyPassword,
} from '../auth/password.util';
import { normalizeJordanPhone } from '../common/phone.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { PermissionsService } from '../rbac/permissions.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';

export interface CreateAgencyInput {
  nameAr: string;
  phone: string;
  cityId: string;
  ownerPhone: string;
  ownerName: string;
  /** اسم دخول لوحة الوكالة يكتبه السوبر أدمن؛ كلمة المرور يولّدها النظام */
  username: string;
  ownerEmail?: string;
  mainBranch?: { nameAr: string; lat: number; lng: number; address?: string };
}

@Injectable()
export class AgenciesService {
  constructor(
    private prisma: PrismaV2Service,
    private permissions: PermissionsService,
    // لإخراج السائق المحذوف من تطبيقه فوراً لا عند طلبه التالي
    private gateway: TrackingV2Gateway,
  ) {}

  private async systemRole(name: string) {
    const role = await this.prisma.role.findFirst({
      where: { name, isSystem: true, agencyId: null },
    });
    if (!role) throw new Error(`دور النظام ${name} غير مزروع`);
    return role;
  }

  private audit(
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    oldValue?: unknown,
    newValue?: unknown,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType,
        entityId,
        oldValue: oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
        newValue: newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
      },
    });
  }

  // ============ مستوى المنصة ============

  list() {
    return this.prisma.agency.findMany({
      include: {
        city: { select: { nameAr: true } },
        wallet: { select: { balance: true } },
        _count: { select: { drivers: true, orders: true, branches: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * إنشاء وكالة: حساب المالك بكلمة مرور + الوكالة + المحفظة + الفرع الرئيسي.
   * المالك يدخل اللوحة باسم المستخدم؛ هاتفه يبقى للتواصل ولاتصال السوبر أدمن.
   */
  async create(input: CreateAgencyInput, actorId: string) {
    const ownerRole = await this.systemRole('AGENCY_OWNER');
    const ownerPhone = normalizeJordanPhone(input.ownerPhone);
    const username = assertValidUsername(input.username);
    const password = generateTempPassword();
    const email = input.ownerEmail?.trim().toLowerCase() || null;
    await this.assertCredentialsFree(username, email);
    const passwordHash = await hashPassword(password);

    const agency = await this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.upsert({
        where: { phone: ownerPhone },
        create: {
          phone: ownerPhone,
          name: input.ownerName,
          username,
          email,
          passwordHash,
          mustChangePassword: true,
        },
        // حساب قائم (كان زبوناً مثلاً) يُمنح بيانات دخول اللوحة
        update: { username, email, passwordHash, mustChangePassword: true },
      });
      const agency = await tx.agency.create({
        data: {
          nameAr: input.nameAr,
          phone: input.phone,
          cityId: input.cityId,
          wallet: { create: {} },
          ...(input.mainBranch
            ? { branches: { create: { ...input.mainBranch, isMain: true } } }
            : {}),
        },
      });
      // فرع رئيسي دائماً — التغطية والتوزيع مربوطان بالفرع، وبدونه
      // لا تستطيع الوكالة تحديد مناطقها ولا تصلها طلبات إطلاقاً.
      // الموقع الافتراضي: مركز مناطق مدينة الوكالة.
      if (!input.mainBranch) {
        const [center] = await tx.$queryRaw<
          { lat: number | null; lng: number | null }[]
        >`
          SELECT ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
                 ST_X(ST_Centroid(ST_Collect(geom))) AS lng
          FROM "Zone" WHERE "cityId" = ${input.cityId} AND active = true
        `;
        await tx.agencyBranch.create({
          data: {
            agencyId: agency.id,
            nameAr: 'الفرع الرئيسي',
            lat: center?.lat ?? 31.9539,
            lng: center?.lng ?? 35.9106,
            isMain: true,
          },
        });
      }
      // لا ساعات عمل افتراضية: محرك التوزيع لا يغلق الوكالة بالجدول، فهي
      // تعمل على مدار الساعة وتغلق بقرارها (إجازة أو status = PAUSED).
      // كل صنف نشط في المنصة متوفر افتراضياً — بدون هذه السجلات تظهر
      // صفحة التوفر فارغة ويتخطى محرك التوزيع الوكالة (لا مخزون).
      const types = await tx.waterBottleType.findMany({ where: { active: true } });
      await tx.agencyBottleAvailability.createMany({
        data: types.map((t) => ({
          agencyId: agency.id,
          bottleTypeId: t.id,
          available: true,
        })),
      });
      await tx.userRole.create({
        data: { userId: owner.id, roleId: ownerRole.id, agencyId: agency.id },
      });
      return agency;
    });
    await this.permissions.invalidate(
      (await this.prisma.user.findUniqueOrThrow({ where: { phone: ownerPhone } })).id,
    );
    await this.audit(actorId, 'agency.create', 'Agency', agency.id, undefined, {
      nameAr: agency.nameAr,
      cityId: agency.cityId,
      ownerUsername: username,
    });
    // كلمة المرور تظهر مرة واحدة للسوبر أدمن ليسلّمها للمالك — لا تُخزَّن نصاً
    return { ...agency, ownerUsername: username, tempPassword: password };
  }

  /** اسم المستخدم والبريد فريدان على مستوى المنصة كلها */
  private async assertCredentialsFree(
    username: string,
    email: string | null,
    exceptUserId?: string,
  ) {
    const clash = await this.prisma.user.findFirst({
      where: {
        OR: [{ username }, ...(email ? [{ email }] : [])],
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { username: true, email: true },
    });
    if (clash) {
      throw new BadRequestException(
        clash.username === username
          ? 'اسم المستخدم محجوز — اختر غيره'
          : 'البريد الإلكتروني مستخدم لحساب آخر',
      );
    }
  }

  async setStatus(agencyId: string, status: AgencyStatus, actorId: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    const updated = await this.prisma.agency.update({
      where: { id: agencyId },
      data: { status },
    });
    await this.audit(
      actorId,
      'agency.status.update',
      'Agency',
      agencyId,
      { status: agency.status },
      { status },
    );
    return updated;
  }

  /**
   * حذف وكالة — فقط إن كانت فارغة تماماً (لا سائقين، لا طلبات، لا رصيد، لا
   * طلبات شحن). وكالة عليها نشاط فعلي لا تُحذف — تُوقَف (SUSPENDED) بدلاً
   * من ذلك حفاظاً على سجل الطلبات والمحفظة.
   */
  async deleteAgency(agencyId: string, actorId: string) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    const [drivers, orders, wallet, recharges] = await Promise.all([
      this.prisma.driverProfile.count({ where: { agencyId } }),
      this.prisma.order.count({ where: { agencyId } }),
      this.prisma.wallet.findUnique({ where: { agencyId } }),
      this.prisma.rechargeRequest.count({ where: { agencyId } }),
    ]);
    if (drivers > 0 || orders > 0 || recharges > 0 || Number(wallet?.balance ?? 0) !== 0) {
      throw new BadRequestException(
        'الوكالة عليها نشاط فعلي (سائقون أو طلبات أو رصيد) — لا يمكن حذفها، أوقفها (SUSPENDED) بدلاً من ذلك',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const roles = await tx.userRole.findMany({
        where: { agencyId },
        select: { userId: true },
      });
      await tx.agencyCoverage.deleteMany({ where: { agencyId } });
      await tx.agencyBottleAvailability.deleteMany({ where: { agencyId } });
      await tx.agencyWorkingHour.deleteMany({ where: { agencyId } });
      await tx.agencyHoliday.deleteMany({ where: { agencyId } });
      await tx.agencyBranch.deleteMany({ where: { agencyId } });
      await tx.userRole.deleteMany({ where: { agencyId } });
      // الأدوار المخصصة لموظفي هذه الوكالة وحدها — لا الأدوار النظامية المشتركة
      await tx.role.deleteMany({ where: { agencyId, isSystem: false } });
      if (wallet) await tx.wallet.delete({ where: { agencyId } });
      await tx.agency.delete({ where: { id: agencyId } });
      // مالك/موظف بلا أي عضوية متبقية بأي وكالة أخرى — حسابه يُنظَّف معها
      for (const { userId } of roles) {
        const stillLinked = await tx.userRole.count({ where: { userId } });
        if (stillLinked === 0) await this.removeUserAccount(tx, userId);
      }
    });
    await this.audit(actorId, 'agency.delete', 'Agency', agencyId, { nameAr: agency.nameAr }, undefined);
    return { ok: true };
  }

  /**
   * يحذف حساب مستخدم فعلياً فقط إن كان فارغاً تماماً بلا أي أثر حقيقي
   * (طلبات، عروض توزيع، سجل تدقيق، تذاكر دعم) — وإلا يعطّله بدل حذفه حتى
   * لا يضيع تاريخ حقيقي. يُستخدم بعد إزالة عضوية المستخدم من الوكالة.
   */
  private async removeUserAccount(tx: Prisma.TransactionClient, userId: string) {
    const [orders, offers, assignments, audits, tickets] = await Promise.all([
      tx.order.count({ where: { OR: [{ customerId: userId }, { driverId: userId }] } }),
      tx.driverOffer.count({ where: { driverId: userId } }),
      tx.orderAssignmentHistory.count({ where: { driverId: userId } }),
      tx.auditLog.count({ where: { actorUserId: userId } }),
      tx.supportTicket.count({
        where: { OR: [{ createdByUserId: userId }, { assignedToUserId: userId }] },
      }),
    ]);
    if (orders + offers + assignments + audits + tickets > 0) {
      await tx.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
      return { deleted: false };
    }
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.address.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
    return { deleted: true };
  }

  // ============ داخل نطاق الوكالة ============

  async get(agencyId: string) {
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      include: {
        city: { select: { nameAr: true } },
        branches: true,
        coverage: {
          include: {
            zone: { select: { id: true, nameAr: true } },
            neighborhood: { select: { id: true, nameAr: true } },
            district: { select: { id: true, nameAr: true } },
          },
        },
        workingHours: { orderBy: { dayOfWeek: 'asc' } },
        wallet: { select: { balance: true } },
        availability: { include: { bottleType: true } },
      },
    });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    return agency;
  }

  /** حدود المنصة التي تعرضها لوحة الوكالة (لا تكشف بقية الإعدادات) */
  async limits() {
    const s = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 }, create: { id: 1 }, update: {},
    });
    return { maxDeliveryRadiusKm: s.maxDeliveryRadiusKm };
  }

  async createBranch(
    agencyId: string,
    data: { nameAr: string; lat: number; lng: number; deliveryRadiusKm?: number; address?: string },
    actorId: string,
  ) {
    const branch = await this.prisma.agencyBranch.create({
      data: { ...data, agencyId },
    });
    await this.audit(actorId, 'branch.create', 'AgencyBranch', branch.id, undefined, data);
    return branch;
  }

  /**
   * موقع الفرع (GPS) ونطاق توصيله — هذا هو تعريف التغطية في النظام:
   * أي طلب يقع داخل نصف القطر يصبح الفرع مؤهلاً له، بلا رسم حدود.
   */
  /**
   * تأكيد هوية من يجري الإجراء بكلمة مروره.
   *
   * الجلسة تقول «هذا الحساب»، وكلمة المرور تقول «وهذا صاحبه الآن». الفرق
   * يهمّ في قرار كإزاحة موقع الفرع: جهازٌ يُترك مفتوحاً على مكتب الوكالة
   * يكفي للأول ولا يكفي للثاني.
   *
   * حساب بلا كلمة مرور (دخول بالهاتف) لا يصل هذا المسار أصلاً — تغيير
   * التغطية صلاحية موظفي اللوحة، وهم يدخلون باسم مستخدم وكلمة مرور.
   */
  private async assertPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new BadRequestException('هذا الحساب لا يملك كلمة مرور — راجع مالك الوكالة');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('كلمة المرور غير صحيحة');
    }
  }

  async setBranchLocation(
    agencyId: string,
    branchId: string,
    data: {
      lat: number;
      lng: number;
      deliveryRadiusKm: number;
      address?: string;
      password: string;
    },
    actorId: string,
  ) {
    const { password, ...location } = data;
    await this.assertPassword(actorId, password);
    const branch = await this.prisma.agencyBranch.findFirst({
      where: { id: branchId, agencyId },
    });
    if (!branch) throw new NotFoundException('الفرع غير موجود في هذه الوكالة');
    const settings = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 }, create: { id: 1 }, update: {},
    });
    if (location.deliveryRadiusKm > settings.maxDeliveryRadiusKm) {
      throw new BadRequestException(`أقصى نطاق مسموح به ${settings.maxDeliveryRadiusKm} كم`);
    }
    const updated = await this.prisma.agencyBranch.update({
      where: { id: branchId },
      // الحفظ من اللوحة = تأكيد الموقع، فلا تُلتقط GPS تلقائياً بعدها
      // (وبلا نشر كلمة المرور في صف قاعدة البيانات — انظر location أعلاه)
      data: { ...location, locationConfirmed: true },
    });
    // تغيير الموقع/النطاق يعيد تشكيل التوزيع كله — يُسجَّل بالقيمتين
    await this.audit(
      actorId,
      'branch.location.update',
      'AgencyBranch',
      branchId,
      { lat: branch.lat, lng: branch.lng, deliveryRadiusKm: branch.deliveryRadiusKm },
      location,
    );
    return updated;
  }

  /**
   * استبدال تغطية الفرع — هرمية بثلاث درجات: منطقة إدارية كاملة (كل أحيائها
   * الحالية والمستقبلية)، أو حي محدد، أو zone منفردة. كلها يجب أن تتبع مدينة الوكالة.
   */
  async setCoverage(
    agencyId: string,
    branchId: string,
    input: { zoneIds?: string[]; neighborhoodIds?: string[]; districtIds?: string[] },
    actorId: string,
  ) {
    const zoneIds = [...new Set(input.zoneIds ?? [])];
    const neighborhoodIds = [...new Set(input.neighborhoodIds ?? [])];
    const districtIds = [...new Set(input.districtIds ?? [])];

    const branch = await this.prisma.agencyBranch.findFirst({
      where: { id: branchId, agencyId },
    });
    if (!branch) throw new NotFoundException('الفرع غير موجود في هذه الوكالة');
    const agency = await this.prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });

    const [zones, neighborhoods, districts] = await Promise.all([
      this.prisma.zone.count({
        where: { id: { in: zoneIds }, cityId: agency.cityId, active: true },
      }),
      this.prisma.neighborhood.count({
        where: { id: { in: neighborhoodIds }, active: true, district: { cityId: agency.cityId } },
      }),
      this.prisma.district.count({
        where: { id: { in: districtIds }, cityId: agency.cityId, active: true },
      }),
    ]);
    if (zones !== zoneIds.length || neighborhoods !== neighborhoodIds.length || districts !== districtIds.length) {
      throw new BadRequestException('بعض المناطق أو الأحياء غير موجودة أو خارج مدينة الوكالة');
    }

    const old = await this.prisma.agencyCoverage.findMany({
      where: { branchId },
      select: { zoneId: true, neighborhoodId: true, districtId: true },
    });
    await this.prisma.$transaction([
      this.prisma.agencyCoverage.deleteMany({ where: { branchId } }),
      this.prisma.agencyCoverage.createMany({
        data: [
          ...districtIds.map((districtId) => ({ agencyId, branchId, districtId })),
          ...neighborhoodIds.map((neighborhoodId) => ({ agencyId, branchId, neighborhoodId })),
          ...zoneIds.map((zoneId) => ({ agencyId, branchId, zoneId })),
        ],
      }),
    ]);
    // تغيير التغطية يؤثر على الـ Dispatch — يُسجَّل بالقيمتين (ملاحظة الاعتماد)
    await this.audit(
      actorId,
      'coverage.update',
      'AgencyBranch',
      branchId,
      {
        zoneIds: old.filter((c) => c.zoneId).map((c) => c.zoneId),
        neighborhoodIds: old.filter((c) => c.neighborhoodId).map((c) => c.neighborhoodId),
        districtIds: old.filter((c) => c.districtId).map((c) => c.districtId),
      },
      { zoneIds, neighborhoodIds, districtIds },
    );
    return { ok: true, count: districtIds.length + neighborhoodIds.length + zoneIds.length };
  }

  /** أرقام لوحة الوكالة — اليوم يبدأ من منتصف الليل بتوقيت الخادم */
  async stats(agencyId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const active = ['AGENCY_ASSIGNED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING'] as const;
    const [agency, ordersToday, activeOrders, completedToday, cashToday, commissionToday, drivers, wallet, needsAssignment] =
      await Promise.all([
        this.prisma.agency.findUniqueOrThrow({ where: { id: agencyId } }),
        this.prisma.order.count({
          where: { agencyId, agencyAssignedAt: { gte: startOfDay } },
        }),
        this.prisma.order.count({
          where: { agencyId, status: { in: active as unknown as [] } },
        }),
        this.prisma.order.count({
          where: { agencyId, status: 'COMPLETED', deliveredAt: { gte: startOfDay } },
        }),
        this.prisma.order.aggregate({
          where: { agencyId, status: 'COMPLETED', deliveredAt: { gte: startOfDay } },
          _sum: { total: true },
        }),
        this.prisma.order.aggregate({
          where: { agencyId, status: 'COMPLETED', deliveredAt: { gte: startOfDay } },
          _sum: { commissionAmount: true },
        }),
        this.prisma.driverProfile.groupBy({
          by: ['status'],
          where: { agencyId },
          _count: true,
        }),
        this.prisma.wallet.findUnique({ where: { agencyId } }),
        this.prisma.order.findMany({
          where: {
            agencyId,
            status: 'AGENCY_ASSIGNED',
            offers: { none: { status: 'PENDING' } },
            driverId: null,
          },
          select: { id: true, code: true, addressText: true, total: true, createdAt: true },
          orderBy: { agencyAssignedAt: 'asc' },
        }),
      ]);
    const driverCounts = Object.fromEntries(drivers.map((d) => [d.status, d._count]));
    return {
      status: agency.status,
      autoDispatch: agency.autoDispatch,
      rating: agency.rating,
      ordersToday,
      activeOrders,
      completedToday,
      cashCollectedToday: Number(cashToday._sum.total ?? 0),
      commissionToday: Number(commissionToday._sum.commissionAmount ?? 0),
      drivers: {
        available: driverCounts['AVAILABLE'] ?? 0,
        busy: driverCounts['BUSY'] ?? 0,
        offline: driverCounts['OFFLINE'] ?? 0,
      },
      walletBalance: Number(wallet?.balance ?? 0),
      // الطلبات المعلقة بانتظار تعيين يدوي — أهم قسم في اللوحة
      needsAssignment,
    };
  }

  /**
   * أرباح الوكالة عن مدة. "الربح" هنا محدود بما تعرفه المنصة فعلاً:
   *
   *   المحصَّل من الزبون (total) = ثمن المياه (subtotal) + عمولة المنصة
   *   صافي الوكالة = المحصَّل − العمولة = ثمن المياه
   *
   * كلفة شراء القوارير وأجور السائقين خارج النظام تماماً (أجر السائق شأن
   * بينه وبين وكالته)، فما تحته ليس ربحاً صافياً بالمعنى المحاسبي — واجهة
   * اللوحة تقول هذا صراحة بدل أن يقرأه صاحب الوكالة ربحاً.
   *
   * المرجع الزمني `deliveredAt` لا `createdAt`: المال يُقبض عند التسليم،
   * وطلبٌ أُنشئ قبل منتصف الليل وسُلّم بعده يخص يوم قبضه.
   */
  async earnings(agencyId: string, fromISO?: string, toISO?: string) {
    await this.prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });

    // الافتراضي: الشهر الجاري حتى اللحظة
    const now = new Date();
    const from = fromISO ? new Date(fromISO) : new Date(now.getFullYear(), now.getMonth(), 1);
    // `to` شامل ليومه: الواجهة ترسل تاريخاً لا لحظة، ومن يختار "حتى اليوم"
    // يقصد نهايته لا فجره
    const to = toISO ? new Date(toISO) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('تاريخ غير صالح');
    }
    if (from > to) throw new BadRequestException('تاريخ البداية بعد النهاية');
    const toEnd = toISO ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : to;

    const completed: Prisma.OrderWhereInput = {
      agencyId,
      status: 'COMPLETED',
      deliveredAt: { gte: from, lt: toEnd },
    };

    const [totals, cancelled, daily, byDriver, byWaterBottleType] = await Promise.all([
      this.prisma.order.aggregate({
        where: completed,
        _count: true,
        _sum: { total: true, commissionAmount: true, subtotal: true },
      }),
      // سياق يفسّر تراجع الأرباح: طلبات وصلت الوكالة ولم تُسلَّم
      this.prisma.order.count({
        where: { agencyId, status: 'CANCELLED', agencyAssignedAt: { gte: from, lt: toEnd } },
      }),
      // التجميع اليومي بتوقيت عمّان لا UTC — وإلا انزاح نصف طلبات المساء ليوم تالٍ
      this.prisma.$queryRaw<
        { day: string; orders: number; collected: number; commission: number; net: number }[]
      >`
        SELECT to_char(("deliveredAt" AT TIME ZONE 'Asia/Amman')::date, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS orders,
               SUM("total")::float AS collected,
               SUM("commissionAmount")::float AS commission,
               SUM("subtotal")::float AS net
        FROM "Order"
        WHERE "agencyId" = ${agencyId} AND status = 'COMPLETED'
          AND "deliveredAt" >= ${from} AND "deliveredAt" < ${toEnd}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<
        { driverId: string | null; driverName: string | null; orders: number; collected: number; net: number }[]
      >`
        SELECT o."driverId" AS "driverId", u.name AS "driverName",
               COUNT(*)::int AS orders,
               SUM(o."total")::float AS collected,
               SUM(o."subtotal")::float AS net
        FROM "Order" o
        LEFT JOIN "User" u ON u.id = o."driverId"
        WHERE o."agencyId" = ${agencyId} AND o.status = 'COMPLETED'
          AND o."deliveredAt" >= ${from} AND o."deliveredAt" < ${toEnd}
        GROUP BY 1, 2 ORDER BY 4 DESC
      `,
      this.prisma.$queryRaw<{ nameAr: string; qty: number; net: number }[]>`
        SELECT ct."nameAr" AS "nameAr",
               SUM(oi.qty)::int AS qty,
               SUM(oi.qty * oi."unitPrice")::float AS net
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "WaterBottleType" ct ON ct.id = oi."bottleTypeId"
        WHERE o."agencyId" = ${agencyId} AND o.status = 'COMPLETED'
          AND o."deliveredAt" >= ${from} AND o."deliveredAt" < ${toEnd}
        GROUP BY 1 ORDER BY 3 DESC
      `,
    ]);

    const orders = totals._count;
    const collected = Number(totals._sum.total ?? 0);
    const commission = Number(totals._sum.commissionAmount ?? 0);
    const net = Number(totals._sum.subtotal ?? 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      from: from.toISOString(),
      to: toEnd.toISOString(),
      totals: {
        orders,
        cancelled,
        collected: round2(collected),
        commission: round2(commission),
        net: round2(net),
        avgOrder: orders ? round2(collected / orders) : 0,
      },
      daily,
      byDriver,
      byWaterBottleType,
    };
  }

  listOrders(agencyId: string, status?: string) {
    return this.prisma.order.findMany({
      where: {
        agencyId,
        ...(status ? { status: status as never } : {}),
      },
      include: {
        items: { include: { bottleType: { select: { nameAr: true } } } },
        driver: { select: { id: true, name: true } },
        customer: { select: { name: true, phone: true } },
        offers: {
          where: { status: 'PENDING' },
          select: { id: true, driverId: true, expiresAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * تقييمات هذه الوكالة كما كتبها زبائنها. الوكالة كانت ترى رقماً واحداً
   * (⭐ 4.2) لا تعرف منه أي سائق ولا أي طلب صنعه — وهذا ما يُصلَح.
   *
   * اسم الزبون الأول فقط: التقييم يُقرأ لتحسين الخدمة لا لملاحقة صاحبه.
   */
  async listRatings(agencyId: string) {
    const rows = await this.prisma.order.findMany({
      where: { agencyId, rating: { not: null } },
      select: {
        id: true,
        code: true,
        rating: true,
        ratingComment: true,
        ratedAt: true,
        createdAt: true,
        customer: { select: { name: true } },
        driver: { select: { id: true, name: true } },
      },
      orderBy: [{ ratedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const byStars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const r of rows) {
      byStars[r.rating as number] += 1;
      sum += r.rating as number;
    }
    // متوسط الوكالة المعتمد يأتي من سجلها لا من هذه المئتين: المحرك يقرؤه
    // من هناك، وعرض رقم مختلف هنا يجعل اللوحة تناقض قرارات التوزيع
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      select: { rating: true, ratingCount: true },
    });
    return {
      rows,
      byStars,
      // متوسط ما يُعرض هنا — يُقارَن بالمعتمد فيُرى الاتجاه
      recentAverage: rows.length
        ? Math.round((sum / rows.length) * 100) / 100
        : null,
      agencyRating: agency?.rating ?? null,
      agencyRatingCount: agency?.ratingCount ?? 0,
    };
  }

  async wallet(agencyId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { agencyId },
      include: { entries: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!wallet) throw new NotFoundException('لا محفظة لهذه الوكالة');
    // حد التنبيه من إعدادات المنصة — تعرضه اللوحة كحد أدنى مقترح للشحن
    const settings = await this.prisma.dispatchSettings.findUnique({ where: { id: 1 } });
    return {
      ...wallet,
      lowBalanceThreshold: Number(settings?.lowBalanceThreshold ?? 10),
    };
  }

  /** توفر القوارير — يغذي فلتر المخزون في محرك التوزيع مباشرة */
  async setAvailability(
    agencyId: string,
    items: { bottleTypeId: string; available: boolean }[],
    actorId: string,
  ) {
    for (const item of items) {
      await this.prisma.agencyBottleAvailability.upsert({
        where: {
          agencyId_bottleTypeId: {
            agencyId,
            bottleTypeId: item.bottleTypeId,
          },
        },
        create: { agencyId, ...item },
        update: { available: item.available },
      });
    }
    await this.audit(actorId, 'availability.update', 'Agency', agencyId, undefined, { items });
    return this.prisma.agencyBottleAvailability.findMany({
      where: { agencyId },
      include: { bottleType: true },
    });
  }

  // ============ ساعات الدوام ============

  /**
   * جدول الدوام الأسبوعي. الأيام: 0 = الأحد … 6 = السبت، مطابقاً لما يقرأه
   * محرّك التوزيع (`Date.getUTCDay` بتوقيت عمّان).
   *
   * **يوم بلا صفوف = مغلق ذلك اليوم**، لكن **جدول فارغ تماماً = مفتوح دائماً**.
   * التمييز مقصود: الوكالة التي لم تُدخل جدولاً قط تعمل على مدار الساعة كما
   * كانت قبل هذه الميزة، ولا تُغلق لأن أحداً لم يفتح شاشة الإعدادات.
   */
  async workingHours(agencyId: string) {
    const rows = await this.prisma.agencyWorkingHour.findMany({
      where: { agencyId },
      orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
    });
    return {
      hours: rows,
      // ما يعرضه رأس الشاشة: أمفتوحة الآن أم لا، وبأي منطق
      alwaysOpen: rows.length === 0,
      openNow: this.isOpenNow(rows),
    };
  }

  /**
   * استبدال الجدول كاملاً — لا تعديل صفٍّ صفّاً.
   *
   * الشاشة تعرض الأسبوع كله وتُرسله كما هو، والاستبدال يجعل ما تراه هو ما
   * يُحفَظ بالضبط: يومٌ أُفرغ يصير مغلقاً فعلاً، ولا تبقى صفوف يتيمة من
   * جدول سابق تفتح الوكالة في وقت ظنّ صاحبها أنه أغلقه.
   */
  async setWorkingHours(
    agencyId: string,
    hours: { dayOfWeek: number; opensAt: string; closesAt: string }[],
    actorId: string,
  ) {
    const clean: { dayOfWeek: number; opensAt: string; closesAt: string }[] = [];
    for (const h of hours) {
      if (!Number.isInteger(h.dayOfWeek) || h.dayOfWeek < 0 || h.dayOfWeek > 6) {
        throw new BadRequestException('يوم غير صالح');
      }
      const time = /^([01]\d|2[0-3]):([0-5]\d)$/;
      if (!time.test(h.opensAt) || !time.test(h.closesAt)) {
        throw new BadRequestException('الوقت بصيغة HH:MM بنظام 24 ساعة');
      }
      if (h.opensAt === h.closesAt) {
        // نافذة صفرية: لا هي مفتوحة ولا مغلقة صراحةً — تُرفض بدل أن تُفسَّر
        throw new BadRequestException('وقت الفتح والإغلاق متطابقان');
      }
      clean.push({ dayOfWeek: h.dayOfWeek, opensAt: h.opensAt, closesAt: h.closesAt });
    }

    await this.prisma.$transaction([
      this.prisma.agencyWorkingHour.deleteMany({ where: { agencyId } }),
      ...(clean.length
        ? [this.prisma.agencyWorkingHour.createMany({
            data: clean.map((c) => ({ agencyId, ...c })),
            skipDuplicates: true,
          })]
        : []),
    ]);
    await this.audit(actorId, 'hours.update', 'Agency', agencyId, undefined, { hours: clean });
    return this.workingHours(agencyId);
  }

  /**
   * أمفتوحة الآن؟ نسخة العرض من منطق المحرّك.
   *
   * تكرارٌ مقصود وضيّق: المحرّك يقرّر الإرسال وهذه تُخبر البشر، وربطُ شاشةٍ
   * بخدمة التوزيع يجرّ محرّك الطلبات كله إلى لوحة إعدادات. الحاكم يبقى
   * `DispatchService.isWithinWorkingHours` — وأي تغيير هناك يُنقل هنا.
   */
  private isOpenNow(
    hours: { dayOfWeek: number; opensAt: string; closesAt: string }[],
  ): boolean {
    if (hours.length === 0) return true; // بلا جدول = مفتوحة دائماً
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Amman',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const date = new Date(Date.UTC(+get('year'), +get('month') - 1, +get('day')));
    const weekday = date.getUTCDay();
    const minutes = +get('hour') * 60 + +get('minute');
    const yesterday = (weekday + 6) % 7;
    const toMin = (v: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
      return m ? +m[1] * 60 + +m[2] : null;
    };
    for (const h of hours) {
      if (h.dayOfWeek !== weekday && h.dayOfWeek !== yesterday) continue;
      const from = toMin(h.opensAt);
      const to = toMin(h.closesAt);
      if (from === null || to === null) continue;
      if (to > from) {
        if (h.dayOfWeek === weekday && minutes >= from && minutes < to) return true;
      } else {
        if (h.dayOfWeek === weekday && minutes >= from) return true;
        if (h.dayOfWeek === yesterday && minutes < to) return true;
      }
    }
    return false;
  }

  /** إعدادات المالك: Auto Dispatch + إيقاف مؤقت ذاتي (القرار 6) */
  async updateSettings(
    agencyId: string,
    data: { autoDispatch?: boolean; paused?: boolean },
    actorId: string,
  ) {
    const agency = await this.prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });
    if (agency.status === 'SUSPENDED' || agency.status === 'PENDING_APPROVAL') {
      throw new BadRequestException('حالة الوكالة تديرها المنصة حالياً');
    }
    const updated = await this.prisma.agency.update({
      where: { id: agencyId },
      data: {
        ...(data.autoDispatch === undefined ? {} : { autoDispatch: data.autoDispatch }),
        ...(data.paused === undefined
          ? {}
          : { status: data.paused ? 'PAUSED' : 'ACTIVE' }),
      },
    });
    await this.audit(
      actorId,
      'agency.settings.update',
      'Agency',
      agencyId,
      { autoDispatch: agency.autoDispatch, status: agency.status },
      { autoDispatch: updated.autoDispatch, status: updated.status },
    );
    return updated;
  }

  listDrivers(agencyId: string) {
    return this.prisma.driverProfile.findMany({
      where: { agencyId },
      include: {
        user: { select: { id: true, name: true, phone: true, status: true } },
        branch: { select: { id: true, nameAr: true } },
      },
    });
  }

  /**
   * تنظيف قائمة اللوحات وتوحيد صيغتها: **رقمان، شرطة، ثم باقي الأرقام**
   * (22-78901). كانت تُحفظ كما كتبها المستخدم، فصارت اللوحة الواحدة تُكتب
   * بأربع صيغ («22 78901»، «2278901»، «22-78901»…) — يبحث عنها موظف
   * العمليات فلا يجدها، ولا تُقارن لوحتان لسائقين مختلفين.
   *
   * الأرقام وحدها هي ما يُقرأ: أي فاصل يكتبه المستخدم (مسافة، شرطة، شرطة
   * سفلية) يُطرح ثم تُبنى الصيغة من جديد. الأرقام العربية-الهندية (٧٩) تُحوَّل
   * — لوحة تُكتب من كيبورد عربي ليست لوحة أخرى.
   */
  private static plateOf(raw: string): string | null {
    const digits = raw
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/\D/g, '');
    // رقمان للمنطقة/الترميز + من ثلاثة إلى ستة للرقم نفسه
    if (!/^\d{5,8}$/.test(digits)) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }

  private cleanPlates(plates: string[] | undefined): string[] | undefined {
    if (plates === undefined) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of plates) {
      const t = p.trim();
      if (!t) continue;
      const plate = AgenciesService.plateOf(t);
      if (!plate) {
        throw new BadRequestException(
          `رقم المركبة «${t}» غير صالح — رقمان ثم شرطة ثم باقي الأرقام (مثال: 22-78901)`,
        );
      }
      if (seen.has(plate)) continue;
      seen.add(plate);
      out.push(plate);
      if (out.length >= 20) break;
    }
    return out;
  }

  /**
   * لوحة واحدة على الأقل لكل سائق. الطلب يُسلَّم بمركبة، والوكالة تعرف
   * لوحتها؛ وبلا رقم لا يُعرف من وقف عند باب الزبون ولا تُتابَع مخالفة ولا
   * شكوى. كان الحقل اختيارياً فبقي فارغاً عند أكثر السائقين.
   */
  private assertHasPlate(plates: string[] | undefined): void {
    if (!plates || plates.length === 0) {
      throw new BadRequestException('رقم المركبة مطلوب — مثال: 22-78901');
    }
  }

  async createDriver(
    agencyId: string,
    data: {
      phone: string;
      name: string;
      vehicleCount?: number;
      vehiclePlates?: string[];
      branchId?: string;
    },
    actorId: string,
  ) {
    const driverRole = await this.systemRole('DRIVER');
    const phone = normalizeJordanPhone(data.phone);
    if (data.branchId) {
      const branch = await this.prisma.agencyBranch.findFirst({
        where: { id: data.branchId, agencyId },
      });
      if (!branch) throw new BadRequestException('الفرع غير تابع لهذه الوكالة');
    }
    // الرقم قد يخصّ حساباً قائماً (زبون سابق مثلاً) — الحساب يُربط لا يُكرَّر،
    // لأن الهاتف فريد. لكن `update: {}` كان يُبقي الاسم القديم بصمت، فتكتب
    // الوكالة «سامر القضاة» ويظهر لها سائق اسمه «عميل جديد» بلا كلمة تفسير.
    // نطبّق الاسم المكتوب — وهي صلاحية تملكها أصلاً من شاشة التعديل — ونخبرها
    // أن الحساب كان موجوداً.
    const linkedExisting = await this.prisma.user.findUnique({ where: { phone } });
    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone, name: data.name },
      update: { name: data.name },
    });
    const existing = await this.prisma.driverProfile.findUnique({
      where: { userId: user.id },
    });
    if (existing) {
      throw new BadRequestException('هذا الرقم مسجل سائقاً بالفعل');
    }
    const plates = this.cleanPlates(data.vehiclePlates) ?? [];
    this.assertHasPlate(plates);
    await this.prisma.$transaction([
      this.prisma.driverProfile.create({
        data: {
          userId: user.id,
          agencyId,
          branchId: data.branchId,
          vehicleCount: data.vehicleCount ?? 1,
          vehiclePlates: plates,
          // المشتق: أول لوحة — يقرؤه تطبيق السائق ولوحة الإدارة
          vehiclePlate: plates[0] ?? null,
          // إضافة الوكالة للسائق هي الاعتماد ذاته — بدون true يحجبه
          // المحرك والتعيين اليدوي للأبد (لا واجهة اعتماد منفصلة)
          isVerified: true,
        },
      }),
      this.prisma.userRole.create({
        data: { userId: user.id, roleId: driverRole.id, agencyId },
      }),
    ]);
    await this.permissions.invalidate(user.id);
    await this.audit(actorId, 'driver.create', 'DriverProfile', user.id, undefined, {
      agencyId,
      phone,
      linkedExistingAccount: linkedExisting?.name ?? null,
    });
    const created = await this.prisma.driverProfile.findUnique({
      where: { userId: user.id },
      include: { user: { select: { id: true, name: true, phone: true } } },
    });
    return {
      ...created,
      /** اسم الحساب قبل الربط — تعرضه الواجهة تنبيهاً، وnull لحساب جديد */
      linkedExistingAccount:
        linkedExisting && linkedExisting.name !== data.name
          ? linkedExisting.name
          : null,
    };
  }

  /**
   * إضافة موظف بصلاحيات يحددها المالك (FRS §2):
   * دور AGENCY_EMPLOYEE (قالب فارغ) + دور مخصص يحمل الصلاحيات الممنوحة.
   */
  async createEmployee(
    agencyId: string,
    data: {
      username: string;
      name: string;
      phone?: string;
      permissions: string[];
    },
    actorId: string,
  ) {
    const employeeRole = await this.systemRole('AGENCY_EMPLOYEE');
    // الموظف حساب لوحة: اسم مستخدم يكتبه المالك وكلمة مرور يولّدها النظام
    const username = assertValidUsername(data.username);
    const password = generateTempPassword();
    await this.assertCredentialsFree(username, null);
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : null;
    if (phone) {
      const taken = await this.prisma.user.findUnique({ where: { phone } });
      if (taken) throw new BadRequestException('رقم الهاتف مسجل لحساب آخر');
    }
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: data.permissions } },
    });
    if (perms.length !== data.permissions.length) {
      throw new BadRequestException('صلاحية غير معروفة في القائمة');
    }
    // لا يمنح الموظفَ صلاحياتِ منصة
    if (data.permissions.some((k) => k.startsWith('platform.'))) {
      throw new BadRequestException('صلاحيات المنصة لا تُمنح لموظفي الوكالات');
    }

    const passwordHash = await hashPassword(password);
    const user = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          username,
          phone,
          passwordHash,
          mustChangePassword: true,
        },
      });
      await tx.userRole.create({
        data: { userId: user.id, roleId: employeeRole.id, agencyId },
      });
      if (perms.length) {
        const customRole = await tx.role.create({
          data: {
            name: `emp-${user.id.slice(0, 8)}`,
            nameAr: `صلاحيات ${data.name}`,
            scope: 'AGENCY',
            agencyId,
            permissions: {
              create: perms.map((p) => ({ permissionId: p.id })),
            },
          },
        });
        await tx.userRole.create({
          data: { userId: user.id, roleId: customRole.id, agencyId },
        });
      }
      return user;
    });
    await this.permissions.invalidate(user.id);
    await this.audit(actorId, 'employee.create', 'User', user.id, undefined, {
      agencyId,
      username,
      permissions: data.permissions,
    });
    return {
      id: user.id,
      name: user.name,
      username,
      phone: user.phone,
      permissions: data.permissions,
      tempPassword: password,
    };
  }

  /** موظفو الوكالة (بلا السائقين) مع صلاحياتهم الممنوحة */
  async listEmployees(agencyId: string) {
    const roles = await this.prisma.userRole.findMany({
      where: { agencyId, role: { name: { not: 'DRIVER' } } },
      include: {
        user: {
          select: {
            id: true, name: true, username: true, phone: true,
            status: true, lastLoginAt: true, mustChangePassword: true,
          },
        },
        role: {
          select: {
            name: true, nameAr: true, isSystem: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });
    // الموظف يحمل دورين: القالب AGENCY_EMPLOYEE ودوره المخصص — نضمّهما بصف واحد
    const byUser = new Map<string, {
      id: string; name: string; username: string | null; phone: string | null;
      status: string; lastLoginAt: Date | null; mustChangePassword: boolean;
      isOwner: boolean; permissions: string[];
    }>();
    for (const r of roles) {
      const row = byUser.get(r.user.id) ?? {
        ...r.user,
        isOwner: false,
        permissions: [] as string[],
      };
      if (r.role.name === 'AGENCY_OWNER') row.isOwner = true;
      for (const p of r.role.permissions) {
        if (!row.permissions.includes(p.permission.key)) row.permissions.push(p.permission.key);
      }
      byUser.set(r.user.id, row);
    }
    return [...byUser.values()];
  }

  /** تعديل بيانات سائق: الاسم/الهاتف على حسابه، ولوحة المركبة/الفرع على ملفه */
  async updateDriver(
    agencyId: string,
    userId: string,
    data: {
      name?: string;
      phone?: string;
      vehicleCount?: number;
      vehiclePlates?: string[];
      branchId?: string;
    },
    actorId: string,
  ) {
    const profile = await this.prisma.driverProfile.findFirst({ where: { userId, agencyId } });
    if (!profile) throw new NotFoundException('السائق غير موجود في هذه الوكالة');
    if (data.branchId) {
      const branch = await this.prisma.agencyBranch.findFirst({
        where: { id: data.branchId, agencyId },
      });
      if (!branch) throw new BadRequestException('الفرع غير تابع لهذه الوكالة');
    }
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : undefined;
    if (phone) {
      const taken = await this.prisma.user.findFirst({ where: { phone, id: { not: userId } } });
      if (taken) throw new BadRequestException('رقم الهاتف مسجل لحساب آخر');
    }
    const plates = this.cleanPlates(data.vehiclePlates);
    // غياب الحقل = لا تعديل عليه؛ أما إرساله فارغاً فمحوٌ للوحة وهو ممنوع
    if (plates !== undefined) this.assertHasPlate(plates);
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { ...(data.name ? { name: data.name } : {}), ...(phone ? { phone } : {}) },
      }),
      this.prisma.driverProfile.update({
        where: { userId },
        data: {
          ...(plates !== undefined
            ? { vehiclePlates: plates, vehiclePlate: plates[0] ?? null }
            : {}),
          ...(data.vehicleCount !== undefined ? { vehicleCount: data.vehicleCount } : {}),
          ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
        },
      }),
    ]);
    await this.audit(
      actorId,
      'driver.update',
      'DriverProfile',
      userId,
      {
        name: before.name,
        phone: before.phone,
        vehiclePlates: profile.vehiclePlates,
        vehicleCount: profile.vehicleCount,
        branchId: profile.branchId,
      },
      data,
    );
    return this.prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        branch: { select: { id: true, nameAr: true } },
      },
    });
  }

  /**
   * إزالة سائق من الوكالة: يفقد صفة السائق وتسجيل الدخول لتطبيق المندوب
   * فوراً بحذف ملفه وعضويته. حسابه (User) يُحذف معه فقط إن كان بلا أي
   * طلبات أو عروض سابقة — وإلا يبقى (معطَّلاً إن لزم) فتضل الطلبات القديمة
   * سليمة باسمه.
   */
  async removeDriver(agencyId: string, userId: string, actorId: string) {
    const profile = await this.prisma.driverProfile.findFirst({ where: { userId, agencyId } });
    if (!profile) throw new NotFoundException('السائق غير موجود في هذه الوكالة');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.delete({ where: { userId } });
      await tx.userRole.deleteMany({ where: { userId, agencyId } });
      // سحب الجلسات صراحةً: الحساب الذي يبقى (لأن له تاريخاً) كان يُعطَّل
      // فيُرفض عند أول طلب برسالة «جلسة غير صالحة» — والسائق يظنّه عطلاً
      // ويعيد المحاولة. السبب مخزَّن الآن فيُقال له إنه أُزيل من الوكالة.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'DRIVER_REMOVED' },
      });
      return this.removeUserAccount(tx, userId);
    });
    await this.permissions.invalidate(userId);
    // ولا ينتظر السائق طلبه التالي ليكتشف: التطبيق مفتوح أمامه الآن وقد
    // يبقى دقائق بلا نداء شبكة، فنُخرجه فوراً عبر الـSocket
    await this.gateway.emitSessionRevoked(userId, 'أُزيل حسابك من الوكالة — تواصل معها إن كان ذلك خطأً');
    await this.audit(actorId, 'driver.remove', 'DriverProfile', userId,
      { agencyId, vehiclePlate: profile.vehiclePlate }, { deletedAccount: result.deleted });
    return result;
  }

  /** تعديل بيانات موظف واسمه وهاتفه، واستبدال صلاحياته إن أُرسلت */
  async updateEmployee(
    agencyId: string,
    userId: string,
    data: { name?: string; phone?: string; permissions?: string[] },
    actorId: string,
  ) {
    const membership = await this.prisma.userRole.findFirst({
      where: { userId, agencyId, role: { name: { not: 'DRIVER' } } },
    });
    if (!membership) throw new NotFoundException('الموظف غير موجود في هذه الوكالة');
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : undefined;
    if (phone) {
      const taken = await this.prisma.user.findFirst({ where: { phone, id: { not: userId } } });
      if (taken) throw new BadRequestException('رقم الهاتف مسجل لحساب آخر');
    }
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (data.name || phone) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { ...(data.name ? { name: data.name } : {}), ...(phone ? { phone } : {}) },
      });
    }
    if (data.permissions) {
      if (data.permissions.some((k) => k.startsWith('platform.'))) {
        throw new BadRequestException('صلاحيات المنصة لا تُمنح لموظفي الوكالات');
      }
      const perms = await this.prisma.permission.findMany({
        where: { key: { in: data.permissions } },
      });
      if (perms.length !== data.permissions.length) {
        throw new BadRequestException('صلاحية غير معروفة في القائمة');
      }
      const customRole = await this.prisma.userRole.findFirst({
        where: { userId, agencyId, role: { isSystem: false } },
      });
      await this.prisma.$transaction(async (tx) => {
        let roleId = customRole?.roleId;
        if (!roleId) {
          const role = await tx.role.create({
            data: {
              name: `emp-${userId.slice(0, 8)}`,
              nameAr: `صلاحيات ${before.name}`,
              scope: 'AGENCY',
              agencyId,
            },
          });
          roleId = role.id;
          await tx.userRole.create({ data: { userId, roleId, agencyId } });
        }
        await tx.rolePermission.deleteMany({ where: { roleId } });
        if (perms.length) {
          await tx.rolePermission.createMany({
            data: perms.map((p) => ({ roleId, permissionId: p.id })),
          });
        }
      });
    }
    await this.permissions.invalidate(userId);
    await this.audit(actorId, 'employee.update', 'User', userId,
      { name: before.name, phone: before.phone }, data);
    return { ok: true };
  }

  /**
   * إزالة موظف من الوكالة: تُلغى صلاحياته فوراً بحذف عضويته ودوره المخصص.
   * حسابه يُحذف معه فقط إن كان بلا أي أثر حقيقي (لم يسجّل دخولاً بفعلٍ
   * محاسَب) — وإلا يبقى معطَّلاً.
   */
  async removeEmployee(agencyId: string, userId: string, actorId: string) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, agencyId },
      include: { role: { select: { name: true } } },
    });
    if (roles.length === 0) throw new NotFoundException('الموظف غير موجود في هذه الوكالة');
    if (roles.some((r) => r.role.name === 'AGENCY_OWNER')) {
      throw new BadRequestException('لا يمكن حذف مالك الوكالة من هنا');
    }
    if (roles.some((r) => r.role.name === 'DRIVER')) {
      throw new BadRequestException('هذا سائق — استخدم حذف السائقين');
    }
    const roleIds = roles.map((r) => r.roleId);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId, agencyId } });
      // الدور المخصص لهذا الموظف وحده (emp-*)، لا القالب النظامي المشترك
      await tx.role.deleteMany({ where: { agencyId, isSystem: false, id: { in: roleIds } } });
      return this.removeUserAccount(tx, userId);
    });
    await this.permissions.invalidate(userId);
    await this.audit(actorId, 'employee.remove', 'User', userId,
      { agencyId }, { deletedAccount: result.deleted });
    return result;
  }

  /**
   * المالك يعيد ضبط كلمة مرور موظفه (نسيان/تسريب) — تُرجع كلمة مؤقتة تُسلَّم
   * له ويُجبر على تغييرها. تُلغى جلساته فوراً.
   */
  async resetEmployeePassword(agencyId: string, userId: string, actorId: string) {
    const membership = await this.prisma.userRole.findFirst({
      where: { userId, agencyId, role: { name: { not: 'DRIVER' } } },
      include: { user: { select: { id: true, name: true, username: true } } },
    });
    if (!membership) throw new NotFoundException('الموظف غير موجود في هذه الوكالة');
    if (!membership.user.username) {
      throw new BadRequestException('هذا الحساب بلا اسم مستخدم — أنشئ له حساباً جديداً');
    }
    const password = generateTempPassword();
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password), mustChangePassword: true },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });
    await this.audit(actorId, 'employee.password.reset', 'User', userId, undefined, {
      agencyId,
    });
    return { username: membership.user.username, tempPassword: password };
  }
}
