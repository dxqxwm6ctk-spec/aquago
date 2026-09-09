import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AppTarget,
  OrderStatus,
  OtpChannel,
  Prisma,
  TicketStatus,
  UserStatus,
} from '@prisma-v2/client';
import { randomUUID } from 'crypto';
import { readdir } from 'fs/promises';
import type Redis from 'ioredis';
import { join } from 'path';
import {
  assertValidUsername,
  generateTempPassword,
  hashPassword,
} from '../auth/password.util';
import { normalizeJordanPhone, toJordanE164 } from '../common/phone.util';
import { SESSION_REVOKED_AR } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../rbac/permissions.service';
import { REDIS } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';

export type BroadcastAudience =
  | 'ALL'
  | 'CUSTOMERS'
  | 'DRIVERS'
  /// كل الوكالات: مالكوها وموظفوها بلا سائقيهم — للسائقين فئتهم
  | 'AGENCIES'
  /// وكالة بعينها: موظفوها وسائقوها معاً
  | 'AGENCY';

/**
 * أدوار المنصة القابلة للمنح من اللوحة — SUPER_ADMIN لا يُمنح عبر API.
 *
 * ADMIN يحمل صلاحيات المدير الأعلى نفسها ويُمنح من هنا، لأنه دورٌ عادي بلا
 * حصانة: يُعطَّل ويُحذف كأي موظف. أما SUPER_ADMIN فمحميّ من ذلك في اللوحة،
 * ومنحُه عبر API يعني إنشاء حسابات لا يستطيع أحد إيقافها.
 */
export const GRANTABLE_PLATFORM_ROLES = [
  'ADMIN',
  'OPERATIONS',
  'SUPPORT',
  'ACCOUNTANT',
] as const;

/** أدوارٌ تمنح سلطة كاملة — لا يمنحها إلا من يملكها أصلاً */
const FULL_POWER_ROLES = ['SUPER_ADMIN', 'ADMIN'];

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private prisma: PrismaV2Service,
    private permissions: PermissionsService,
    private notifications: NotificationsService,
    private gateway: TrackingV2Gateway,
    @Inject(REDIS) private redis: Redis,
    private storage: StorageService,
  ) {}

  /**
   * منح دورٍ كامل الصلاحية لا يجوز إلا لمن يملك مثله. اليوم لا يصل هذه
   * الشاشة إلا صاحب سلطة كاملة (إدارة المستخدمين محصورة به)، لكن الحارس
   * يبقى صريحاً: لو مُنحت `platform.users.manage` لدور أضيق يوماً، لصار
   * بوسع حامله أن يرقّي نفسه إلى ما فوقه بضغطة.
   */
  private async assertMayGrantFullPower(actorId: string, roleName: string) {
    if (!FULL_POWER_ROLES.includes(roleName)) return;
    const actor = await this.prisma.userRole.findFirst({
      where: { userId: actorId, role: { name: { in: FULL_POWER_ROLES } } },
      select: { userId: true },
    });
    if (!actor) {
      throw new BadRequestException(
        'منح صلاحيات المدير لا يجوز إلا لمن يملكها',
      );
    }
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

  // ============ الأرباح ============

  /**
   * تحدّد بداية/نهاية الفترة. custom تتطلب from/to صراحة؛ غيرها محسوبة من
   * الآن. النهاية دائماً "الآن" — لا تقارير عن المستقبل.
   */
  private resolveProfitRange(
    range: 'today' | 'week' | 'month' | 'custom',
    from?: string,
    to?: string,
  ): { start: Date; end: Date } {
    const end = to ? new Date(to) : new Date();
    if (range === 'custom') {
      if (!from) throw new BadRequestException('يلزم تحديد from مع range=custom');
      return { start: new Date(from), end };
    }
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (range === 'week') start.setDate(start.getDate() - 6); // آخر 7 أيام شاملة اليوم
    if (range === 'month') start.setDate(1);
    return { start, end };
  }

  /**
   * ربح المنصة (مجموع العمولة) وإجمالي مبيعات كل وكالة (subtotal — قبل
   * خصم تكلفتها الخاصة، فالنظام لا يتتبّع تكلفة القارورة عند الوكالة)
   * لفترة محدَّدة، مبنية على الطلبات المُسلَّمة فعلياً (deliveredAt) — نفس
   * لحظة خصم العمولة synchronous في orders-v2.service.ts.
   */
  async profits(range: 'today' | 'week' | 'month' | 'custom', from?: string, to?: string) {
    const { start, end } = this.resolveProfitRange(range, from, to);
    const where = { status: 'COMPLETED' as const, deliveredAt: { gte: start, lte: end } };

    const [byAgency, totals] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['agencyId'],
        where,
        _sum: { subtotal: true, commissionAmount: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where,
        _sum: { subtotal: true, commissionAmount: true, total: true },
        _count: true,
      }),
    ]);

    const agencies = await this.prisma.agency.findMany({
      where: { id: { in: byAgency.map((r) => r.agencyId).filter((id): id is string => !!id) } },
      select: { id: true, nameAr: true, status: true },
    });
    const agencyById = new Map(agencies.map((a) => [a.id, a]));

    const rows = byAgency
      .filter((r) => r.agencyId)
      .map((r) => ({
        agencyId: r.agencyId,
        agencyName: agencyById.get(r.agencyId!)?.nameAr ?? '—',
        agencyStatus: agencyById.get(r.agencyId!)?.status ?? '—',
        orderCount: r._count,
        grossSales: Number(r._sum.subtotal ?? 0),
        platformCommission: Number(r._sum.commissionAmount ?? 0),
      }))
      .sort((a, b) => b.grossSales - a.grossSales);

    return {
      range: { key: range, start, end },
      totals: {
        orderCount: totals._count,
        grossSales: Number(totals._sum.subtotal ?? 0),
        platformCommission: Number(totals._sum.commissionAmount ?? 0),
        gmv: Number(totals._sum.total ?? 0), // إجمالي ما دفعه الزبائن: مبيعات + عمولة
      },
      agencies: rows,
    };
  }

  // ============ نظرة عامة ============

  async stats() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
    const activeStatuses = ['SEARCHING', 'WAITING_FOR_DRIVER', 'AGENCY_ASSIGNED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING'];

    const [agencies, driversTotal, driversOnline, customers, ordersToday, activeOrders, waitingOrders, completedToday, commToday, commMonth, openTickets, walletTotal] =
      await Promise.all([
        this.prisma.agency.groupBy({ by: ['status'], _count: true }),
        this.prisma.driverProfile.count(),
        this.prisma.driverProfile.count({ where: { status: { not: 'OFFLINE' } } }),
        this.prisma.user.count({ where: { roles: { none: {} }, driverProfile: null } }),
        this.prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
        this.prisma.order.count({ where: { status: { in: activeStatuses as never[] } } }),
        // طلبات عالقة بلا سائق الآن — مؤشر نقص سائقين لا نقص تغطية
        this.prisma.order.count({ where: { status: 'WAITING_FOR_DRIVER' } }),
        this.prisma.order.count({ where: { status: 'COMPLETED', deliveredAt: { gte: startOfDay } } }),
        this.prisma.ledgerEntry.aggregate({
          where: { type: 'COMMISSION', createdAt: { gte: startOfDay } },
          _sum: { amount: true },
        }),
        this.prisma.ledgerEntry.aggregate({
          where: { type: 'COMMISSION', createdAt: { gte: startOfMonth } },
          _sum: { amount: true },
        }),
        this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
        this.prisma.wallet.aggregate({ _sum: { balance: true } }),
      ]);
    const agencyCounts = Object.fromEntries(agencies.map((a) => [a.status, a._count]));
    return {
      agencies: {
        total: agencies.reduce((s, a) => s + a._count, 0),
        active: agencyCounts['ACTIVE'] ?? 0,
        pendingApproval: agencyCounts['PENDING_APPROVAL'] ?? 0,
        paused: agencyCounts['PAUSED'] ?? 0,
        suspended: agencyCounts['SUSPENDED'] ?? 0,
      },
      drivers: { total: driversTotal, online: driversOnline },
      customers,
      ordersToday,
      activeOrders,
      waitingOrders,
      completedToday,
      platformRevenueToday: Math.abs(Number(commToday._sum.amount ?? 0)),
      platformRevenueMonth: Math.abs(Number(commMonth._sum.amount ?? 0)),
      openTickets,
      agencyWalletsTotal: Number(walletTotal._sum.balance ?? 0),
    };
  }

  // ============ الطلبات ============

  /**
   * مجموعات حالات الطلب كما تُقرأ لا كما تُخزَّن. الحالات تسع، ومن يفتح
   * الصفحة يسأل أربعة أسئلة فقط: ما زال جارياً؟ وصل؟ أُلغي؟ تعثّر؟
   * والقائمة المفصّلة تبقى لمن يريد حالةً بعينها.
   */
  private static readonly ORDER_GROUPS: Record<string, OrderStatus[]> = {
    ongoing: [
      OrderStatus.CREATED,
      OrderStatus.SEARCHING,
      OrderStatus.WAITING_FOR_DRIVER,
      OrderStatus.AGENCY_ASSIGNED,
      OrderStatus.DRIVER_ASSIGNED,
      OrderStatus.PICKED_UP,
      OrderStatus.DELIVERING,
    ],
    completed: [OrderStatus.COMPLETED],
    cancelled: [OrderStatus.CANCELLED],
    failed: [OrderStatus.SEARCH_FAILED],
  };

  /**
   * نافذة زمنية بالأيام. `days = 0` تعني «كل الوقت» — وهي حالة صريحة لا
   * غياب قيمة، فلا تُخلط مع «لم يُرسل بارامتر».
   */
  private sinceDays(days?: number): Date | undefined {
    if (!days || days <= 0) return undefined;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private ordersWhere(opts: {
    status?: string;
    group?: string;
    q?: string;
    days?: number;
  }): Prisma.OrderWhereInput {
    const since = this.sinceDays(opts.days);
    const group = opts.group
      ? PlatformService.ORDER_GROUPS[opts.group]
      : undefined;
    if (opts.group && !group) {
      throw new BadRequestException('تصنيف طلبات غير معروف');
    }
    return {
      // الحالة المفردة أضيق من المجموعة، فتغلبها حين تُرسل الاثنتان
      ...(opts.status
        ? { status: opts.status as OrderStatus }
        : group
          ? { status: { in: group } }
          : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(opts.q ? { code: { contains: opts.q, mode: 'insensitive' as const } } : {}),
    };
  }

  listOrders(status?: string, q?: string, group?: string, days?: number) {
    return this.prisma.order.findMany({
      where: this.ordersWhere({ status, q, group, days }),
      include: {
        agency: { select: { nameAr: true } },
        customer: { select: { name: true, phone: true } },
        driver: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** أعداد المجموعات ضمن النافذة نفسها — أرقام تبويبات صفحة الطلبات */
  async orderGroupCounts(days?: number, q?: string) {
    const entries = Object.keys(PlatformService.ORDER_GROUPS);
    const [all, ...counts] = await Promise.all([
      this.prisma.order.count({ where: this.ordersWhere({ q, days }) }),
      ...entries.map((group) =>
        this.prisma.order.count({ where: this.ordersWhere({ group, q, days }) }),
      ),
    ]);
    const out: Record<string, number> = { all };
    entries.forEach((g, i) => (out[g] = counts[i]));
    return out;
  }

  /**
   * تحليلات الطلبات على نافذة زمنية.
   *
   * لماذا SQL خام: السلسلة اليومية تحتاج ملء الأيام الفارغة وحساب مدد من
   * سجل الحالات في استعلام واحد. جلبها صفاً صفاً إلى Node ثم تجميعها في
   * الذاكرة يعني تحميل كل طلبات الفترة لبناء عشرة أرقام.
   *
   * اليوم الفارغ يظهر بصفر لا يُحذف: رسمٌ يقفز من الأحد إلى الثلاثاء يخفي
   * أن الاثنين لم يكن فيه طلب — وهو الخبر نفسه.
   */
  async orderAnalytics(days = 30) {
    const window = Math.min(365, Math.max(1, Math.floor(days) || 30));
    const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);

    const [totals, series, money, speed, topAgencies, topAreas] =
      await Promise.all([
        this.prisma.order.groupBy({
          by: ['status'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<
          {
            day: Date;
            total: bigint;
            completed: bigint;
            cancelled: bigint;
            failed: bigint;
            revenue: string | null;
          }[]
        >`
          SELECT d.day::date AS day,
                 COUNT(o.id)                                          AS total,
                 COUNT(o.id) FILTER (WHERE o.status = 'COMPLETED')     AS completed,
                 COUNT(o.id) FILTER (WHERE o.status = 'CANCELLED')     AS cancelled,
                 COUNT(o.id) FILTER (WHERE o.status = 'SEARCH_FAILED') AS failed,
                 COALESCE(SUM(o.total) FILTER (WHERE o.status = 'COMPLETED'), 0)::text AS revenue
          FROM generate_series(${since}::date, NOW()::date, '1 day') AS d(day)
          LEFT JOIN "Order" o ON o."createdAt"::date = d.day
          GROUP BY d.day
          ORDER BY d.day
        `,
        this.prisma.order.aggregate({
          where: { createdAt: { gte: since }, status: OrderStatus.COMPLETED },
          _sum: { total: true, commissionAmount: true, discountAmount: true },
          _avg: { total: true },
          _count: { _all: true },
        }),
        // المدد من سجل الحالات: من إنشاء الطلب إلى تعيين سائق، ومنه إلى
        // التسليم. المتوسط بالدقائق — الثواني رقمٌ لا يُقرأ.
        this.prisma.$queryRaw<
          { toDriverMin: number | null; toDeliverMin: number | null }[]
        >`
          SELECT
            AVG(EXTRACT(EPOCH FROM (h.assigned - o."createdAt")) / 60)  AS "toDriverMin",
            AVG(EXTRACT(EPOCH FROM (h.done - o."createdAt")) / 60)      AS "toDeliverMin"
          FROM "Order" o
          JOIN LATERAL (
            SELECT MIN(s."createdAt") FILTER (WHERE s.status = 'DRIVER_ASSIGNED') AS assigned,
                   MIN(s."createdAt") FILTER (WHERE s.status = 'COMPLETED')       AS done
            FROM "OrderStatusHistory" s WHERE s."orderId" = o.id
          ) h ON TRUE
          WHERE o."createdAt" >= ${since} AND o.status = 'COMPLETED'
        `,
        this.prisma.$queryRaw<
          { nameAr: string; completed: bigint; revenue: string }[]
        >`
          SELECT a."nameAr",
                 COUNT(o.id)                        AS completed,
                 COALESCE(SUM(o.total), 0)::text    AS revenue
          FROM "Order" o JOIN "Agency" a ON a.id = o."agencyId"
          WHERE o."createdAt" >= ${since} AND o.status = 'COMPLETED'
          GROUP BY a."nameAr"
          ORDER BY completed DESC
          LIMIT 5
        `,
        this.prisma.$queryRaw<{ nameAr: string; total: bigint }[]>`
          SELECT COALESCE(z."nameAr", 'غير محدَّدة') AS "nameAr",
                 COUNT(o.id)                          AS total
          FROM "Order" o LEFT JOIN "Zone" z ON z.id = o."zoneId"
          WHERE o."createdAt" >= ${since}
          GROUP BY z."nameAr"
          ORDER BY total DESC
          LIMIT 5
        `,
      ]);

    const byStatus: Record<string, number> = {};
    let all = 0;
    for (const g of totals) {
      byStatus[g.status] = g._count._all;
      all += g._count._all;
    }
    const completed = byStatus[OrderStatus.COMPLETED] ?? 0;
    const cancelled = byStatus[OrderStatus.CANCELLED] ?? 0;
    const failed = byStatus[OrderStatus.SEARCH_FAILED] ?? 0;
    const pct = (n: number) => (all ? Math.round((n / all) * 1000) / 10 : 0);

    return {
      days: window,
      since,
      total: all,
      byStatus,
      rates: {
        completed: pct(completed),
        cancelled: pct(cancelled),
        failed: pct(failed),
      },
      money: {
        revenue: Number(money._sum.total ?? 0),
        commission: Number(money._sum.commissionAmount ?? 0),
        discounts: Number(money._sum.discountAmount ?? 0),
        averageOrder: Number(money._avg.total ?? 0),
        completedCount: money._count._all,
      },
      speed: {
        minutesToDriver: speed[0]?.toDriverMin
          ? Math.round(Number(speed[0].toDriverMin))
          : null,
        minutesToDeliver: speed[0]?.toDeliverMin
          ? Math.round(Number(speed[0].toDeliverMin))
          : null,
      },
      series: series.map((r) => ({
        day: r.day,
        total: Number(r.total),
        completed: Number(r.completed),
        cancelled: Number(r.cancelled),
        failed: Number(r.failed),
        revenue: Number(r.revenue ?? 0),
      })),
      topAgencies: topAgencies.map((a) => ({
        nameAr: a.nameAr,
        completed: Number(a.completed),
        revenue: Number(a.revenue),
      })),
      topAreas: topAreas.map((a) => ({
        nameAr: a.nameAr,
        total: Number(a.total),
      })),
    };
  }

  /**
   * تفاصيل الطلب كاملة لشاشة "السجل والتتبع" — الوقت والمسار والموقع
   * الحي، لا الأحداث الإدارية وحدها كما كانت `orderTimeline` تكتفي بها.
   */
  async orderTimeline(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, phone: true } },
        agency: { select: { nameAr: true, phone: true } },
        branch: { select: { nameAr: true, lat: true, lng: true } },
        driver: {
          select: {
            name: true,
            phone: true,
            driverProfile: {
              select: { currentLat: true, currentLng: true, lastSeenAt: true, vehiclePlate: true },
            },
          },
        },
        items: {
          include: { bottleType: { select: { nameAr: true, sizeLiters: true } } },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        assignmentHistory: {
          orderBy: { createdAt: 'asc' },
          include: {
            agency: { select: { nameAr: true } },
            driver: { select: { name: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    return order;
  }

  // ============ التذاكر ============

  /**
   * نموذج الشكاوى: المشتكي يرسل والدعم يتصل به. لذلك يجب أن تحمل القائمة
   * **اسمه ورقمه ونص شكواه** — بدونها التذكرة بلا فائدة تشغيلية.
   */
  /**
   * تذاكر الدعم مع **صفة صاحبها**: زبون أم سائق أم وكالة.
   *
   * الاسم والرقم وحدهما لا يقولان مع من نتكلم، والفرق عملي لا تجميلي: سائق
   * متوقف عن العمل أو وكالة معطَّلة الطلبات تسبق شكوى زبون عن تأخير. تُحسب
   * الصفة من أدوار المستخدم لا من نوع التذكرة، فمصدرها واحد لكل القنوات.
   */
  async listTickets(status?: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: status ? { status: status as TicketStatus } : {},
      include: {
        order: { select: { code: true } },
        agency: { select: { nameAr: true } },
        assignedTo: { select: { name: true } },
        createdBy: { select: { id: true, name: true, phone: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { bodyAr: true },
        },
      },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });

    const userIds = [...new Set(
      tickets.map((t) => t.createdBy?.id).filter((id): id is string => !!id),
    )];
    if (!userIds.length) return tickets.map((t) => ({ ...t, senderRole: null }));

    // استعلام واحد لكل التذاكر لا استعلام لكل تذكرة
    const roles = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        agency: { select: { nameAr: true } },
        role: { select: { name: true, scope: true } },
      },
    });

    const byUser = new Map<string, typeof roles>();
    for (const r of roles) {
      const list = byUser.get(r.userId) ?? [];
      list.push(r);
      byUser.set(r.userId, list);
    }

    return tickets.map((t) => {
      const mine = t.createdBy ? (byUser.get(t.createdBy.id) ?? []) : [];
      // الأخصّ أولاً: موظف منصة، ثم سائق، ثم وكالة. من لا دور له زبون.
      let senderRole: { key: string; labelAr: string; agencyName?: string } | null;
      const platform = mine.find((r) => r.role.scope === 'PLATFORM');
      const driver = mine.find((r) => r.role.name === 'DRIVER');
      const agency = mine.find((r) => r.role.scope === 'AGENCY' && r.role.name !== 'DRIVER');
      if (platform) {
        senderRole = { key: 'PLATFORM', labelAr: 'موظف منصة' };
      } else if (driver) {
        senderRole = {
          key: 'DRIVER',
          labelAr: 'سائق',
          agencyName: driver.agency?.nameAr ?? undefined,
        };
      } else if (agency) {
        senderRole = {
          key: 'AGENCY',
          labelAr: agency.role.name === 'AGENCY_OWNER' ? 'صاحب وكالة' : 'موظف وكالة',
          agencyName: agency.agency?.nameAr ?? undefined,
        };
      } else {
        senderRole = { key: 'CUSTOMER', labelAr: 'زبون' };
      }
      return { ...t, senderRole };
    });
  }

  /** سلسلة رسائل تذكرة كاملة — القائمة تكتفي بأول رسالة، وهذه للمحادثة */
  async ticketMessages(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        code: true,
        status: true,
        createdBy: {
          select: {
            id: true,
            name: true,
            phone: true,
            username: true,
            email: true,
            createdAt: true,
            lastLoginAt: true,
            // حالتا المستخدم كما يحتاجهما من يقرّر: محظور عن الدعم؟ وحسابه
            // نفسه معطَّل؟ بدونهما يضغط الموظف «حظر» على محظور أصلاً
            status: true,
            supportBlockedAt: true,
            supportBlockReason: true,
            // سائق؟ فمركبته وتقييمه وحالته تخصّ أي شكوى عنه أو منه
            driverProfile: {
              select: {
                vehiclePlate: true,
                status: true,
                rating: true,
                ratingCount: true,
                isVerified: true,
                agency: { select: { nameAr: true, phone: true } },
              },
            },
            roles: {
              select: {
                role: { select: { name: true, nameAr: true, scope: true } },
                agency: { select: { nameAr: true, phone: true } },
              },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            bodyAr: true,
            authorUserId: true,
            createdAt: true,
            author: { select: { name: true } },
          },
        },
      },
    });
    if (!ticket) throw new NotFoundException('التذكرة غير موجودة');

    // نشاط صاحب التذكرة: عدد طلباته وآخر طلب. سياق يغيّر نبرة الرد —
    // زبون منذ سنة بعشرات الطلبات ليس كمن يشكو من أول طلب.
    const u = ticket.createdBy;
    const activity = !u
      ? null
      : await this.prisma.order
          .aggregate({
            where: { customerId: u.id },
            _count: { _all: true },
            _max: { createdAt: true },
          })
          .then((a) => ({
            ordersCount: a._count._all,
            lastOrderAt: a._max.createdAt,
          }));

    return {
      id: ticket.id,
      code: ticket.code,
      status: ticket.status,
      customer: u ? { ...u, activity } : null,
      messages: ticket.messages.map((m) => ({
        id: m.id,
        bodyAr: m.bodyAr,
        authorName: m.author?.name ?? '—',
        // رسالة الزبون مقابل رد الدعم — يميّزها كاتبها
        fromCustomer: m.authorUserId === ticket.createdBy?.id,
        createdAt: m.createdAt,
      })),
    };
  }

  async updateTicket(
    ticketId: string,
    data: { status: TicketStatus },
    actorId: string,
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('التذكرة غير موجودة');
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: data.status,
        assignedToUserId: ticket.assignedToUserId ?? actorId,
        resolvedAt:
          data.status === 'RESOLVED' || data.status === 'CLOSED' ? new Date() : null,
      },
    });
    await this.audit(actorId, 'ticket.status.update', 'SupportTicket', ticketId,
      { status: ticket.status }, { status: data.status });
    return updated;
  }

  // ============ المدن والمناطق ============

  listCities() {
    return this.prisma.city.findMany({
      include: { _count: { select: { districts: true, zones: true, agencies: true } } },
      orderBy: { nameAr: 'asc' },
    });
  }

  async createCity(nameAr: string, actorId: string) {
    const city = await this.prisma.city.create({ data: { nameAr } });
    await this.audit(actorId, 'city.create', 'City', city.id, undefined, { nameAr });
    return city;
  }

  async setCityActive(cityId: string, active: boolean, actorId: string) {
    const city = await this.prisma.city.update({ where: { id: cityId }, data: { active } });
    await this.audit(actorId, 'city.active.update', 'City', cityId, undefined, { active });
    return city;
  }

  // ---- المناطق (Districts) ----

  async listDistricts(cityId?: string) {
    const [districts, withGeom] = await Promise.all([
      this.prisma.district.findMany({
        where: cityId ? { cityId } : {},
        include: {
          city: { select: { nameAr: true } },
          _count: { select: { neighborhoods: true } },
        },
        orderBy: [{ city: { nameAr: 'asc' } }, { nameAr: 'asc' }],
      }),
      this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "District" WHERE geom IS NOT NULL`,
    ]);
    const hasGeom = new Set(withGeom.map((r) => r.id));
    return districts.map((d) => ({ ...d, hasBoundary: hasGeom.has(d.id) }));
  }

  async createDistrict(cityId: string, nameAr: string, actorId: string) {
    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    if (!city) throw new NotFoundException('المدينة غير موجودة');
    const district = await this.prisma.district.create({ data: { cityId, nameAr } });
    await this.audit(actorId, 'district.create', 'District', district.id, undefined, { cityId, nameAr });
    return district;
  }

  async updateDistrict(
    districtId: string,
    data: { nameAr?: string; active?: boolean },
    actorId: string,
  ) {
    const district = await this.prisma.district.findUnique({ where: { id: districtId } });
    if (!district) throw new NotFoundException('المنطقة غير موجودة');
    const updated = await this.prisma.district.update({ where: { id: districtId }, data });
    await this.audit(actorId, 'district.update', 'District', districtId,
      { nameAr: district.nameAr, active: district.active },
      { nameAr: updated.nameAr, active: updated.active });
    return updated;
  }

  // ---- الأحياء (Neighborhoods) ----

  async listNeighborhoods(districtId?: string, cityId?: string) {
    const [neighborhoods, withGeom] = await Promise.all([
      this.prisma.neighborhood.findMany({
        where: {
          ...(districtId ? { districtId } : {}),
          ...(cityId ? { district: { cityId } } : {}),
        },
        include: {
          district: { select: { nameAr: true, cityId: true, city: { select: { nameAr: true } } } },
          _count: { select: { zones: true } },
        },
        orderBy: [{ district: { nameAr: 'asc' } }, { nameAr: 'asc' }],
      }),
      this.prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Neighborhood" WHERE geom IS NOT NULL`,
    ]);
    const hasGeom = new Set(withGeom.map((r) => r.id));
    return neighborhoods.map((n) => ({ ...n, hasBoundary: hasGeom.has(n.id) }));
  }

  async createNeighborhood(districtId: string, nameAr: string, actorId: string) {
    const district = await this.prisma.district.findUnique({ where: { id: districtId } });
    if (!district) throw new NotFoundException('المنطقة غير موجودة');
    const neighborhood = await this.prisma.neighborhood.create({ data: { districtId, nameAr } });
    await this.audit(actorId, 'neighborhood.create', 'Neighborhood', neighborhood.id, undefined, { districtId, nameAr });
    return neighborhood;
  }

  async updateNeighborhood(
    neighborhoodId: string,
    data: { nameAr?: string; active?: boolean },
    actorId: string,
  ) {
    const neighborhood = await this.prisma.neighborhood.findUnique({ where: { id: neighborhoodId } });
    if (!neighborhood) throw new NotFoundException('الحي غير موجود');
    const updated = await this.prisma.neighborhood.update({ where: { id: neighborhoodId }, data });
    await this.audit(actorId, 'neighborhood.update', 'Neighborhood', neighborhoodId,
      { nameAr: neighborhood.nameAr, active: neighborhood.active },
      { nameAr: updated.nameAr, active: updated.active });
    return updated;
  }

  // ---- الخريطة: عرض حدود مستوردة والتحقق من المواقع (لا رسم يدوي) ----

  /** كل الحدود المستوردة (مناطق + أحياء) كـ GeoJSON للعرض */
  geoBoundaries() {
    return this.prisma.$queryRaw`
      SELECT 'district' AS level, d.id, d."nameAr", c."nameAr" AS "cityName",
             NULL::text AS "districtName", d.active,
             ST_AsGeoJSON(d.geom)::json AS geojson
      FROM "District" d JOIN "City" c ON c.id = d."cityId"
      WHERE d.geom IS NOT NULL
      UNION ALL
      SELECT 'neighborhood', n.id, n."nameAr", c."nameAr",
             d."nameAr", n.active,
             ST_AsGeoJSON(n.geom)::json
      FROM "Neighborhood" n
      JOIN "District" d ON d.id = n."districtId"
      JOIN "City" c ON c.id = d."cityId"
      WHERE n.geom IS NOT NULL
    `;
  }

  /** ماذا يقول كل مستوى عن هذه النقطة؟ — أداة التحقق في لوحة المنصة */
  resolvePoint(lat: number, lng: number) {
    return this.prisma.$queryRaw`
      WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS g)
      (SELECT 'neighborhood' AS level, n."nameAr" AS name, d."nameAr" AS parent,
              c."nameAr" AS city
       FROM "Neighborhood" n
       JOIN "District" d ON d.id = n."districtId"
       JOIN "City" c ON c.id = d."cityId", pt
       WHERE n.active AND n.geom IS NOT NULL AND ST_Contains(n.geom, pt.g)
       LIMIT 1)
      UNION ALL
      (SELECT 'zone', z."nameAr", n2."nameAr", c."nameAr"
       FROM "Zone" z
       JOIN "City" c ON c.id = z."cityId"
       LEFT JOIN "Neighborhood" n2 ON n2.id = z."neighborhoodId", pt
       WHERE z.active AND ST_Contains(z.geom, pt.g)
       LIMIT 1)
      UNION ALL
      (SELECT 'district', d."nameAr", NULL, c."nameAr"
       FROM "District" d
       JOIN "City" c ON c.id = d."cityId", pt
       WHERE d.active AND d.geom IS NOT NULL AND ST_Contains(d.geom, pt.g)
       LIMIT 1)
    `;
  }

  /** كل المناطق (حتى المعطلة) مع GeoJSON للرسم على الخريطة والتسلسل الإداري */
  listZones() {
    return this.prisma.$queryRaw`
      SELECT z.id, z."nameAr", z.active,
             c.id AS "cityId", c."nameAr" AS "cityName",
             n.id AS "neighborhoodId", n."nameAr" AS "neighborhoodName",
             d.id AS "districtId", d."nameAr" AS "districtName",
             ST_AsGeoJSON(z.geom)::json AS geojson
      FROM "Zone" z
      JOIN "City" c ON c.id = z."cityId"
      LEFT JOIN "Neighborhood" n ON n.id = z."neighborhoodId"
      LEFT JOIN "District" d ON d.id = n."districtId"
      ORDER BY c."nameAr", z."nameAr"
    `;
  }

  // ============ الوكالات والتغطية (خريطة السوبر أدمن) ============

  /**
   * كل وكالة كنقطة + دائرة نطاق + حالتها التشغيلية الآن + وصف موقعها
   * المشتق من GPS (منطقة/حي) — المصدر الوحيد لصفحة "الوكالات والتغطية".
   */
  async coverageMap(cityId?: string) {
    type Row = {
      agencyId: string; agencyName: string; status: string; paused: boolean;
      autoDispatch: boolean; rating: number; cityName: string;
      branchId: string; branchName: string; lat: number; lng: number;
      deliveryRadiusKm: number; areaName: string | null; districtName: string | null;
      ownerName: string | null; ownerPhone: string | null;
      driversTotal: number; driversAvailable: number; activeOrders: number;
      balance: number; openNow: boolean;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT a.id AS "agencyId", a."nameAr" AS "agencyName", a.status::text AS status,
             (a.status = 'PAUSED') AS paused, a."autoDispatch", a.rating,
             c."nameAr" AS "cityName",
             b.id AS "branchId", b."nameAr" AS "branchName",
             b.lat, b.lng, b."deliveryRadiusKm",
             COALESCE(n."nameAr", d."nameAr") AS "areaName",
             d."nameAr" AS "districtName",
             owner.name AS "ownerName", owner.phone AS "ownerPhone",
             (SELECT count(*)::int FROM "DriverProfile" dp WHERE dp."agencyId" = a.id) AS "driversTotal",
             (SELECT count(*)::int FROM "DriverProfile" dp
               WHERE dp."agencyId" = a.id AND dp.status = 'AVAILABLE') AS "driversAvailable",
             (SELECT count(*)::int FROM "Order" o
               WHERE o."agencyId" = a.id
                 AND o.status IN ('AGENCY_ASSIGNED','DRIVER_ASSIGNED','PICKED_UP','DELIVERING')) AS "activeOrders",
             COALESCE(w.balance, 0)::float8 AS balance,
             -- لا جدول دوام: الوكالة مفتوحة ما لم تكن في إجازة اليوم
             NOT EXISTS (
               SELECT 1 FROM "AgencyHoliday" hol
               WHERE hol."agencyId" = a.id
                 AND hol.date = (now() AT TIME ZONE 'Asia/Amman')::date
             ) AS "openNow"
      FROM "Agency" a
      JOIN "City" c ON c.id = a."cityId"
      JOIN "AgencyBranch" b ON b."agencyId" = a.id AND b.active
      LEFT JOIN "Wallet" w ON w."agencyId" = a.id
      LEFT JOIN LATERAL (
        SELECT nb."nameAr", nb."districtId" FROM "Neighborhood" nb
        WHERE nb.geom IS NOT NULL
          AND ST_Contains(nb.geom, ST_SetSRID(ST_MakePoint(b.lng, b.lat), 4326))
        LIMIT 1
      ) n ON true
      LEFT JOIN LATERAL (
        SELECT di."nameAr" FROM "District" di
        WHERE di.geom IS NOT NULL
          AND ST_Contains(di.geom, ST_SetSRID(ST_MakePoint(b.lng, b.lat), 4326))
        LIMIT 1
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT u.name, u.phone FROM "UserRole" ur
        JOIN "Role" r ON r.id = ur."roleId" AND r.name = 'AGENCY_OWNER'
        JOIN "User" u ON u.id = ur."userId"
        WHERE ur."agencyId" = a.id
        LIMIT 1
      ) owner ON true
      ${cityId ? Prisma.sql`WHERE a."cityId" = ${cityId}` : Prisma.empty}
      ORDER BY a."nameAr"
    `;
    return rows.map((r) => ({ ...r, state: this.agencyMapState(r) }));
  }

  /** لون الدبوس: أخضر تعمل، أصفر مشغولة، أحمر مغلقة، رمادي غير مفعّلة */
  private agencyMapState(r: {
    status: string; openNow: boolean; balance: number; driversAvailable: number;
  }): 'WORKING' | 'BUSY' | 'CLOSED' | 'INACTIVE' {
    if (r.status !== 'ACTIVE') return 'INACTIVE';
    if (!r.openNow || r.balance <= 0) return 'CLOSED';
    if (r.driversAvailable === 0) return 'BUSY';
    return 'WORKING';
  }

  /**
   * فجوات التغطية: نسبة مساحة كل منطقة إدارية التي تقع داخل دوائر الوكالات
   * العاملة. النسبة تقريبية (مساحات بدرجات 4326) لكنها كافية لكشف الفراغات:
   * 0% = لا وكالة تصل هذه المنطقة → مرشحة لاستقطاب وكالة جديدة.
   */
  coverageGaps(cityId?: string) {
    return this.prisma.$queryRaw`
      WITH circles AS (
        SELECT ST_Union(
                 ST_Buffer(ST_MakePoint(b.lng, b.lat)::geography,
                           b."deliveryRadiusKm" * 1000.0)::geometry
               ) AS g
        FROM "AgencyBranch" b
        JOIN "Agency" a ON a.id = b."agencyId"
        WHERE b.active AND a.status = 'ACTIVE'
      )
      SELECT d.id, d."nameAr", c."nameAr" AS "cityName",
             ST_AsGeoJSON(d.geom)::json AS geojson,
             CASE
               WHEN circles.g IS NULL THEN 0
               ELSE ROUND((ST_Area(ST_Intersection(d.geom, circles.g))
                          / NULLIF(ST_Area(d.geom), 0) * 100)::numeric, 1)
             END::float8 AS "coveredPct"
      FROM "District" d
      JOIN "City" c ON c.id = d."cityId"
      CROSS JOIN circles
      WHERE d.geom IS NOT NULL AND d.active
        ${cityId ? Prisma.sql`AND d."cityId" = ${cityId}` : Prisma.empty}
      ORDER BY "coveredPct" ASC, d."nameAr"
    `;
  }

  /**
   * إنشاء منطقة بمركز ونصف قطر (ST_Buffer) — حل V1 العملي؛
   * رسم Polygon حر يُضاف لاحقاً دون تغيير المخطط.
   */
  async createZone(
    data: { cityId: string; nameAr: string; lat: number; lng: number; radiusM: number; neighborhoodId?: string },
    actorId: string,
  ) {
    if (data.radiusM < 200 || data.radiusM > 20000) {
      throw new BadRequestException('نصف القطر بين 200 و 20000 متر');
    }
    const city = await this.prisma.city.findUnique({ where: { id: data.cityId } });
    if (!city) throw new NotFoundException('المدينة غير موجودة');
    if (data.neighborhoodId) {
      const neighborhood = await this.prisma.neighborhood.findUnique({
        where: { id: data.neighborhoodId },
        include: { district: { select: { cityId: true } } },
      });
      if (!neighborhood) throw new NotFoundException('الحي غير موجود');
      if (neighborhood.district.cityId !== data.cityId) {
        throw new BadRequestException('الحي لا يتبع المدينة المختارة');
      }
    }
    const id = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "Zone" (id, "cityId", "neighborhoodId", "nameAr", active, geom)
      VALUES (${id}, ${data.cityId}, ${data.neighborhoodId ?? null}, ${data.nameAr}, true,
        ST_Buffer(ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography, ${data.radiusM})::geometry)
    `;
    await this.audit(actorId, 'zone.create', 'Zone', id, undefined, {
      ...data,
    });
    return { id, ...data, active: true };
  }

  async updateZone(
    zoneId: string,
    data: { active?: boolean; neighborhoodId?: string | null },
    actorId: string,
  ) {
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: { id: true, cityId: true, active: true, neighborhoodId: true },
    });
    if (!zone) throw new NotFoundException('المنطقة غير موجودة');
    if (data.neighborhoodId) {
      const neighborhood = await this.prisma.neighborhood.findUnique({
        where: { id: data.neighborhoodId },
        include: { district: { select: { cityId: true } } },
      });
      if (!neighborhood) throw new NotFoundException('الحي غير موجود');
      if (neighborhood.district.cityId !== zone.cityId) {
        throw new BadRequestException('الحي لا يتبع مدينة المنطقة');
      }
    }
    const updated = await this.prisma.zone.update({
      where: { id: zoneId },
      data,
      select: { id: true, nameAr: true, active: true, neighborhoodId: true },
    });
    await this.audit(actorId, 'zone.update', 'Zone', zoneId,
      { active: zone.active, neighborhoodId: zone.neighborhoodId },
      { active: updated.active, neighborhoodId: updated.neighborhoodId });
    return updated;
  }

  // ============ المستخدمون ============

  /**
   * تصنيف الحسابات كما تراه اللوحة. الفرز في الخادم لا في المتصفح: القائمة
   * محدودة بثلاثين صفاً، وفرزُ صفحةٍ واحدة يعرض «سائقين» لا يشملون إلا من
   * صادف وجوده في آخر ثلاثين حساباً — تصنيفٌ يكذب بصمت.
   *
   * التصنيف يقابل userType في اللوحة حرفاً بحرف: زبون بلا أدوار إطلاقاً،
   * وسائق يُعرف بملفه لا بدوره، وموظف وكالة دورُه مربوط بوكالة، وموظف منصة
   * دورُه بلا وكالة (والمدير الأعلى منهم).
   */
  private static readonly USER_KIND_FILTERS: Record<
    string,
    Prisma.UserWhereInput
  > = {
    customer: { roles: { none: {} }, driverProfile: { is: null } },
    driver: { driverProfile: { isNot: null } },
    agency: {
      driverProfile: { is: null },
      roles: { some: { agencyId: { not: null } } },
    },
    platform: { roles: { some: { agencyId: null } } },
  };

  searchUsers(q?: string, kind?: string) {
    // "0790000040" محلياً يُخزَّن "+962790000040" — نبحث بالصيغتين
    const phoneVariants = q
      ? [q, ...(/^0\d+$/.test(q) ? [q.slice(1)] : [])]
      : [];
    const kindWhere = kind
      ? PlatformService.USER_KIND_FILTERS[kind]
      : undefined;
    if (kind && !kindWhere) throw new BadRequestException('تصنيف غير معروف');
    return this.prisma.user.findMany({
      where: {
        ...(kindWhere ?? {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { username: { contains: q.toLowerCase() } },
                { email: { contains: q.toLowerCase() } },
                ...phoneVariants.map((p) => ({ phone: { contains: p } })),
              ],
            }
          : {}),
      },
      // select صريح: passwordHash لا يخرج من الخادم أبداً
      select: {
        id: true,
        name: true,
        username: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        roles: { include: { role: { select: { name: true, nameAr: true } }, agency: { select: { nameAr: true } } } },
        driverProfile: { select: { status: true, agency: { select: { nameAr: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** كم حساباً في كل تصنيف — أرقام التبويبات، تُحسب في الخادم على الكل */
  async userKindCounts() {
    const entries = Object.entries(PlatformService.USER_KIND_FILTERS);
    const counts = await Promise.all(
      entries.map(([, where]) => this.prisma.user.count({ where })),
    );
    const out: Record<string, number> = {
      all: await this.prisma.user.count(),
    };
    entries.forEach(([kind], i) => (out[kind] = counts[i]));
    return out;
  }

  /**
   * يمسح حدّ إغراق OTP عبر واتساب (طلب + تحقق) لهاتف مستخدم — للحالات
   * المشروعة (رقم أخطأ الطلب مراراً بالغلط) بدل انتظار انتهاء النافذة
   * الزمنية. لا يمسّ سجل RateLimitViolation (عرض تاريخي فقط).
   */
  // ============ قناة رمز التحقق ============

  /**
   * القناة العامة واستثناءاتها. التبديل يسري في اللحظة على كل من يطلب رمزاً
   * بعده — القراءة تتم عند كل إرسال بلا ذاكرة وسيطة (OtpDeliveryService).
   */
  async getOtpChannel() {
    const row = await this.prisma.otpChannelSettings.findUnique({
      where: { id: 1 },
      include: { editor: { select: { id: true, name: true } } },
    });
    const overrides = await this.prisma.otpChannelOverride.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { editor: { select: { id: true, name: true } } },
    });
    return {
      channel: row?.channel ?? 'OPENWA',
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.editor ?? null,
      // القاعدة أولاً ثم متغيّر البيئة — نفس ترتيب الخادم عند القراءة
      waGatewayNumber:
        row?.waGatewayNumber ?? process.env.WHATSAPP_GATEWAY_NUMBER ?? null,
      /// من أين جاءت القيمة المعروضة — يفرّق للأدمن بين رقمٍ ضبطه هو وآخر
      /// موروث من متغيّر بيئة لا يراه في أي شاشة
      waGatewayFromEnv: !row?.waGatewayNumber,
      overrides,
    };
  }

  /**
   * رقم واتساب الذي يراسله الزبون في مصافحة التحقق.
   *
   * **يُرفض الرقم الناقص هنا لا عند الاستعمال.** ضُبط مرة بـ«+962» وحدها
   * فبُني منه `wa.me/962`، ففتح واتساب على «لا حساب لهذا الرقم» — خطأٌ لا
   * يظهر إلا للزبون في آخر الطريق. التحقق عند الحفظ يمنعه من الوصول أصلاً.
   *
   * الفراغ مقبول ويعني التعطيل: الأدمن قد يُطفئ المسار عمداً.
   */
  async setWaGatewayNumber(rawNumber: string | null, actorId: string) {
    const trimmed = (rawNumber ?? '').trim();
    let value: string | null = null;
    if (trimmed) {
      // **يُطبَّع بمطبِّع الأرقام الأردنية لا بعدّ الخانات.** العدّ وحده يقبل
      // «+9620770600234» — صفر محلي بقي بعد رمز الدولة — فيبدو رقماً سليماً
      // بثلاث عشرة خانة ويُحفظ، ثم تذهب رسائل الزبائن إلى رقم لا وجود له.
      // والمطبِّع يعرف مفاتيح المحمول الأردنية فيردّ ما ليس منها.
      value = toJordanE164(trimmed);
      if (!value) {
        throw new BadRequestException(
          'رقم غير صالح — اكتب رقم واتساب الأردني مثل 0770600234 أو +962770600234',
        );
      }
    }
    const before = await this.prisma.otpChannelSettings.findUnique({
      where: { id: 1 },
    });
    const row = await this.prisma.otpChannelSettings.upsert({
      where: { id: 1 },
      create: { id: 1, waGatewayNumber: value, updatedBy: actorId },
      update: { waGatewayNumber: value, updatedBy: actorId },
    });
    await this.audit(
      actorId,
      'otp.waGateway.update',
      'OtpChannelSettings',
      '1',
      { waGatewayNumber: before?.waGatewayNumber ?? null },
      { waGatewayNumber: value },
    );
    return row;
  }

  async setOtpChannel(channel: OtpChannel, actorId: string) {
    const before = await this.prisma.otpChannelSettings.findUnique({ where: { id: 1 } });
    const row = await this.prisma.otpChannelSettings.upsert({
      where: { id: 1 },
      create: { id: 1, channel, updatedBy: actorId },
      update: { channel, updatedBy: actorId },
    });
    // قناة الدخول للنظام كله — تغييرها حدث يستحق أثراً يُراجَع
    await this.audit(actorId, 'otp.channel.update', 'OtpChannelSettings', '1',
      { channel: before?.channel ?? null }, { channel });
    return row;
  }

  /**
   * استثناء لرقم بعينه — يسبق القناة العامة. المفتاح الرقم لا الحساب: الرمز
   * يُطلب أحياناً قبل أن يوجد حساب أصلاً.
   */
  async setOtpOverride(
    rawPhone: string,
    channel: OtpChannel,
    email: string | undefined,
    note: string | undefined,
    actorId: string,
  ) {
    const phone = normalizeJordanPhone(rawPhone);
    const before = await this.prisma.otpChannelOverride.findUnique({ where: { phone } });
    const row = await this.prisma.otpChannelOverride.upsert({
      where: { phone },
      create: { phone, channel, email: email ?? null, note: note ?? null, updatedBy: actorId },
      update: { channel, email: email ?? null, note: note ?? null, updatedBy: actorId },
    });
    await this.audit(actorId, 'otp.override.set', 'OtpChannelOverride', phone,
      before ? { channel: before.channel, email: before.email } : null,
      { channel, email: email ?? null });
    return row;
  }

  async deleteOtpOverride(rawPhone: string, actorId: string) {
    const phone = normalizeJordanPhone(rawPhone);
    const before = await this.prisma.otpChannelOverride.findUnique({ where: { phone } });
    if (!before) throw new NotFoundException('لا يوجد استثناء لهذا الرقم');
    await this.prisma.otpChannelOverride.delete({ where: { phone } });
    await this.audit(actorId, 'otp.override.delete', 'OtpChannelOverride', phone,
      { channel: before.channel, email: before.email }, null);
    return { ok: true, phone };
  }

  async resetOtpLimit(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    // حدود توثيق الرقم مفتاحها الحساب لا الرقم: من دخل بجوجل ولم يوثّق بعد
    // قد لا يملك رقماً أصلاً، فلا يصح أن يمنعه غيابُه من فكّ الحظر عنه.
    await this.redis.del(
      `flood:phone-verify-request:${user.id}`,
      `flood:phone-verify-confirm:${user.id}`,
    );

    // وحدود الدخول القديمة مفتاحها الرقم — تُمسح لمن يملك رقماً فقط.
    if (user.phone) {
      await this.redis.del(
        `flood:whatsapp-otp-request:${user.phone}`,
        `flood:whatsapp-otp-verify:${user.phone}`,
      );
    }
    await this.audit(actorId, 'user.otp_limit_reset', 'User', userId, undefined, {
      phone: user.phone,
    });
    return { ok: true, phone: user.phone };
  }

  /**
   * أجهزة المستخدم المسجَّل دخولها الآن. الصف الفعّال في RefreshToken هو
   * الجهاز: التوكن يُدوَّر مع كل تحديث فيُلغى القديم ويُنشأ غيره، لذا صفٌّ
   * واحد غير ملغى لكل جهاز — و`sessionId` يجمع تدويرات الجهاز الواحد.
   */
  async userSessions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        sessionId: true,
        deviceInfo: true,
        ip: true,
        startedAt: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      sessionId: r.sessionId,
      deviceInfo: r.deviceInfo,
      ip: r.ip,
      startedAt: r.startedAt,
      // آخر تدوير للتوكن ≈ آخر نشاط فعلي للجهاز
      lastSeenAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /**
   * إخراج جهاز واحد.
   *
   * السحب في القاعدة وحده لا يُخرج أحداً في اللحظة: توكن الوصول يبقى صالحاً
   * بنيوياً حتى ينتهي، والقناة الحيّة تبقى موصولة فتصل العروض والإشعارات
   * جهازاً «أُخرج» من دقائق. الحدث يُبلَّغ ثم تُقطع وصلته — وموجَّهاً إلى
   * جلسته وحدها، فلا يُطرد بقية أجهزة الحساب معه.
   */
  async revokeUserSession(userId: string, sessionId: string, actorId: string) {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'ADMIN' },
    });
    if (count === 0) throw new NotFoundException('الجلسة غير موجودة أو مُخرَجة سلفاً');
    await this.gateway.emitSessionRevoked(
      userId,
      SESSION_REVOKED_AR.ADMIN,
      sessionId,
    );
    await this.audit(actorId, 'user.session_revoked', 'User', userId, undefined, {
      sessionId,
    });
    return { ok: true };
  }

  /** إخراج كل الأجهزة — لحساب مشتبه به أو هاتف ضائع */
  async revokeAllUserSessions(userId: string, actorId: string) {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'ADMIN' },
    });
    if (count > 0) {
      await this.gateway.emitSessionRevoked(userId, SESSION_REVOKED_AR.ADMIN);
    }
    await this.audit(actorId, 'user.sessions_revoked_all', 'User', userId, undefined, {
      count,
    });
    return { ok: true, count };
  }

  async setUserStatus(userId: string, status: UserStatus, actorId: string) {
    if (userId === actorId) throw new BadRequestException('لا يمكنك تعطيل حسابك');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (user.roles.some((r) => r.role.name === 'SUPER_ADMIN')) {
      throw new BadRequestException('حساب المدير الأعلى لا يُعطَّل من اللوحة');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    await this.permissions.invalidate(userId);
    await this.audit(actorId, status === 'DISABLED' ? 'user.disable' : 'user.enable',
      'User', userId, { status: user.status }, { status });
    return { id: updated.id, status: updated.status };
  }

  /** تعديل بيانات مستخدم عام (اسم/هاتف/بريد) — أي حساب، زبوناً كان أو غيره */
  async updateUser(
    userId: string,
    data: { name?: string; phone?: string; email?: string },
    actorId: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : undefined;
    const email = data.email?.trim().toLowerCase() || undefined;
    if (phone || email) {
      const clash = await this.prisma.user.findFirst({
        where: {
          OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
          id: { not: userId },
        },
      });
      // **الرسالة تسمّي المُعارِض.** «مستخدم لحساب آخر» تقول إن هناك مانعاً
      // ولا تقول أين هو، فيبقى الأدمن يبحث عن حسابٍ لا يعرف اسمه ولا رقمه —
      // وأكثر ما يحمل هذه الأرقام حسابات «زبون جديد» متشابهة الاسم تماماً.
      // المعرّف يُذكر لأنه ما يُكتب في نافذة الحذف الجذري، فتصير الرسالة
      // طريقاً إلى الحل لا حائطاً أمامه.
      if (clash) {
        const which = phone && clash.phone === phone ? 'الهاتف' : 'البريد';
        throw new BadRequestException(
          `${which} مستخدم لحساب آخر: «${clash.name}»` +
            `${clash.phone ? ` — ${clash.phone}` : ''} (المعرّف: ${clash.id}). ` +
            `احذف ذلك الحساب أو غيّر رقمه أولاً.`,
        );
      }
    }
    // **تبديل الرقم يُسقط توثيقه.** التوثيق يعني «أثبت صاحبُ الحساب ملكية
    // هذا الرقم برمز»، وهو مرة واحدة للأبد — فلو انتقل الحساب إلى رقم كتبته
    // اللوحة لبقي موثَّقاً بلا أن يثبت أحدٌ شيئاً، ومرّ الطلب بحارس
    // phoneVerifiedAt (انظر assertPhoneVerified في orders-v2) على رقم قد
    // يكون خطأً مطبعياً. يُطلب رمزٌ عند أول طلب، وهو ما صُمّم له الحارس.
    const phoneChanged = !!phone && phone !== user.phone;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(phone ? { phone } : {}),
        ...(phoneChanged ? { phoneVerifiedAt: null } : {}),
        ...(email ? { email } : {}),
      },
    });
    await this.audit(actorId, 'user.update', 'User', userId,
      { name: user.name, phone: user.phone, email: user.email },
      { ...data, ...(phoneChanged ? { phoneVerificationReset: true } : {}) });
    return {
      id: updated.id,
      name: updated.name,
      phone: updated.phone,
      email: updated.email,
      phoneVerified: !!updated.phoneVerifiedAt,
    };
  }

  /**
   * حذف مستخدم عام من لوحة المنصة — يشمل أي حساب (زبون، سائق، موظف وكالة).
   * يفقد أي عضوية/ملف سائق فوراً، وحسابه يُحذف فعلياً فقط إن لم يترك أي
   * أثر حقيقي (طلبات، سجل تدقيق، تذاكر) — وإلا يُعطَّل بدل حذفه.
   */
  async deleteUser(userId: string, actorId: string) {
    if (userId === actorId) throw new BadRequestException('لا يمكنك حذف حسابك');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (user.roles.some((r) => r.role.name === 'SUPER_ADMIN')) {
      throw new BadRequestException('حساب المدير الأعلى لا يُحذف من اللوحة');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.driverProfile.deleteMany({ where: { userId } });
      await tx.userRole.deleteMany({ where: { userId } });
      return this.removeUserAccount(tx, userId);
    });
    await this.permissions.invalidate(userId);
    await this.audit(actorId, 'user.delete', 'User', userId,
      { name: user.name, roles: user.roles.map((r) => r.role.name) },
      { deletedAccount: result.deleted });
    return result;
  }

  /**
   * يحذف حساب مستخدم فعلياً فقط إن كان فارغاً تماماً بلا أي أثر حقيقي
   * (طلبات، عروض توزيع، سجل تدقيق، تذاكر دعم) — وإلا يعطّله بدل حذفه حتى
   * لا يضيع تاريخ حقيقي.
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

  /**
   * **حذف جذري**: يمحو المستخدم وكل أثره الشخصي من القاعدة محواً لا رجعة فيه.
   *
   * يختلف عن [deleteUser] جوهرياً: تلك تُعطّل الحساب متى وجدت له نشاطاً
   * (طلبات، تذاكر) حفاظاً على التاريخ. وهذه تحذف النشاط نفسه — وهي أداة
   * الاستجابة لطلب «امحُ بياناتي» ولحسابات الاختبار التي تلوّث اللوحة.
   *
   * **قيود المحاسبة تنجو.** رصيد محفظة الوكالة ليس رقماً مخزَّناً بل
   * SUM(LedgerEntry) — والحقل `balance` كاش يُدقَّق دورياً. فحذف قيود
   * طلبات زبون يعني تغيّر أرصدة وكالات لم يطلب أحد تغييرها، بلا أثر يشرح
   * لماذا نقص المبلغ. لذلك تُفصل القيود عن طلباتها (`orderId = null`)
   * وتبقى: المال محفوظ، والشخص ممحوّ. والحقل `String?` أصلاً فلا تحتاج
   * سكيما جديدة.
   *
   * **وسجل التدقيق يمنع حذف من عمل به.** AuditLog.actorUserId مطلوب بلا
   * cascade، وحذف موظف نفّذ إجراءات إدارية يعني محو الدليل على تلك
   * الإجراءات — وهو ما لا يجوز أن تتيحه أداة تنظيف. يُرفض صراحةً بدل أن
   * يفشل بقيد قاعدة بيانات غامض.
   */
  async purgeUser(userId: string, actorId: string) {
    if (userId === actorId) throw new BadRequestException('لا يمكنك حذف حسابك');
    // **الدور لا الصلاحية.** SUPER_ADMIN وADMIN كلاهما يحمل ALL في البذرة،
    // فأي مفتاح صلاحية جديد يصل الاثنين معاً. وهذا فعل لا يُردّ ولا يترك ما
    // يُستعاد منه، فيُقصر على الدور المحميّ وحده.
    const actor = await this.prisma.userRole.findFirst({
      where: { userId: actorId, role: { name: 'SUPER_ADMIN' } },
    });
    if (!actor) {
      throw new ForbiddenException('الحذف الجذري للمدير الأعلى وحده');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (user.roles.some((r) => r.role.name === 'SUPER_ADMIN')) {
      throw new BadRequestException('حساب المدير الأعلى لا يُحذف من اللوحة');
    }
    // **إجراءاته على غيره وحدها تمنع الحذف.** ما فعله بحسابه هو (تأكيد اسمه
    // عند أول دخول، أو تعديله لاحقاً — انظر user.name.self_update و
    // user.name.first_confirm في auth-v2) ليس سلطةً تُراجَع، بل أثرٌ شخصي
    // يُمحى معه. وبلا هذا الفصل كان كل زبون أقرّ اسمه — أي كل زبون دخل
    // بجوجل — يُرفض حذفه بحجة أنه «نفّذ إجراءات إدارية».
    const adminActions = await this.prisma.auditLog.count({
      where: { actorUserId: userId, NOT: { entityId: userId } },
    });
    if (adminActions > 0) {
      throw new BadRequestException(
        `هذا الحساب نفّذ ${adminActions} إجراءً إدارياً على حسابات أو بيانات أخرى، مسجّلاً في سجل التدقيق — حذفه يمحو الدليل عليها. عطّله بدل حذفه.`,
      );
    }

    // **سجلّات لا تُفرَّغ ولا تُحذف.** حقول مطلوبة (بلا `?`) تشير إلى هذا
    // المستخدم من سجلّات تخصّ المال والعقود والحملات — سجلّ يقول «مَن طلب
    // شحن هذا الرصيد» لا معنى له بلا صاحبه، ولا يجوز محوه لتنظيف حساب.
    // تُفحص قبل المعاملة لتُقال بوضوح: بلا هذا يسقط الحذف على قيد مفتاح
    // أجنبي، ويصل المستخدم «خطأ داخلي» لا يدل على شيء.
    const blockers: { label: string; count: number }[] = [
      { label: 'طلبات شحن رصيد', count: await this.prisma.rechargeRequest.count({ where: { requestedById: userId } }) },
      { label: 'دفعات اشتراك', count: await this.prisma.subscriptionPayment.count({ where: { requestedById: userId } }) },
      { label: 'توقيعات عقود', count: await this.prisma.contractSignature.count({ where: { signerUserId: userId } }) },
      { label: 'حملات واتساب', count: await this.prisma.whatsAppCampaign.count({ where: { createdById: userId } }) },
      { label: 'قوائم مستقبِلين', count: await this.prisma.recipientList.count({ where: { createdById: userId } }) },
      { label: 'عمليات استيراد وكالات', count: await this.prisma.agencyLeadImport.count({ where: { startedById: userId } }) },
      { label: 'تغييرات اعتماد وكالات', count: await this.prisma.agencyApprovalHistory.count({ where: { changedById: userId } }) },
    ].filter((b) => b.count > 0);
    if (blockers.length) {
      throw new BadRequestException(
        `لا يمكن الحذف الجذري: لهذا الحساب سجلّات لا تُمحى — ${blockers
          .map((b) => `${b.label} (${b.count})`)
          .join('، ')}. عطّله بدل حذفه.`,
      );
    }

    // ملخّص لسجل التدقيق: ما الذي مُحي فعلاً — بعد الحذف لا يبقى ما يُعدّ.
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ customerId: userId }, { driverId: userId }] },
      select: { id: true, code: true },
    });
    const orderIds = orders.map((o) => o.id);

    try {
      await this.prisma.$transaction(async (tx) => {
      // تذاكر الدعم أولاً: قد تشير إلى طلب (orderId) أو إلى المستخدم، فلو
      // تُركت لما بعد حذف الطلبات لسقط الحذف على مفتاح معلّق.
      const tickets = await tx.supportTicket.findMany({
        where: {
          OR: [
            { createdByUserId: userId },
            { assignedToUserId: userId },
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
          ],
        },
        select: { id: true },
      });
      if (tickets.length) {
        const ids = tickets.map((t) => t.id);
        await tx.ticketMessage.deleteMany({ where: { ticketId: { in: ids } } });
        await tx.supportTicket.deleteMany({ where: { id: { in: ids } } });
      }
      // رسائله في تذاكر لم تُحذف (تذكرة غيره كتب فيها)
      await tx.ticketMessage.deleteMany({ where: { authorUserId: userId } });

      if (orderIds.length) {
        // أولاً: فكّ ارتباط القيود المحاسبية بالطلبات — تبقى في دفتر
        // الوكالة بمبالغها، ولا يتغيّر رصيد أحد.
        await tx.ledgerEntry.updateMany({
          where: { orderId: { in: orderIds } },
          data: { orderId: null },
        });
        // **الكوبون قبل الطلب**: CouponRedemption.orderId مطلوب بلا cascade،
        // فحذف طلبٍ استُعمل فيه كوبون قبل حذف قيده يسقط على مفتاح أجنبي —
        // وهو ما يظهر للمستخدم «خطأ داخلي» بلا سبب مفهوم.
        await tx.couponRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
        // ثم أبناء الطلب بالترتيب الذي لا يترك مفتاحاً معلّقاً
        await tx.invoicePublicLink.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderMessage.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderAssignmentHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.driverOffer.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      // ما تبقّى من أثر الشخص. الترتيب يتبع الاعتماد لا الأبجدية.
      // طلبات ألغاها هو ولم تكن له: الحقل اختياري فيُفرَّغ ولا يُحذف الطلب.
      await tx.order.updateMany({
        where: { cancelledByUserId: userId },
        data: { cancelledByUserId: null },
      });
      await tx.driverOffer.deleteMany({ where: { driverId: userId } });
      await tx.orderAssignmentHistory.deleteMany({ where: { driverId: userId } });
      await tx.couponRedemption.deleteMany({ where: { customerId: userId } });
      // رسائله في طلبات ليست له (سائق كتب في محادثة طلب زبون آخر)
      await tx.orderMessage.deleteMany({ where: { authorUserId: userId } });
      await tx.orderStatusHistory.updateMany({
        where: { actorUserId: userId },
        data: { actorUserId: null },
      });
      await tx.rateLimitViolation.deleteMany({ where: { userId } });
      await tx.campaignRecipient.deleteMany({ where: { userId } });
      await tx.recipientListMember.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.address.deleteMany({ where: { userId } });
      await tx.driverProfile.deleteMany({ where: { userId } });
      await tx.userRole.deleteMany({ where: { userId } });
      // حقول اختيارية تشير إليه من سجلّات تبقى: تُفرَّغ ولا تُحذف السجلّات —
      // «مَن راجع هذا الطلب» يفقد اسمه، والطلب نفسه يبقى كما هو.
      await tx.rechargeRequest.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } });
      await tx.subscriptionPayment.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } });
      await tx.orderCounter.updateMany({ where: { resetById: userId }, data: { resetById: null } });
      await tx.reviewAccountConfig.updateMany({ where: { updatedByUserId: userId }, data: { updatedByUserId: null } });
      await tx.agencyLead.updateMany({ where: { approvedById: userId }, data: { approvedById: null } });
      await tx.agencyLead.updateMany({ where: { deletedById: userId }, data: { deletedById: null } });
      await tx.agencyOnboarding.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } });
      await tx.agencyOnboardingDocument.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } });
      await tx.agencyOnboardingEvent.updateMany({ where: { actorId: userId }, data: { actorId: null } });
      await tx.agencyOnboardingRequirement.updateMany({ where: { updatedById: userId }, data: { updatedById: null } });
      await tx.contractTemplate.updateMany({ where: { createdById: userId }, data: { createdById: null } });
      await tx.agencyContract.updateMany({ where: { createdById: userId }, data: { createdById: null } });
      await tx.contractDocument.updateMany({ where: { uploadedById: userId }, data: { uploadedById: null } });
      await tx.contractEvent.updateMany({ where: { actorId: userId }, data: { actorId: null } });
      await tx.contractAlertRule.updateMany({ where: { updatedById: userId }, data: { updatedById: null } });
      // قيود سجل التدقيق التي فاعلها هو ومحلّها حسابه نفسه — أثر شخصي
      // يُمحى معه. وما كان على غيره فقد مُنع الحذف بسببه قبل الوصول هنا،
      // فلا يصل السطر إلى قيدٍ يخصّ سلطةً على أحد.
      await tx.auditLog.deleteMany({ where: { actorUserId: userId } });
      await tx.user.delete({ where: { id: userId } });
      });
    } catch (e) {
      // قيد مفتاح أجنبي هنا يعني جدولاً يشير إلى هذا المستخدم لم تعالجه
      // الخطوات أعلاه — غالباً جدول أُضيف بعد كتابتها. بلا هذا يصل المستخدم
      // «خطأ داخلي» مجرّداً، ويبقى الجدول المسؤول مجهولاً حتى تُقرأ السجلات.
      const err = e as { code?: string; meta?: { field_name?: string; modelName?: string } };
      if (err.code === 'P2003' || err.code === 'P2014') {
        const where = err.meta?.field_name ?? err.meta?.modelName ?? 'سجلّ مرتبط';
        this.logger.error(`purgeUser: قيد مفتاح أجنبي على ${where}`, e as Error);
        throw new BadRequestException(
          `تعذّر الحذف الجذري: لهذا الحساب سجلّ مرتبط لا يُمحى تلقائياً (${where}). عطّله بدل حذفه، وأبلغ المطوّر بهذه الرسالة.`,
        );
      }
      throw e;
    }

    await this.permissions.invalidate(userId);
    // السجل يُكتب باسم المنفِّذ لا باسم المحذوف — وإلا لحُذف معه.
    await this.audit(actorId, 'user.purge', 'User', userId,
      {
        name: user.name,
        phone: user.phone,
        email: user.email,
        roles: user.roles.map((r) => r.role.name),
        orders: orders.map((o) => o.code),
      },
      { purged: true, ordersDeleted: orderIds.length });
    return { purged: true, ordersDeleted: orderIds.length };
  }

  // ============ الأمان: من يتجاوز الحدود كثيراً ============

  /**
   * من يُلحّ كثيراً على حدود المعدّل خلال آخر 24 ساعة — مُجمَّع حسب IP
   * وحسب المستخدم (لو عُرف) ليسهل رصد المصدر، بالإضافة لسجل خام للتفصيل.
   * كل صف بيانات عرض فقط — الحظر/التعطيل الفعلي عبر users.
   */
  /**
   * التقييمات المكتوبة عبر المنصة كلها. الترتيب بلحظة التقييم لا بلحظة
   * الطلب: شكوى كُتبت اليوم عن طلب الأسبوع الماضي تستحق أن تُقرأ اليوم.
   *
   * مع كل صف متوسط وكالته وعدد تقييماتها — نجمة واحدة عند وكالة متوسطها
   * 4.9 حادثة، وعند متوسطها 3.1 نمط.
   */
  async listRatings(stars?: number) {
    const rows = await this.prisma.order.findMany({
      where: {
        rating: { not: null },
        ...(stars && stars >= 1 && stars <= 5 ? { rating: stars } : {}),
      },
      select: {
        id: true,
        code: true,
        rating: true,
        ratingComment: true,
        ratedAt: true,
        createdAt: true,
        customer: { select: { name: true } },
        driver: { select: { id: true, name: true } },
        agency: {
          select: { id: true, nameAr: true, rating: true, ratingCount: true },
        },
      },
      orderBy: [{ ratedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    // ملخّص فوق القائمة: التوزيع يقول أين يقع ثقل التقييمات بلمحة
    const byStars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const all = await this.prisma.order.groupBy({
      by: ['rating'],
      where: { rating: { not: null } },
      _count: { _all: true },
    });
    let total = 0;
    let sum = 0;
    for (const g of all) {
      const star = g.rating as number;
      byStars[star] = g._count._all;
      total += g._count._all;
      sum += star * g._count._all;
    }
    return {
      rows,
      total,
      average: total ? Math.round((sum / total) * 100) / 100 : null,
      byStars,
    };
  }

  async securityOverview() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recent, byIp, byUser] = await Promise.all([
      this.prisma.rateLimitViolation.findMany({
        where: { createdAt: { gte: since } },
        include: {
          user: { select: { id: true, name: true, phone: true, username: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.rateLimitViolation.groupBy({
        by: ['ip'],
        where: { createdAt: { gte: since }, ip: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { ip: 'desc' } },
        take: 20,
      }),
      this.prisma.rateLimitViolation.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since }, userId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 20,
      }),
    ]);
    const users = await this.prisma.user.findMany({
      where: { id: { in: byUser.map((r) => r.userId!) } },
      select: { id: true, name: true, phone: true, username: true, status: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return {
      recent,
      byIp: byIp.map((r) => ({ ip: r.ip, count: r._count._all })),
      byUser: byUser
        .map((r) => ({ user: userById.get(r.userId!), count: r._count._all }))
        .filter((r) => r.user),
    };
  }

  // ============ موظفو المنصة ============

  listEmployees() {
    return this.prisma.userRole.findMany({
      where: { agencyId: null, role: { scope: 'PLATFORM' } },
      include: {
        user: {
          select: {
            id: true, name: true, username: true, phone: true,
            email: true, status: true, lastLoginAt: true,
          },
        },
        role: { select: { name: true, nameAr: true } },
      },
    });
  }

  /** موظف منصة = حساب لوحة: اسم مستخدم وكلمة مرور، والهاتف اختياري للتواصل */
  async createEmployee(
    data: {
      username: string;
      name: string;
      phone?: string;
      email?: string;
      role: string;
    },
    actorId: string,
  ) {
    if (!GRANTABLE_PLATFORM_ROLES.includes(data.role as never)) {
      throw new BadRequestException(`الدور يجب أن يكون أحد: ${GRANTABLE_PLATFORM_ROLES.join('، ')}`);
    }
    await this.assertMayGrantFullPower(actorId, data.role);
    const role = await this.prisma.role.findFirstOrThrow({
      where: { name: data.role, isSystem: true, agencyId: null },
    });
    const username = assertValidUsername(data.username);
    const password = generateTempPassword();
    const email = data.email?.trim().toLowerCase() || null;
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : null;
    const clash = await this.prisma.user.findFirst({
      where: {
        OR: [{ username }, ...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
    });
    if (clash) {
      throw new BadRequestException('اسم المستخدم أو البريد أو الهاتف مستخدم لحساب آخر');
    }
    const user = await this.prisma.user.create({
      data: {
        name: data.name,
        username,
        email,
        phone,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      },
    });
    await this.prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    await this.permissions.invalidate(user.id);
    await this.audit(actorId, 'platform.employee.create', 'User', user.id, undefined, {
      username,
      role: data.role,
    });
    return { id: user.id, name: user.name, username, phone, role: data.role, tempPassword: password };
  }

  /** تعديل بيانات موظف منصة: اسمه/هاتفه/بريده، ودوره إن تغيّر */
  async updatePlatformEmployee(
    userId: string,
    data: { name?: string; phone?: string; email?: string; role?: string },
    actorId: string,
  ) {
    const membership = await this.prisma.userRole.findFirst({
      where: { userId, agencyId: null },
      include: { role: true },
    });
    if (!membership) throw new NotFoundException('الموظف غير موجود');
    if (membership.role.name === 'SUPER_ADMIN') {
      throw new BadRequestException('حساب المدير الأعلى لا يُعدَّل من اللوحة');
    }
    const phone = data.phone?.trim() ? normalizeJordanPhone(data.phone) : undefined;
    const email = data.email?.trim().toLowerCase() || undefined;
    if (phone || email) {
      const clash = await this.prisma.user.findFirst({
        where: {
          OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
          id: { not: userId },
        },
      });
      if (clash) throw new BadRequestException('الهاتف أو البريد مستخدم لحساب آخر');
    }
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (data.name || phone || email) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(data.name ? { name: data.name } : {}),
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
        },
      });
    }
    if (data.role && data.role !== membership.role.name) {
      if (!GRANTABLE_PLATFORM_ROLES.includes(data.role as never)) {
        throw new BadRequestException(`الدور يجب أن يكون أحد: ${GRANTABLE_PLATFORM_ROLES.join('، ')}`);
      }
      await this.assertMayGrantFullPower(actorId, data.role);
      const role = await this.prisma.role.findFirstOrThrow({
        where: { name: data.role, isSystem: true, agencyId: null },
      });
      await this.prisma.$transaction([
        this.prisma.userRole.delete({
          where: { userId_roleId: { userId, roleId: membership.roleId } },
        }),
        this.prisma.userRole.create({ data: { userId, roleId: role.id } }),
      ]);
      await this.permissions.invalidate(userId);
    }
    await this.audit(actorId, 'platform.employee.update', 'User', userId,
      { name: before.name, phone: before.phone, email: before.email, role: membership.role.name },
      data);
    return { ok: true };
  }

  /**
   * حذف موظف منصة — تُلغى صلاحياته فوراً بحذف عضويته. حسابه يُحذف معه فقط
   * إن كان بلا أي أثر حقيقي، وإلا يبقى معطَّلاً.
   */
  async removePlatformEmployee(userId: string, actorId: string) {
    if (userId === actorId) throw new BadRequestException('لا يمكنك حذف حسابك');
    const roles = await this.prisma.userRole.findMany({
      where: { userId, agencyId: null },
      include: { role: { select: { name: true } } },
    });
    if (roles.length === 0) throw new NotFoundException('الموظف غير موجود');
    if (roles.some((r) => r.role.name === 'SUPER_ADMIN')) {
      throw new BadRequestException('حساب المدير الأعلى لا يُحذف من اللوحة');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId, agencyId: null } });
      return this.removeUserAccount(tx, userId);
    });
    await this.permissions.invalidate(userId);
    await this.audit(actorId, 'platform.employee.remove', 'User', userId,
      undefined, { deletedAccount: result.deleted });
    return result;
  }

  /**
   * إعادة ضبط كلمة مرور أي حساب لوحة (نسيان صاحب وكالة مثلاً — يتصل به
   * السوبر أدمن على هاتفه المسجّل ويسلّمه المؤقتة). كل جلساته تُلغى.
   */
  async resetUserPassword(userId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (!user.username) {
      throw new BadRequestException(
        'هذا الحساب بلا اسم مستخدم (حساب تطبيق يدخل برمز التحقق)',
      );
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
    await this.audit(actorId, 'platform.user.password.reset', 'User', userId);
    return { username: user.username, tempPassword: password };
  }

  // ============ أنواع القوارير ============

  listWaterBottleTypes() {
    return this.prisma.waterBottleType.findMany({ orderBy: { sort: 'asc' } });
  }

  /**
   * صور جاهزة يختارها الأدمن لصنف قارورة، بدل كتابة رابط يدوياً.
   * القائمة تُقرأ من الملفات الموجودة فعلاً في public/images/bottles —
   * إضافة صورة جديدة تعني وضع الملف هناك، لا نشر تعديل كود.
   */
  private readonly bottleImagesDir = join(
    __dirname, '..', '..', '..', '..', 'public', 'images', 'bottles',
  );

  async listBottleImagePresets(): Promise<{ url: string; name: string }[]> {
    try {
      const files = await readdir(this.bottleImagesDir);
      return files
        .filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f))
        .sort()
        .map((f) => ({
          url: `/images/bottles/${f}`,
          name: f.replace(/\.[^.]+$/, ''),
        }));
    } catch {
      return [];
    }
  }

  /**
   * صورة رفعها الأدمن من جهازه — تُخزَّن في StorageService (مخزن كائنات
   * محلياً أو على DigitalOcean) لا في القاعدة، وتُقدَّم عبر MediaController
   * برابط ثابت لا يتغيّر محتواه أبداً، فيصلح للتخزين المؤقت الدائم عند
   * التطبيقات (Cache-Control: immutable هناك).
   *
   * الصف نفسه لا يحمل بايتات بعد الآن — عمود `data` يبقى للصفوف القديمة
   * فقط (انظر تعليق النموذج في schema.prisma).
   */
  async saveUploadedImage(data: Buffer, mimeType: string) {
    const stored = await this.storage.put(data, mimeType, 'uploaded-images');
    const image = await this.prisma.uploadedImage.create({
      data: { storageKey: stored.key, mimeType },
    });
    return { id: image.id, url: `/api/v2/media/${image.id}` };
  }

  async createWaterBottleType(
    data: {
      nameAr: string;
      sizeLiters: number;
      price: number;
      sort?: number;
      imageUrl?: string;
    },
    actorId: string,
  ) {
    const type = await this.prisma.waterBottleType.create({ data });
    // يظهر فوراً لكل الوكالات كمتوفر — صاحب الوكالة يعطّله إن لم يوفره،
    // وإلا بقيت صفحات التوفر ناقصة وتخطى المحرك الوكالات للصنف الجديد
    const agencies = await this.prisma.agency.findMany({ select: { id: true } });
    await this.prisma.agencyBottleAvailability.createMany({
      data: agencies.map((a) => ({
        agencyId: a.id,
        bottleTypeId: type.id,
        available: true,
      })),
      skipDuplicates: true,
    });
    await this.audit(actorId, 'bottle.create', 'WaterBottleType', type.id, undefined, data);
    return type;
  }

  async updateWaterBottleType(
    id: string,
    data: {
      nameAr?: string;
      price?: number;
      active?: boolean;
      sort?: number;
      imageUrl?: string | null;
    },
    actorId: string,
  ) {
    const type = await this.prisma.waterBottleType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('النوع غير موجود');
    const updated = await this.prisma.waterBottleType.update({ where: { id }, data });
    // تغيير السعر حدث حساس — يُسجَّل بالقيمتين (متطلب الـ Audit)
    await this.audit(actorId, 'bottle.update', 'WaterBottleType', id,
      { price: Number(type.price), active: type.active },
      { price: Number(updated.price), active: updated.active });
    return updated;
  }

  /**
   * حذف صنف قارورة — فعلياً فقط إن لم يظهر ببند طلب سابق (نفس مبدأ حذف
   * المستخدم): صنف بلا تاريخ حقيقي يُحذف بلا أثر، وصنف استُخدم مرة واحدة
   * ولو قديماً يُعطَّل بدلاً من ذلك حتى لا تفقد طلبات قديمة مرجعها.
   */
  async deleteWaterBottleType(id: string, actorId: string) {
    const type = await this.prisma.waterBottleType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('الصنف غير موجود');
    const used = await this.prisma.orderItem.count({ where: { bottleTypeId: id } });
    if (used > 0) {
      await this.prisma.waterBottleType.update({ where: { id }, data: { active: false } });
      await this.audit(actorId, 'bottle.disable', 'WaterBottleType', id, undefined, {
        reason: `استُخدم في ${used} بند طلب — عُطِّل بدل الحذف`,
      });
      return { deleted: false as const, disabled: true as const, ordersCount: used };
    }
    await this.prisma.$transaction([
      this.prisma.agencyBottleAvailability.deleteMany({ where: { bottleTypeId: id } }),
      this.prisma.waterBottleType.delete({ where: { id } }),
    ]);
    await this.audit(actorId, 'bottle.delete', 'WaterBottleType', id, { nameAr: type.nameAr }, undefined);
    return { deleted: true as const };
  }

  // ============ البانرات الترويجية ============

  /** كل البانرات للوحة — الجمهور عمود ظاهر تُصفّى به الشاشة */
  listPromoBanners() {
    return this.prisma.promoBanner.findMany({
      orderBy: [{ audience: 'asc' }, { sort: 'asc' }],
    });
  }

  listActivePromoBanners() {
    return this.prisma.promoBanner.findMany({
      where: { active: true },
      orderBy: { sort: 'asc' },
    });
  }

  async createPromoBanner(
    data: {
      imageUrl: string;
      linkUrl?: string | null;
      sort?: number;
      active?: boolean;
      audience?: AppTarget;
    },
    actorId: string,
  ) {
    const banner = await this.prisma.promoBanner.create({ data });
    await this.audit(actorId, 'banner.create', 'PromoBanner', banner.id, undefined, data);
    return banner;
  }

  async updatePromoBanner(
    id: string,
    data: {
      imageUrl?: string;
      linkUrl?: string | null;
      sort?: number;
      active?: boolean;
      audience?: AppTarget;
    },
    actorId: string,
  ) {
    const banner = await this.prisma.promoBanner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('البانر غير موجود');
    const updated = await this.prisma.promoBanner.update({ where: { id }, data });
    await this.audit(actorId, 'banner.update', 'PromoBanner', id, banner, updated);
    return updated;
  }

  /** محتوى تسويقي بلا أي مرجع بيانات — يُحذف نهائياً دوماً بلا حارس تاريخ */
  async deletePromoBanner(id: string, actorId: string) {
    const banner = await this.prisma.promoBanner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('البانر غير موجود');
    await this.prisma.promoBanner.delete({ where: { id } });
    await this.audit(actorId, 'banner.delete', 'PromoBanner', id, { imageUrl: banner.imageUrl }, undefined);
    return { deleted: true as const };
  }

  // ============ مطوّرو التطبيق ============

  listAppDevelopers() {
    return this.prisma.appDeveloper.findMany({
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** ما يراه المستخدم في التطبيقين — المفعّل وحده */
  listActiveAppDevelopers() {
    return this.prisma.appDeveloper.findMany({
      where: { active: true },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, nameAr: true, roleAr: true, url: true, avatarUrl: true },
    });
  }

  async createAppDeveloper(
    data: { nameAr: string; roleAr?: string; url?: string; avatarUrl?: string; sort?: number },
    actorId: string,
  ) {
    const dev = await this.prisma.appDeveloper.create({ data });
    await this.audit(actorId, 'appDeveloper.create', 'AppDeveloper', dev.id, undefined, data);
    return dev;
  }

  async updateAppDeveloper(
    id: string,
    data: Partial<{
      nameAr: string; roleAr: string; url: string; avatarUrl: string;
      sort: number; active: boolean;
    }>,
    actorId: string,
  ) {
    const before = await this.prisma.appDeveloper.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('البطاقة غير موجودة');
    const updated = await this.prisma.appDeveloper.update({ where: { id }, data });
    await this.audit(actorId, 'appDeveloper.update', 'AppDeveloper', id, before, updated);
    return updated;
  }

  /** بطاقة تعريفية بلا أي مرجع بيانات — تُحذف نهائياً بلا حارس */
  async deleteAppDeveloper(id: string, actorId: string) {
    const before = await this.prisma.appDeveloper.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('البطاقة غير موجودة');
    await this.prisma.appDeveloper.delete({ where: { id } });
    await this.audit(actorId, 'appDeveloper.delete', 'AppDeveloper', id, before, undefined);
    return { deleted: true as const };
  }

  // ============ ترقيم الطلبات ============

  /**
   * حالة عدّاد أرقام الطلبات: ما الرقم القادم، وكم طلباً في السجل، ومتى
   * صُفِّر آخر مرة وبيد من.
   */
  /**
   * حالة الترقيم. **مصدر الحقيقة صار المتتالية `order_code_seq`** لا عمود
   * `next` — بعد أن أُزيل قفل صفّ العدّاد (انظر migrations/2_order_code_sequence).
   * قراءة `last_value` بلا `nextval` لا تستهلك رقماً ولا تقفل شيئاً؛
   * `is_called=false` يعني أن `last_value` نفسه هو التالي الذي سيُمنح.
   */
  async orderCounter() {
    const counter = await this.prisma.orderCounter.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
      include: { resetBy: { select: { name: true } } },
    });
    const [seq] = await this.prisma.$queryRaw<
      { last_value: bigint; is_called: boolean }[]
    >`SELECT last_value, is_called FROM order_code_seq`;
    const nextNumber = Number(seq.last_value) + (seq.is_called ? 1 : 0);
    const [ordersTotal, latest] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { code: true, createdAt: true },
      }),
    ]);
    return {
      next: nextNumber,
      prefix: counter.prefix,
      nextCode: `${counter.prefix}-${String(nextNumber).padStart(5, '0')}`,
      resetAt: counter.resetAt,
      resetFrom: counter.resetFrom,
      resetByName: counter.resetBy?.name ?? null,
      ordersTotal,
      lastOrderCode: latest?.code ?? null,
      lastOrderAt: latest?.createdAt ?? null,
    };
  }

  /**
   * تصفير الترقيم — يبدأ العد من جديد (1 افتراضاً) لموسم أو سنة جديدة.
   *
   * الطلبات القديمة تبقى برموزها: تغييرها يكسر كل فاتورة مطبوعة وكل شكوى
   * وكل رسالة فيها رقم الطلب. ما يُصفَّر هو ما سيُمنح لاحقاً — وإن صادف رقم
   * طلب قديم تخطّاه المولّد إلى التالي، فلا رمزان لطلبين.
   */
  async resetOrderCounter(
    data: { startFrom?: number; prefix?: string },
    actorId: string,
  ) {
    const startFrom = data.startFrom ?? 1;
    if (!Number.isInteger(startFrom) || startFrom < 1 || startFrom > 9_999_999) {
      throw new BadRequestException('رقم البداية بين 1 و9999999');
    }
    const prefix = data.prefix?.trim().toUpperCase();
    if (prefix !== undefined && !/^[A-Z]{2,6}$/.test(prefix)) {
      throw new BadRequestException('البادئة حروف إنجليزية من 2 إلى 6');
    }
    const before = await this.prisma.orderCounter.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    const after = await this.prisma.orderCounter.update({
      where: { id: 1 },
      data: {
        next: startFrom,
        prefix: prefix ?? undefined,
        resetAt: new Date(),
        resetById: actorId,
        resetFrom: startFrom,
      },
    });
    // **المتتالية هي ما يُمنح فعلاً** — تحديث العمود وحده كان سيجعل
    // التصفير بلا أثر: اللوحة تقول «بدأنا من 1» والطلبات تكمل من حيث كانت.
    // `is_called=false` يجعل أول `nextval` يعيد `startFrom` نفسه لا ما بعده.
    await this.prisma.$executeRawUnsafe(
      'SELECT setval($1, $2, false)', 'order_code_seq', startFrom,
    );
    await this.audit(
      actorId,
      'orderCounter.reset',
      'OrderCounter',
      '1',
      { next: before.next, prefix: before.prefix },
      { next: after.next, prefix: after.prefix },
    );
    return this.orderCounter();
  }

  // ============ حذف الطلبات القديمة ============

  /**
   * الحالات التي انتهى فيها الطلب فعلاً. الحذف لا يمسّ غيرها مهما بلغ عمرها:
   * طلبٌ في الطريق لا يُحذف من تحت سائقه ولا من تحت زبون ينتظره.
   */
  private static readonly DELETABLE_STATUSES: OrderStatus[] = [
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
    OrderStatus.SEARCH_FAILED,
  ];

  /**
   * أدنى عمر يُقبل. حاجزٌ ضد الخطأ المطبعي لا ضد سوء النية: من يكتب 9 وهو
   * يقصد 90 يمسح تقارير ربع سنة بضغطة، ولا تراجع بعدها.
   */
  private static readonly MIN_DELETE_AGE_DAYS = 30;

  /** سقف الدفعة الواحدة — معاملة تمسح عشرات الآلاف تقفل الجداول طويلاً */
  private static readonly DELETE_BATCH_MAX = 500;

  private deleteCutoff(olderThanDays: number): Date {
    if (
      !Number.isInteger(olderThanDays) ||
      olderThanDays < PlatformService.MIN_DELETE_AGE_DAYS
    ) {
      throw new BadRequestException(
        `أقل عمر مسموح للحذف ${PlatformService.MIN_DELETE_AGE_DAYS} يوماً`,
      );
    }
    return new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  }

  /**
   * ما يجوز حذفه فعلاً: منتهٍ، وقديم، **ولم يمرّ بمحفظة**.
   *
   * قيود المحفظة append-only بقرار في القاعدة نفسها (trigger يرفض UPDATE
   * وDELETE عليها — راجع seed.v2). فلا القيد يُحذف مع طلبه، ولا صلته به
   * تُفكّ. والنتيجة أن طلباً خُصمت عنه عمولة لا يُحذف إطلاقاً — وهذا هو
   * السلوك الصحيح لا قيدٌ نلتفّ عليه: ما دخل الدفاتر يبقى مسنداً إلى أصله.
   *
   * عملياً: المكتمل الذي حمل عمولة يبقى، ويُحذف الملغى والمتعذّر ومكتملٌ
   * بلا عمولة (كوبون غطّاها كاملة).
   */
  private purgeWhere(cutoff: Date): Prisma.OrderWhereInput {
    return {
      createdAt: { lt: cutoff },
      status: { in: PlatformService.DELETABLE_STATUSES },
      ledgerEntries: { none: {} },
    };
  }

  /**
   * كم طلباً سيُحذف ومن أي حالة — يُقرأ قبل الحذف لا بعده. الرقم وحده هو ما
   * يجعل التأكيد تأكيداً: «احذف» بلا عدد أمامها ضغطةٌ على المجهول.
   */
  async previewOrderPurge(olderThanDays: number) {
    const cutoff = this.deleteCutoff(olderThanDays);
    const where = this.purgeWhere(cutoff);
    const [total, byStatus, oldest, newest, keptForLedger] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.order.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select: { code: true, createdAt: true },
      }),
      this.prisma.order.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
        select: { code: true, createdAt: true },
      }),
      this.prisma.order.count({
        where: {
          createdAt: { lt: cutoff },
          status: { in: PlatformService.DELETABLE_STATUSES },
          ledgerEntries: { some: {} },
        },
      }),
    ]);
    return {
      olderThanDays,
      cutoff,
      total,
      // يُعرض صراحةً: العدد الأقل من المتوقع له سبب، وإخفاؤه يجعل اللوحة
      // تبدو معطّلة
      keptForLedger,
      batchMax: PlatformService.DELETE_BATCH_MAX,
      byStatus: byStatus.map((g) => ({
        status: g.status,
        count: g._count._all,
      })),
      oldest,
      newest,
    };
  }

  /**
   * حذف نهائي لطلبات منتهية تجاوزت العمر المحدَّد. لا تراجع.
   *
   * **المال لا يُحذف مع الطلب.** قيود المحفظة (LedgerEntry) تحمل العمولة
   * وأرصدة الوكالات، وحذفها يغيّر رصيداً محسوباً ويُفسد فواتير صدرت. تُفكّ
   * صلتها بالطلب فقط (orderId ← null): المبلغ ومرجعه وتاريخه تبقى كما هي.
   * وكذلك تذاكر الدعم — سجل شكوى لا يُمحى لأن طلبه قَدُم.
   *
   * ما يُحذف فعلاً هو ما لا معنى له بلا طلبه: بنوده، وسجل حالاته، وعروض
   * التوزيع، ومحادثته، ورابط فاتورته، وسجل استهلاك كوبونه.
   *
   * دفعة واحدة بحد أقصى في كل نداء: اللوحة تعيد النداء حتى يصفر العدد،
   * فيبقى كل قفل قصيراً وكل خطوة قابلة للإيقاف.
   */
  async purgeOldOrders(olderThanDays: number, actorId: string) {
    const cutoff = this.deleteCutoff(olderThanDays);
    const victims = await this.prisma.order.findMany({
      where: this.purgeWhere(cutoff),
      orderBy: { createdAt: 'asc' },
      take: PlatformService.DELETE_BATCH_MAX,
      select: { id: true, code: true },
    });
    if (victims.length === 0) {
      return { deleted: 0, remaining: 0, olderThanDays };
    }
    const ids = victims.map((o) => o.id);

    await this.prisma.$transaction([
      // تذكرة الدعم تبقى وتُفكّ صلتها فقط: سجل شكوى لا يُمحى لأن طلبه قَدُم
      this.prisma.supportTicket.updateMany({
        where: { orderId: { in: ids } },
        data: { orderId: null },
      }),
      // ما لا يقوم بذاته بلا طلبه
      this.prisma.orderMessage.deleteMany({ where: { orderId: { in: ids } } }),
      this.prisma.orderStatusHistory.deleteMany({
        where: { orderId: { in: ids } },
      }),
      this.prisma.orderAssignmentHistory.deleteMany({
        where: { orderId: { in: ids } },
      }),
      this.prisma.driverOffer.deleteMany({ where: { orderId: { in: ids } } }),
      this.prisma.invoicePublicLink.deleteMany({
        where: { orderId: { in: ids } },
      }),
      this.prisma.couponRedemption.deleteMany({
        where: { orderId: { in: ids } },
      }),
      this.prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } }),
      this.prisma.order.deleteMany({ where: { id: { in: ids } } }),
    ]);

    // السجل يحمل رموز ما حُذف: بعد الحذف لا مصدر آخر يقول ماذا كان هناك
    await this.audit(
      actorId,
      'orders.purge',
      'Order',
      `batch:${victims.length}`,
      { codes: victims.map((o) => o.code) },
      { olderThanDays, cutoff: cutoff.toISOString() },
    );
    this.logger.warn(
      `حذف ${victims.length} طلباً أقدم من ${olderThanDays} يوماً (بواسطة ${actorId})`,
    );

    const remaining = await this.prisma.order.count({
      where: this.purgeWhere(cutoff),
    });
    return { deleted: victims.length, remaining, olderThanDays };
  }

  // ============ إعدادات التوزيع ============

  getDispatchSettings() {
    return this.prisma.dispatchSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  async updateDispatchSettings(
    data: Partial<{
      distanceWeight: number;
      availabilityWeight: number;
      driverAvailabilityWeight: number;
      loadWeight: number;
      ratingWeight: number;
      responseRateWeight: number;
      offerTimeoutSeconds: number;
      manualAssignTimeoutSeconds: number;
      maxWaitForDriverSeconds: number;
      waitRetryIntervalSeconds: number;
      maxDriversPerAgency: number;
      maxAgenciesPerOrder: number;
      maxDispatchRounds: number;
      lowBalanceThreshold: number;
      minBalanceForDispatch: number;
      commissionPerOrder: number;
      maxDeliveryRadiusKm: number;
      showSupportAgentName: boolean;
      subscriptionMonthlyPrice: number;
      arrivalGeofenceEnabled: boolean;
      respectWorkingHours: boolean;
      arrivalRadiusMeters: number;
    }>,
    actorId: string,
  ) {
    const weights = [
      data.distanceWeight, data.availabilityWeight, data.driverAvailabilityWeight,
      data.loadWeight, data.ratingWeight, data.responseRateWeight,
    ];
    if (weights.some((w) => w !== undefined)) {
      const current = await this.getDispatchSettings();
      const sum =
        (data.distanceWeight ?? Number(current.distanceWeight)) +
        (data.availabilityWeight ?? Number(current.availabilityWeight)) +
        (data.driverAvailabilityWeight ?? Number(current.driverAvailabilityWeight)) +
        (data.loadWeight ?? Number(current.loadWeight)) +
        (data.ratingWeight ?? Number(current.ratingWeight)) +
        (data.responseRateWeight ?? Number(current.responseRateWeight));
      if (Math.abs(sum - 1) > 0.001) {
        throw new BadRequestException(`مجموع الأوزان يجب أن يساوي 1.0 (الحالي: ${sum.toFixed(3)})`);
      }
    }
    const before = await this.getDispatchSettings();
    const updated = await this.prisma.dispatchSettings.update({
      where: { id: 1 },
      data,
    });
    await this.audit(actorId, 'dispatch.settings.update', 'DispatchSettings', '1',
      before as unknown as Prisma.InputJsonValue,
      data as Prisma.InputJsonValue);
    return updated;
  }

  // ============ تقرير أداء التوزيع ============

  async dispatchReport(days = 7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [offers, skips, agencies] = await Promise.all([
      this.prisma.driverOffer.groupBy({
        by: ['agencyId', 'status'],
        where: { createdAt: { gte: since } },
        _count: true,
      }),
      this.prisma.orderAssignmentHistory.groupBy({
        by: ['agencyId', 'reason'],
        where: { action: 'AGENCY_SKIPPED', createdAt: { gte: since } },
        _count: true,
      }),
      this.prisma.agency.findMany({ select: { id: true, nameAr: true, rating: true } }),
    ]);
    const byAgency = new Map<string, Record<string, number>>();
    for (const o of offers) {
      const rec = byAgency.get(o.agencyId) ?? {};
      rec[o.status] = o._count;
      byAgency.set(o.agencyId, rec);
    }
    return {
      periodDays: days,
      agencies: agencies.map((a) => {
        const rec = byAgency.get(a.id) ?? {};
        const total = (rec['ACCEPTED'] ?? 0) + (rec['REJECTED'] ?? 0) + (rec['EXPIRED'] ?? 0);
        return {
          agencyId: a.id,
          nameAr: a.nameAr,
          rating: a.rating,
          offersSent: total + (rec['PENDING'] ?? 0),
          accepted: rec['ACCEPTED'] ?? 0,
          rejected: rec['REJECTED'] ?? 0,
          expired: rec['EXPIRED'] ?? 0,
          responseRate: total === 0 ? null : Math.round(((rec['ACCEPTED'] ?? 0) / total) * 100),
          skips: skips
            .filter((s) => s.agencyId === a.id)
            .map((s) => ({ reason: s.reason, count: s._count })),
        };
      }),
    };
  }

  // ============ إشعار مخصص من الأدمن ============

  /** مستلمو فئة معيّنة — id فريد لكل مستخدم (Set يزيل تكرار سائق/موظف بنفس الحساب) */
  private async resolveBroadcastAudience(
    audience: BroadcastAudience,
    agencyId?: string,
  ): Promise<string[]> {
    if (audience === 'AGENCY') {
      if (!agencyId) throw new BadRequestException('agencyId مطلوب لفئة "وكالة معينة"');
      const [staff, drivers] = await Promise.all([
        this.prisma.userRole.findMany({
          where: { agencyId },
          select: { userId: true },
          distinct: ['userId'],
        }),
        this.prisma.driverProfile.findMany({ where: { agencyId }, select: { userId: true } }),
      ]);
      return [...new Set([...staff.map((s) => s.userId), ...drivers.map((d) => d.userId)])];
    }
    if (audience === 'AGENCIES') {
      // المالكون والموظفون في كل الوكالات، بلا السائقين: تعميمٌ إداري
      // (تعديل عمولة، تعطيل خدمة، تذكير بالرصيد) يخصّ من يتصرف عليه، وإرساله
      // للسائقين معه يعلّمهم تجاهل إشعارات الإدارة. للسائقين فئتهم.
      const rows = await this.prisma.userRole.findMany({
        where: { agencyId: { not: null }, role: { name: { not: 'DRIVER' } } },
        select: { userId: true },
        distinct: ['userId'],
      });
      return rows.map((r) => r.userId);
    }
    if (audience === 'CUSTOMERS') {
      const rows = await this.prisma.user.findMany({
        where: { roles: { none: {} }, driverProfile: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    if (audience === 'DRIVERS') {
      const rows = await this.prisma.driverProfile.findMany({ select: { userId: true } });
      return rows.map((r) => r.userId);
    }
    // ALL: زبائن التطبيق وسائقو الوكالات — لا موظفي لوحات إدارية بلا تطبيق جوال
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [
          { roles: { none: {} }, driverProfile: null },
          { driverProfile: { isNot: null } },
        ],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * إشعار مخصص يرسله الأدمن يدوياً — بث لفئة مستخدمين بدل إشعار مرتبط بحدث.
   * `push=false` يبقيه داخل التطبيق فقط (سجل الإشعارات) بلا Push خارجي.
   */
  async broadcastNotification(
    actorUserId: string,
    audience: BroadcastAudience,
    agencyId: string | undefined,
    titleAr: string,
    bodyAr: string,
    push: boolean,
  ) {
    const userIds = await this.resolveBroadcastAudience(audience, agencyId);
    if (userIds.length === 0) return { sent: 0, targeted: 0 };
    const sent = await this.notifications.sendMany(userIds, 'ADMIN_BROADCAST', titleAr, bodyAr, undefined, {
      push,
    });
    await this.audit(actorUserId, 'BROADCAST_NOTIFICATION', 'Notification', audience, undefined, {
      audience,
      agencyId,
      titleAr,
      bodyAr,
      push,
      targeted: userIds.length,
      sent,
    });
    return { sent, targeted: userIds.length };
  }
}
