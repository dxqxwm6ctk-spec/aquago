import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentAction,
  DeviceApp,
  DispatchSettings,
  DriverStatus,
  OrderStatus,
  Prisma,
} from '@prisma-v2/client';
import { agencyStaffIds } from '../common/agency-staff.util';
import { CouponsService } from '../coupons/coupons.service';
import { PrismaV2Service } from '../database/prisma-v2.service';
import {
  ammanNow,
  isWithinWorkingHours,
} from '../common/working-hours.util';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../notifications/telegram.service';
import { OrderChatService } from '../orders/order-chat.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';
import { estimateEta } from './eta.util';
import { haversineKm } from './geo.util';
import { DispatchQueue } from './dispatch.queue';

/**
 * الحالات التي يجوز فيها التقاط الطلب.
 *
 * `SEARCH_FAILED`: انتهت جولات التوزيع بلا قبول — وهو الحال الذي وُجد
 * الالتقاط من أجله. و`AGENCY_ASSIGNED`/`WAITING_FOR_DRIVER`: الوكالة قبلت
 * والطلب ينتظر سائقاً، فسائقٌ فرغ الآن أولى به من انتظار جولة أخرى.
 *
 * ما ليس هنا لا يُلتقط: الملغى انتهى، والمكتمل انتهى، وما عليه سائق ليس
 * معلّقاً أصلاً (والشرط `driverId: null` يحرسه مرة ثانية).
 */
const CLAIMABLE_STATUSES: OrderStatus[] = [
  OrderStatus.SEARCH_FAILED,
  OrderStatus.AGENCY_ASSIGNED,
  OrderStatus.WAITING_FOR_DRIVER,
];

/** وكالة مؤهلة بسائق متاح — جاهزة لاستلام الطلب الآن */
type Candidate = {
  agencyId: string;
  branchId: string;
  score: number;
  distanceKm: number;
};

/** وكالة مؤهلة لكن كل سائقيها مشغولون — أمل الطلب أثناء الانتظار */
type WaitCandidate = {
  agencyId: string;
  nameAr: string;
  distanceKm: number;
  busyDrivers: number;
};

/**
 * محرك التوزيع (FRS §7 + القرارات المعتمدة) — التدفق:
 *
 *   dispatchOrder → ترشيح الوكالات بالأوزان → AGENCY_SELECTED
 *        → ترشيح السائقين → DriverOffer (PENDING) + مهلة BullMQ
 *        → قبول: DRIVER_ASSIGNED | رفض/انتهاء: السائق التالي
 *        → استنفاد سائقي الوكالة: AGENCY_FAILED → الوكالة التالية
 *        → استنفاد الوكالات: SEARCH_FAILED + تذكرة Operations
 *
 * **توفر السائق شرط شبه أساسي** (قرار 2026-08-02): الترشيح يقسم الوكالات
 * المؤهلة طبقتين — ذات سائق متاح، وذات سائق مشغول. إن وُجدت وكالة واحدة
 * بسائق متاح فالطلب يذهب إليها فوراً ولو كانت أبعد من وكالة بلا سائق. وإن
 * خلت كل الوكالات المغطية من سائق متاح، لا يُرفض الطلب بل يدخل
 * WAITING_FOR_DRIVER بسقف زمني، ويُستأنف تلقائياً أول ما يفرغ سائق.
 *
 * كل خطوة تُسجَّل في OrderAssignmentHistory بالسبب — غذاء التقارير لاحقاً.
 * المحرك stateless: يعيد بناء "من جُرِّب" من جدول العروض نفسه، فلا يضيع
 * شيء عند إعادة تشغيل الخادم.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private prisma: PrismaV2Service,
    private queue: DispatchQueue,
    private gateway: TrackingV2Gateway,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    private coupons: CouponsService,
    private chat: OrderChatService,
  ) {}

  private settings(): Promise<DispatchSettings> {
    return this.prisma.dispatchSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  private history(
    orderId: string,
    action: AssignmentAction,
    opts: { agencyId?: string; driverId?: string; reason?: string } = {},
  ) {
    return this.prisma.orderAssignmentHistory.create({
      data: { orderId, action, ...opts },
    });
  }

  /**
   * يمرّ عبر NotificationsService فيُسقط ما أوقفه المستخدم من فئات.
   *
   * **`app` يفصل التطبيقين حين يكون الشخص واحداً.** سائقٌ يطلب مياهاً لبيته
   * يحمل نفس `userId` في التطبيقين (الدخول بالرقم يُرجع الحساب ذاته)، فبلا
   * تحديد التطبيق يصله عرضُ توصيل على تطبيق الزبون وتحديثُ طلبه على تطبيق
   * السائق. لذلك يُمرَّر صراحةً عند كل نداء بحسب من يُخاطَب.
   */
  private notify(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: object,
    app: DeviceApp = DeviceApp.CUSTOMER,
  ) {
    return this.notifications.send(userId, type, titleAr, bodyAr, data, { app });
  }

  /** إشعار يخصّ السائق أو موظف الوكالة — إلى تطبيق السائق وحده */
  private notifyDriverApp(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: object,
  ) {
    return this.notify(userId, type, titleAr, bodyAr, data, DeviceApp.DRIVER);
  }

  // ============================================================
  // نقطة الدخول
  // ============================================================

  async dispatchOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.status !== OrderStatus.CREATED) {
      throw new BadRequestException(`الطلب في حالة ${order.status} — لا يمكن بدء التوزيع`);
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.SEARCHING, searchStartedAt: new Date() },
    });
    await this.prisma.orderStatusHistory.create({
      data: { orderId, status: OrderStatus.SEARCHING, noteAr: 'جاري البحث عن أقرب وكالة' },
    });
    return this.selectNextAgency(orderId);
  }

  // ============================================================
  // ترشيح الوكالات
  // ============================================================

  /**
   * المرشحات: الفرع ضمن نطاق توصيله من موقع الزبون (ST_DWithin على
   * geography — مسافة حقيقية بالأمتار) + ACTIVE + مفتوحة الآن + مخزون لكل
   * أنواع الطلب + رصيد موجب فوق الحد. ثم Score بالأوزان الستة.
   *
   * تُعيد طبقتين:
   *   ready   — مؤهلة ولديها سائق متاح لم يُعرض عليه الطلب (مرتبة بالأفضلية)
   *   waiting — مؤهلة تماماً لكن سائقوها مشغولون/غير متصلين الآن
   * الوكالة التي لا سائقين لديها إطلاقاً تُستبعد نهائياً (انتظارها بلا أمل).
   *
   * لا حدود مرسومة ولا جداول تغطية: أي وكالة تسجل نقطتها ونطاقها فتعمل
   * فوراً في أي مدينة. الحدود الإدارية بقيت للرسوم والتقارير فقط.
   */
  private async rankAgencies(order: {
    id: string;
    deliveryLat: number;
    deliveryLng: number;
    items: { bottleTypeId: string }[];
  }) {
    const settings = await this.settings();
    const neededTypes = [...new Set(order.items.map((i) => i.bottleTypeId))];

    // الوكالات التي سبق اختيارها لهذا الطلب تُستبعد نهائياً
    const triedAgencyIds = new Set(
      (
        await this.prisma.orderAssignmentHistory.findMany({
          where: { orderId: order.id, action: AssignmentAction.AGENCY_SELECTED },
          select: { agencyId: true },
        })
      ).map((h) => h.agencyId!),
    );

    const empty = { ready: [] as Candidate[], waiting: [] as WaitCandidate[] };
    const inRange = await this.branchesInRange(order.deliveryLat, order.deliveryLng);
    if (inRange.length === 0) return empty;
    const branches = await this.prisma.agencyBranch.findMany({
      where: { id: { in: inRange.map((b) => b.branchId) } },
      include: {
        agency: {
          include: {
            holidays: { where: { date: this.todayDate() } },
            // كل الجدول لا يوم واحد: نحتاج الأمس أيضاً لدوامٍ يعبر منتصف الليل،
            // ونحتاج معرفة هل للوكالة جدول أصلاً (الغياب = تعمل دائماً)
            workingHours: true,
            wallet: true,
            availability: true,
            drivers: { where: { status: 'AVAILABLE' } },
          },
        },
      },
    });
    const distanceByBranch = new Map(inRange.map((b) => [b.branchId, b.distanceKm]));
    // أقرب فرع لكل وكالة يمثّلها (وكالة متعددة الفروع تُرشَّح مرة واحدة)
    const coverage = [...branches]
      .sort((x, y) => distanceByBranch.get(x.id)! - distanceByBranch.get(y.id)!)
      .filter((b, i, all) => all.findIndex((o) => o.agencyId === b.agencyId) === i);

    const totalActiveTypes = await this.prisma.waterBottleType.count({
      where: { active: true },
    });

    // لحظة واحدة لكل الترشيح: قراءة الوقت داخل الحلقة تجعل وكالةً تُقاس
    // بثانية ووكالةً بأخرى، وعند حدّ الدوام يصير القرار رهن ترتيب الحلقة
    const now = ammanNow();

    const candidates: Candidate[] = [];
    const waiting: WaitCandidate[] = [];

    for (const c of coverage) {
      const a = c.agency;
      if (triedAgencyIds.has(a.id)) continue;

      const skip = async (reason: string) =>
        this.history(order.id, AssignmentAction.AGENCY_SKIPPED, {
          agencyId: a.id,
          reason,
        });

      if (a.status !== 'ACTIVE') {
        await skip(`الوكالة ${a.status}`);
        continue;
      }
      if (a.holidays.length > 0) {
        await skip('الوكالة في إجازة اليوم');
        continue;
      }
      // جدول الدوام يغلق الوكالة خارج ساعاتها. وكالة بلا جدول تعمل على مدار
      // الساعة كما كانت — الغياب فتحٌ لا إغلاق (انظر isWithinWorkingHours).
      if (
        settings.respectWorkingHours &&
        a.workingHours.length > 0 &&
        !isWithinWorkingHours(a.workingHours, now)
      ) {
        await skip('خارج ساعات دوام الوكالة');
        continue;
      }
      const availableTypeIds = new Set(
        a.availability.filter((v) => v.available).map((v) => v.bottleTypeId),
      );
      if (!neededTypes.every((t) => availableTypeIds.has(t))) {
        await skip('لا يتوفر مخزون لأصناف الطلب');
        continue;
      }
      const balance = Number(a.wallet?.balance ?? 0);
      // القرار 8: رصيد صفر (أو دون الحد) = خارج التوزيع
      if (balance <= 0 || balance < Number(settings.minBalanceForDispatch)) {
        await skip('رصيد المحفظة غير كافٍ لاستقبال الطلبات');
        continue;
      }
      // السائقون الذين ما زال يمكن عرض الطلب عليهم — بحساب الجولات، وإلا
      // بدت وكالةٌ كل سائقيها لم يردّوا كأنها بلا سائقين فخرجت من الترشيح
      const untriedDrivers = await this.untriedDrivers(
        order.id, a.id, undefined, settings.maxDispatchRounds,
      );
      if (untriedDrivers.length === 0) {
        // الوكالة مؤهلة بالكامل — يبقى السائق. إن كان لديها سائق مشغول أو
        // غير متصل فهي مرشحة للانتظار؛ وإن لم يكن لديها سائقون أصلاً تُستبعد.
        const idle = await this.untriedDrivers(
          order.id, a.id, ['BUSY', 'OFFLINE'], settings.maxDispatchRounds,
        );
        if (idle.length === 0) {
          await skip('لا سائقين مسجلين لدى الوكالة');
          continue;
        }
        waiting.push({
          agencyId: a.id,
          nameAr: a.nameAr,
          distanceKm: distanceByBranch.get(c.id)!,
          busyDrivers: idle.length,
        });
        continue;
      }

      // ==== المعادلة المعتمدة: مسافة 40% + توفر 25% + سائقون 20% + تقييم 10% + استجابة 5% ====
      // القرب يُقاس نسبة إلى نطاق الفرع نفسه: على بابه = 1، على حافة نطاقه = 0
      const distanceKm = distanceByBranch.get(c.id)!;
      const distScore = Math.max(0, 1 - distanceKm / Math.max(c.deliveryRadiusKm, 0.1));
      const availScore = totalActiveTypes ? availableTypeIds.size / totalActiveTypes : 0;
      const driverScore = Math.min(untriedDrivers.length, 5) / 5;
      const ratingScore = a.rating / 5;
      const responseScore = await this.agencyResponseRate(a.id);
      // ضغط العمل: طلبات الوكالة الجارية الآن — الأقل ضغطاً يُقدَّم
      const loadScore = await this.agencyLoadScore(a.id);

      const score =
        Number(settings.distanceWeight) * distScore +
        Number(settings.availabilityWeight) * availScore +
        Number(settings.driverAvailabilityWeight) * driverScore +
        Number(settings.ratingWeight) * ratingScore +
        Number(settings.responseRateWeight) * responseScore +
        Number(settings.loadWeight) * loadScore;

      candidates.push({ agencyId: a.id, branchId: c.id, score, distanceKm });
    }

    return {
      ready: candidates.sort((x, y) => y.score - x.score),
      waiting: waiting.sort((x, y) => x.distanceKm - y.distanceKm),
    };
  }

  /**
   * الفروع التي يقع الموقع داخل نطاق توصيلها، مرتبة بالأقرب.
   * ST_DWithin على geography يقارن أمتاراً حقيقية (لا درجات).
   */
  async branchesInRange(lat: number, lng: number) {
    return this.prisma.$queryRaw<{ branchId: string; agencyId: string; distanceKm: number }[]>`
      SELECT b.id AS "branchId", b."agencyId",
             ST_Distance(
               ST_MakePoint(b.lng, b.lat)::geography,
               ST_MakePoint(${lng}, ${lat})::geography
             ) / 1000.0 AS "distanceKm"
      FROM "AgencyBranch" b
      WHERE b.active = true
        AND ST_DWithin(
              ST_MakePoint(b.lng, b.lat)::geography,
              ST_MakePoint(${lng}, ${lat})::geography,
              b."deliveryRadiusKm" * 1000.0
            )
      ORDER BY "distanceKm"
    `;
  }

  /** 1 = لا ضغط، 0 = عند 10 طلبات جارية فأكثر */
  private async agencyLoadScore(agencyId: string): Promise<number> {
    const active = await this.prisma.order.count({
      where: {
        agencyId,
        status: {
          in: [
            OrderStatus.AGENCY_ASSIGNED,
            OrderStatus.DRIVER_ASSIGNED,
            OrderStatus.PICKED_UP,
            OrderStatus.DELIVERING,
          ],
        },
      },
    });
    return Math.max(0, 1 - active / 10);
  }

  /** نسبة قبول عروض سائقي الوكالة آخر 7 أيام — 1 عند غياب التاريخ */
  private async agencyResponseRate(agencyId: string): Promise<number> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [total, accepted] = await Promise.all([
      this.prisma.driverOffer.count({
        where: { agencyId, createdAt: { gte: since }, status: { not: 'PENDING' } },
      }),
      this.prisma.driverOffer.count({
        where: { agencyId, createdAt: { gte: since }, status: 'ACCEPTED' },
      }),
    ]);
    return total === 0 ? 1 : accepted / total;
  }

  // تاريخ "اليوم" يُحسب بتوقيت عمّان صراحة — الخادم قد يعمل بـ UTC، فبعد
  // منتصف الليل محلياً يبقى UTC على تاريخ الأمس فتُقرأ إجازة اليوم الخطأ.
  private static readonly TZ = 'Asia/Amman';




  private todayDate(): Date {
    return ammanNow().date;
  }

  // ============================================================
  // ترشيح السائقين وإرسال العروض
  // ============================================================

  /**
   * السائقون المؤهلون لعرض هذا الطلب في الجولة [round].
   *
   * الجولة الأولى: من لم يُعرض عليه الطلب قط.
   * الجولات التالية: من انقضت مهلته **دون رد** — لعلّه كان يقود أو لم يسمع
   * الإشعار، وطرق بابه ثانيةً خير من خسارة الطلب.
   *
   * من رفض صراحةً لا يُعاد عليه أبداً مهما كثرت الجولات: رفضُه ردٌّ لا صمت،
   * وإعادة عرضٍ رفضه مضايقةٌ لا محاولة.
   */
  private async untriedDrivers(
    orderId: string,
    agencyId: string,
    statuses: DriverStatus[] = [DriverStatus.AVAILABLE],
    round = 1,
  ) {
    const offers = await this.prisma.driverOffer.findMany({
      where: { orderId },
      select: { driverId: true, status: true },
    });
    const history = new Map<string, string[]>();
    for (const o of offers) {
      history.set(o.driverId, [...(history.get(o.driverId) ?? []), o.status]);
    }
    const drivers = await this.prisma.driverProfile.findMany({
      where: { agencyId, status: { in: statuses }, isVerified: true },
    });
    return drivers.filter((d) => {
      const past = history.get(d.userId) ?? [];
      // ردَّ يوماً (رفضاً أو قبولاً) أو عنده عرض قائم الآن → خارج الترشيح
      if (past.some((st) => st !== 'EXPIRED')) return false;
      return past.length < round;
    });
  }

  private async selectNextAgency(orderId: string): Promise<unknown> {
    const settings = await this.settings();
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });

    const selectedCount = await this.prisma.orderAssignmentHistory.count({
      where: { orderId, action: AssignmentAction.AGENCY_SELECTED },
    });
    if (selectedCount >= settings.maxAgenciesPerOrder) {
      return this.searchFailed(orderId, 'بلغ الحد الأقصى لعدد الوكالات');
    }

    const { ready, waiting } = await this.rankAgencies(order);
    if (ready.length === 0) {
      // وكالة أبعد بسائق متاح تسبق وكالة أقرب بلا سائق — فإن لم تبقَ أي
      // وكالة بسائق متاح ننتظر بدل أن نخسر الطلب
      if (waiting.length > 0) return this.enterWaitingForDriver(orderId, waiting);
      return this.searchFailed(orderId, 'لا وكالة مؤهلة متبقية في منطقة الطلب');
    }

    const best = ready[0];
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.AGENCY_ASSIGNED,
        agencyId: best.agencyId,
        branchId: best.branchId,
        agencyAssignedAt: new Date(),
      },
    });
    await this.history(orderId, AssignmentAction.AGENCY_SELECTED, {
      agencyId: best.agencyId,
      reason: `Score ${best.score.toFixed(3)} — ${best.distanceKm.toFixed(1)}كم`,
    });
    return this.continueWithinAgency(orderId, best.agencyId);
  }

  /**
   * نقطة التفرع (القرار 4): Auto Dispatch يعرض تلقائياً على أفضل سائق،
   * وإلا يُعلَّق الطلب بانتظار تعيين موظف الوكالة يدوياً — بمهلة تحمي الزبون.
   */
  async continueWithinAgency(orderId: string, agencyId: string) {
    const agency = await this.prisma.agency.findUniqueOrThrow({
      where: { id: agencyId },
    });
    if (agency.autoDispatch) {
      return this.offerToNextDriver(orderId, agencyId);
    }
    return this.awaitManualAssignment(orderId, agencyId);
  }

  private async awaitManualAssignment(orderId: string, agencyId: string) {
    const settings = await this.settings();
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    // المالك والموظفون دون السائقين — التعيين ليس بيد السائق أصلاً
    const staff = await agencyStaffIds(this.prisma, agencyId);
    for (const userId of staff) {
      await this.notifyDriverApp(
        userId,
        'ORDER_NEEDS_ASSIGNMENT',
        'طلب جديد بانتظار تعيين سائق',
        `الطلب ${order.code} أُسند لوكالتكم — عيّنوا سائقاً خلال ${Math.round(settings.manualAssignTimeoutSeconds / 60)} دقائق`,
        { orderId },
      );
    }
    this.gateway.emitToAgency(agencyId, 'order:needs-assignment', {
      orderId,
      code: order.code,
      addressText: order.addressText,
      total: Number(order.total),
    });
    await this.queue.scheduleManualTimeout(
      orderId,
      agencyId,
      settings.manualAssignTimeoutSeconds * 1000,
    );
    return { status: 'AWAITING_MANUAL_ASSIGNMENT', orderId, agencyId };
  }

  /**
   * كم يبعد الزبون عن مستودع الوكالة، وهل هو خارج نطاقها المعلن.
   *
   * التوزيع التلقائي لا يخرج عن النطاق أصلاً، لكن الإسناد اليدوي والإنقاذ
   * يتجاوزانه عمداً — فيصل العرضُ سائقاً لا يعرف أن الزبون على بُعد ضعف ما
   * اعتاد. يقبل ثم يكتشف، أو ينسحب بعد القبول وتُفتح تذكرة. الرقم يُقال له
   * قبل أن يقرّر.
   *
   * بلا فرع للطلب لا مرجع للقياس — نرجع null ولا نخمّن.
   */
  offerZoneFor(order: {
    branchId: string | null;
    deliveryLat: number;
    deliveryLng: number;
  }) {
    return this.offerZoneInfo(order);
  }

  private async offerZoneInfo(order: {
    branchId: string | null;
    deliveryLat: number;
    deliveryLng: number;
  }): Promise<{ distanceKm: number; radiusKm: number; outOfZone: boolean } | null> {
    if (!order.branchId) return null;
    const branch = await this.prisma.agencyBranch.findUnique({
      where: { id: order.branchId },
      select: { lat: true, lng: true, deliveryRadiusKm: true },
    });
    if (!branch) return null;
    const distanceKm =
      Math.round(
        haversineKm(branch.lat, branch.lng, order.deliveryLat, order.deliveryLng) * 10,
      ) / 10;
    return {
      distanceKm,
      radiusKm: branch.deliveryRadiusKm,
      outOfZone: distanceKm > branch.deliveryRadiusKm,
    };
  }

  /** تعيين يدوي من موظف الوكالة — يرسل عرضاً للسائق المختار تحديداً */
  async manualOffer(
    orderId: string,
    agencyId: string,
    driverId: string,
    actorUserId: string,
  ) {
    const settings = await this.settings();
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, agencyId, status: OrderStatus.AGENCY_ASSIGNED },
    });
    if (!order) {
      throw new BadRequestException('الطلب غير متاح للتعيين (ربما نُقل أو عُيّن)');
    }
    const pending = await this.prisma.driverOffer.findFirst({
      where: { orderId, status: 'PENDING' },
    });
    if (pending) throw new BadRequestException('يوجد عرض معلق بالفعل لهذا الطلب');
    const driver = await this.prisma.driverProfile.findFirst({
      where: { userId: driverId, agencyId, status: 'AVAILABLE', isVerified: true },
    });
    if (!driver) throw new BadRequestException('السائق غير متاح أو غير تابع للوكالة');

    const agencyOffers = await this.prisma.driverOffer.count({ where: { orderId, agencyId } });
    const expiresAt = new Date(Date.now() + settings.offerTimeoutSeconds * 1000);
    const offer = await this.prisma.driverOffer.create({
      data: { orderId, agencyId, driverId, attemptNo: agencyOffers + 1, expiresAt },
    });
    await this.history(orderId, AssignmentAction.MANUAL_ASSIGNED, {
      agencyId,
      driverId,
      reason: `تعيين يدوي من موظف الوكالة`,
    });
    await this.notifyDriverApp(driverId, 'OFFER_RECEIVED', 'طلب توصيل جديد', `طلب ${order.code} بانتظار ردك`, {
      offerId: offer.id,
      orderId,
      expiresAt: expiresAt.toISOString(),
    });
    this.gateway.emitOfferNew(driverId, {
      offerId: offer.id,
      orderId,
      code: order.code,
      addressText: order.addressText,
      total: Number(order.total),
      // لحظة إنشاء الطلب لا لحظة وصول العرض: طلبٌ أنقذه موظف العمليات بعد
      // ساعات يصل السائق كأنه طلبٌ للتوّ، فينطلق إلى زبون لم يعد ينتظر.
      // كان التطبيق يفترض «الآن» لغياب الحقل — افتراضٌ لا يكذب إلا هنا.
      createdAt: order.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      timeoutSeconds: settings.offerTimeoutSeconds,
      // التعيين اليدوي يتجاوز النطاق — السائق يستحق أن يعرف قبل أن يقبل
      zone: await this.offerZoneInfo(order),
    });
    await this.queue.scheduleOfferTimeout(offer.id, settings.offerTimeoutSeconds * 1000);
    this.logger.log(`تعيين يدوي: عرض ${offer.id} → السائق ${driverId} (بواسطة ${actorUserId})`);
    return offer;
  }

  /** انقضت مهلة التعيين اليدوي دون تصرف — الطلب يُنقل لوكالة أخرى */
  async handleManualTimeout(orderId: string, agencyId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    // no-op إن عُيّن سائق أو نُقل الطلب أو يوجد عرض معلق (مهلته تتكفل به)
    if (!order || order.status !== OrderStatus.AGENCY_ASSIGNED || order.agencyId !== agencyId) {
      return;
    }
    // الطلب موقوف بانتظار قرار الزبون بعد انسحاب سائق — مهلته الخاصة تتكفل به
    if (order.redispatchAskedAt) return;
    const pending = await this.prisma.driverOffer.findFirst({
      where: { orderId, status: 'PENDING' },
    });
    if (pending) return;
    await this.agencyFailed(orderId, agencyId, 'لم يعيَّن سائق خلال مهلة التعيين اليدوي');
  }

  /**
   * الطلب موقوف بانتظار رد الزبون على «نبحث لك عن سائق آخر؟». الجدولة هنا لا
   * في خدمة الطلبات لأن الطابور يملكه المحرك، والمهلة تصمد أمام إعادة تشغيل
   * الخادم بعكس setTimeout.
   */
  async scheduleRedispatchDecision(orderId: string, delayMs: number): Promise<void> {
    await this.queue.scheduleRedispatchTimeout(orderId, delayMs);
  }

  /** لم يردّ الزبون خلال المهلة — يُلغى الطلب بلا خصم ويُحرَّر كوبونه */
  async handleRedispatchTimeout(orderId: string) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, redispatchAskedAt: { not: null } },
      data: {
        redispatchAskedAt: null,
        status: OrderStatus.CANCELLED,
        cancelReason: 'أُلغي الطلب: انسحب السائق ولم يصل رد منك خلال المهلة',
      },
    });
    if (count === 0) return; // ردّ الزبون أو أُلغي الطلب سلفاً

    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.CANCELLED,
        noteAr: 'انقضت مهلة رد الزبون بعد انسحاب السائق',
      },
    });
    await this.coupons.releaseForOrder(orderId);
    await this.notify(
      order.customerId,
      'ORDER_CANCELLED',
      'أُلغي طلبك',
      `لم يصلنا ردّك بعد انسحاب السائق، فأُلغي الطلب ${order.code} ولم يُخصم أي مبلغ — يمكنك إعادة الطلب في أي وقت.`,
      { orderId },
    );
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.CANCELLED,
      'انقضت مهلة الرد بعد انسحاب السائق',
      order.agencyId,
    );
  }

  private async offerToNextDriver(orderId: string, agencyId: string): Promise<unknown> {
    const settings = await this.settings();
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    const agencyOffers = await this.prisma.driverOffer.findMany({
      where: { orderId, agencyId },
      select: { driverId: true },
    });
    // السقف على عدد السائقين المختلفين لا على عدد العروض: الجولات تكرّر
    // الطَّرق على نفس النفر، وعدّ العروض كان سيستنفد السقف بالجولة الثانية.
    const distinctTried = new Set(agencyOffers.map((o) => o.driverId)).size;

    // نبدأ بمن لم يُعرض عليه قط، ثم نوسّع لمن لم يردّ في جولة سابقة
    let drivers: Awaited<ReturnType<typeof this.untriedDrivers>> = [];
    let round = 1;
    for (; round <= settings.maxDispatchRounds; round++) {
      if (round === 1 && distinctTried >= settings.maxDriversPerAgency) continue;
      drivers = await this.untriedDrivers(orderId, agencyId, undefined, round);
      if (drivers.length > 0) break;
    }
    if (drivers.length === 0) {
      return this.agencyFailed(orderId, agencyId, 'لم يقبل أي سائق متاح');
    }

    // ترتيب السائقين: الأقرب للزبون 60% + التقييم 40%
    const scored = drivers
      .map((d) => {
        const km =
          d.currentLat != null && d.currentLng != null
            ? haversineKm(d.currentLat, d.currentLng, order.deliveryLat, order.deliveryLng)
            : 15;
        return { d, score: 0.6 * Math.max(0, 1 - km / 15) + 0.4 * (d.rating / 5) };
      })
      .sort((x, y) => y.score - x.score);
    const chosen = scored[0].d;

    const expiresAt = new Date(Date.now() + settings.offerTimeoutSeconds * 1000);
    const offer = await this.prisma.driverOffer.create({
      data: {
        orderId,
        agencyId,
        driverId: chosen.userId,
        attemptNo: agencyOffers.length + 1,
        expiresAt,
      },
    });
    await this.history(orderId, AssignmentAction.DRIVER_OFFER_SENT, {
      agencyId,
      driverId: chosen.userId,
      reason: `الجولة ${round} — تنتهي خلال ${settings.offerTimeoutSeconds} ثانية`,
    });
    await this.notifyDriverApp(chosen.userId, 'OFFER_RECEIVED', 'طلب توصيل جديد', `طلب ${order.code} بانتظار ردك`, {
      offerId: offer.id,
      orderId,
      expiresAt: expiresAt.toISOString(),
    });
    // 4.4: نموذج "عرض بمؤقت" — يصل السائق لحظياً مع وقت الانتهاء
    this.gateway.emitOfferNew(chosen.userId, {
      offerId: offer.id,
      orderId,
      code: order.code,
      addressText: order.addressText,
      total: Number(order.total),
      // لحظة إنشاء الطلب لا لحظة وصول العرض: طلبٌ أنقذه موظف العمليات بعد
      // ساعات يصل السائق كأنه طلبٌ للتوّ، فينطلق إلى زبون لم يعد ينتظر.
      // كان التطبيق يفترض «الآن» لغياب الحقل — افتراضٌ لا يكذب إلا هنا.
      createdAt: order.createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      timeoutSeconds: settings.offerTimeoutSeconds,
      zone: await this.offerZoneInfo(order),
    });
    await this.queue.scheduleOfferTimeout(offer.id, settings.offerTimeoutSeconds * 1000);
    this.logger.log(`عرض ${offer.id} → السائق ${chosen.userId} (طلب ${order.code})`);
    return offer;
  }

  // ============================================================
  // ردود السائق + المهلة
  // ============================================================

  /** «دقيقة/دقيقتين/دقائق» — الرقم وحده بالعربية يقرأ ركيكاً */
  private minutesAr(n: number): string {
    if (n === 1) return 'دقيقة';
    if (n === 2) return 'دقيقتين';
    if (n <= 10) return `${n} دقائق`;
    return `${n} دقيقة`;
  }

  /**
   * أول رسالة في محادثة الطلب: السائق يعرّف بنفسه ويقول إنه في الطريق مع
   * الوقت المتوقع للوصول.
   *
   * الوقت قد يتعذّر تقديره (سائق لم يُرسل موقعه بعد) — عندها تُرسل الرسالة
   * بلا رقم بدل أن تُلغى، فالتعريف نفسه هو المقصود. وفشلها لا يُسقط قبول
   * الطلب: السائق قبِل فعلاً وحُدّثت الحالة، ورسالة ترحيب لا تستحق التراجع
   * عن ذلك — لذا تُبتلع أخطاؤها وتُسجَّل.
   */
  private async sendDriverGreeting(
    offer: {
      orderId: string;
      driver: {
        name: string;
        driverProfile: { currentLat: number | null; currentLng: number | null } | null;
      };
      order: {
        deliveryLat: number;
        deliveryLng: number;
        branch: { lat: number; lng: number } | null;
      };
    },
    driverId: string,
  ): Promise<boolean> {
    try {
      const eta = estimateEta({
        status: OrderStatus.DRIVER_ASSIGNED,
        deliveryLat: offer.order.deliveryLat,
        deliveryLng: offer.order.deliveryLng,
        driverLat: offer.driver.driverProfile?.currentLat,
        driverLng: offer.driver.driverProfile?.currentLng,
        branchLat: offer.order.branch?.lat,
        branchLng: offer.order.branch?.lng,
      });
      const body = eta
        ? `مرحباً! معك ${offer.driver.name}، قبلت طلبك وأنا في الطريق — ` +
          `بكون عندك خلال ${this.minutesAr(eta.minutes)} تقريباً.`
        : `مرحباً! معك ${offer.driver.name}، قبلت طلبك وأنا في الطريق إليك.`;
      await this.chat.send(offer.orderId, driverId, body);
      return true;
    } catch (e) {
      this.logger.warn(`تعذّر إرسال رسالة تعريف السائق للطلب ${offer.orderId}: ${e}`);
      return false;
    }
  }

  /** قبول ذري: يفشل إن سبقه انتهاء المهلة أو قبول آخر أو إلغاء */
  /**
   * الطلبات المتاحة للالتقاط: انتهت مهلة توزيعها ولم يأخذها أحد.
   *
   * التوزيع الآلي يعرض الطلب على السائقين بمهلة، فإن مرّت بلا قبول صار الطلب
   * `SEARCH_FAILED` — والزبون ينتظر بلا أن يعرف أن أحداً سيأتي. وقد يكون
   * سائق فرغ لتوّه بعد انتهاء المهلة بثوانٍ. فبدل أن يضيع الطلب يُعرض على
   * سائقي الوكالات التي يعمل بها ليأخذه من يقدر.
   *
   * الشروط الثلاثة صريحة: لا سائق عليه، وحالته تسمح، وضمن وكالة هذا السائق —
   * فلا يرى سائقُ وكالةٍ طلبات وكالة أخرى ولا يسحبها من تحتها.
   */
  async claimableOrders(driverId: string) {
    const agencyIds = await this.driverAgencyIds(driverId);
    if (agencyIds.length === 0) return [];
    return this.prisma.order.findMany({
      where: {
        driverId: null,
        status: { in: CLAIMABLE_STATUSES },
        agencyId: { in: agencyIds },
      },
      include: {
        items: { include: { bottleType: true } },
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 30,
    });
  }

  /**
   * السائق يلتقط طلباً معلّقاً بنفسه.
   *
   * **الالتقاط ذرّي**: `updateMany` بشرط `driverId: null` هو ما يمنع سائقين
   * ضغطا في اللحظة نفسها من أخذ الطلب معاً — أول من يصل يكتب، والثاني يجد
   * `count === 0` فيُخبَر أن غيره سبقه. الفحص قبل الكتابة (findFirst ثم
   * update) كان سيترك نافذةً بينهما يقع فيها الاثنان.
   */
  async claimOrder(orderId: string, driverId: string) {
    const agencyIds = await this.driverAgencyIds(driverId);
    const { count } = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        driverId: null,
        status: { in: CLAIMABLE_STATUSES },
        agencyId: { in: agencyIds },
      },
      data: {
        status: OrderStatus.DRIVER_ASSIGNED,
        driverId,
        driverAssignedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        'الطلب لم يعد متاحاً — أخذه سائق آخر أو أُلغي',
      );
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { bottleType: true } },
        customer: { select: { name: true } },
        branch: { select: { lat: true, lng: true } },
      },
    });
    const driver = await this.prisma.user.findUniqueOrThrow({
      where: { id: driverId },
      include: { driverProfile: true },
    });

    await this.prisma.$transaction([
      this.prisma.driverProfile.update({
        where: { userId: driverId },
        data: { status: 'BUSY' },
      }),
      this.prisma.orderStatusHistory.create({
        data: {
          orderId,
          status: OrderStatus.DRIVER_ASSIGNED,
          actorUserId: driverId,
          noteAr: 'التقط السائق الطلب من قائمة الطلبات المعلّقة',
        },
      }),
    ]);
    await this.history(orderId, AssignmentAction.MANUAL_ASSIGNED, {
      agencyId: order.agencyId ?? undefined,
      driverId,
    });

    // الزبون كان ينتظر بلا خبر بعد فشل التوزيع — هذا أول ما يقول له إن أحداً
    // في الطريق، فيُدفع إلى جهازه لا إلى الوارد وحده.
    await this.notifications.send(
      order.customerId,
      'ORDER_ACCEPTED',
      'تم قبول طلبك',
      `السائق ${driver.name} في الطريق قريباً`,
      { orderId },
    );
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.DRIVER_ASSIGNED,
      `قبل السائق ${driver.name} طلبك`,
      order.agencyId ?? undefined,
    );
    return order;
  }

  /** الوكالات التي يعمل بها هذا السائق — أساس ما يراه وما يلتقطه */
  private async driverAgencyIds(driverId: string): Promise<string[]> {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: { agencyId: true },
    });
    return profile?.agencyId ? [profile.agencyId] : [];
  }

  async acceptOffer(offerId: string, driverId: string) {
    const { count } = await this.prisma.driverOffer.updateMany({
      where: { id: offerId, driverId, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('العرض لم يعد متاحاً');

    const offer = await this.prisma.driverOffer.findUniqueOrThrow({
      where: { id: offerId },
      include: {
        // موقع السائق والفرع: يُقدَّران زمن الوصول لرسالة التعريف التلقائية
        driver: { include: { driverProfile: true } },
        order: { include: { branch: { select: { lat: true, lng: true } } } },
      },
    });

    // العمولة مثبتة على الطلب منذ إنشائه (الزبون رآها ضمن الإجمالي) — لا
    // تُحتسب هنا. أجر السائق شأن بينه وبين وكالته — لا تتعقبه المنصة.
    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: offer.orderId },
        data: {
          status: OrderStatus.DRIVER_ASSIGNED,
          driverId,
          driverAssignedAt: new Date(),
        },
      }),
      this.prisma.driverProfile.update({
        where: { userId: driverId },
        data: { status: 'BUSY' },
      }),
      this.prisma.orderStatusHistory.create({
        data: {
          orderId: offer.orderId,
          status: OrderStatus.DRIVER_ASSIGNED,
          actorUserId: driverId,
          noteAr: 'قبل السائق الطلب',
        },
      }),
    ]);
    await this.history(offer.orderId, AssignmentAction.DRIVER_ACCEPTED, {
      agencyId: offer.agencyId,
      driverId,
    });

    // رسالة تعريف من السائق داخل محادثة الطلب. تُرسل باسمه (authorUserId)
    // فتظهر للزبون كأنه كتبها — وهي أول ما يراه عن الرجل القادم إليه.
    const greetingSent = await this.sendDriverGreeting(offer, driverId);

    // إشعاران متتاليان عن حدث واحد ضجيج: إن وصلت رسالة السائق فدفعُها هو
    // التنبيه، ويبقى سجل «تم قبول طلبك» داخل التطبيق بلا دفع ثانٍ. وإن
    // تعذّرت الرسالة يعود الدفع لهذا الإشعار فلا يفوت الزبونَ الخبر.
    await this.notifications.send(
      offer.order.customerId,
      'ORDER_ACCEPTED',
      'تم قبول طلبك',
      `السائق ${offer.driver.name} في الطريق قريباً`,
      { orderId: offer.orderId },
      { push: !greetingSent },
    );
    this.gateway.emitOrderStatus(
      offer.orderId,
      offer.order.customerId,
      OrderStatus.DRIVER_ASSIGNED,
      `قبل السائق ${offer.driver.name} طلبك`,
      offer.agencyId,
    );
    // نفس شكل الطلب الذي تُرجعه بقية المسارات: تطبيق السائق يحلّل كل طلب
    // بنموذج واحد، وردٌّ ناقص الحقول كان يكسر التحليل عند القبول تحديداً
    // (وكالة بلا id) رغم أن الطلب نفسه نجح.
    const fullOrder = await this.prisma.order.findUnique({
      where: { id: offer.orderId },
      include: {
        items: { include: { bottleType: true } },
        agency: { select: { id: true, nameAr: true, phone: true } },
        driver: { select: { id: true, name: true, phone: true } },
        // الرقم حق السائق ما دام التوصيل قائماً — وهنا الطلب بدأ للتو
        customer: { select: { name: true, phone: true } },
      },
    });
    return fullOrder;
  }

  async rejectOffer(offerId: string, driverId: string, reason?: string) {
    const { count } = await this.prisma.driverOffer.updateMany({
      where: { id: offerId, driverId, status: 'PENDING' },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('العرض لم يعد متاحاً');
    const offer = await this.prisma.driverOffer.findUniqueOrThrow({ where: { id: offerId } });
    await this.history(offer.orderId, AssignmentAction.DRIVER_REJECTED, {
      agencyId: offer.agencyId,
      driverId,
      reason,
    });
    return this.continueWithinAgency(offer.orderId, offer.agencyId);
  }

  /** يستدعيه BullMQ Worker عند انقضاء المهلة — no-op إن سبقه رد */
  async handleOfferTimeout(offerId: string) {
    const { count } = await this.prisma.driverOffer.updateMany({
      where: { id: offerId, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    if (count === 0) return; // قُبل أو رُفض قبل المهلة
    const offer = await this.prisma.driverOffer.findUniqueOrThrow({ where: { id: offerId } });
    await this.history(offer.orderId, AssignmentAction.OFFER_EXPIRED, {
      agencyId: offer.agencyId,
      driverId: offer.driverId,
      reason: 'انتهت المهلة دون رد',
    });
    // يخفي المؤقت من شاشة السائق الذي لم يرد
    this.gateway.emitOfferClosed(offer.driverId, { offerId, result: 'EXPIRED' });
    await this.continueWithinAgency(offer.orderId, offer.agencyId);
  }

  // ============================================================
  // طابور انتظار سائق
  // ============================================================

  /**
   * كل الوكالات المغطية مؤهلة لكن سائقوها مشغولون — الطلب ينتظر بدل أن
   * يُرفض، لأن سائقاً قد يفرغ بعد دقيقة. الانتظار محدود بسقف
   * maxWaitForDriverSeconds ويُقاس من أول دخول للطابور مهما تكررت
   * محاولات الاستئناف.
   */
  private async enterWaitingForDriver(orderId: string, waiting: WaitCandidate[]) {
    const settings = await this.settings();
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const now = new Date();
    const firstTime = order.waitingSince == null;
    const since = order.waitingSince ?? now;
    const until =
      order.waitingUntil ??
      new Date(since.getTime() + settings.maxWaitForDriverSeconds * 1000);

    // انقضى السقف أثناء محاولة استئناف — لا نعيده للطابور بلا مؤقت
    if (until.getTime() <= now.getTime()) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.WAITING_FOR_DRIVER, waitingSince: since, waitingUntil: until },
      });
      return this.handleWaitTimeout(orderId);
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.WAITING_FOR_DRIVER,
        agencyId: null,
        branchId: null,
        waitingSince: since,
        waitingUntil: until,
      },
    });

    if (firstTime) {
      const nearest = waiting[0];
      await this.history(orderId, AssignmentAction.WAITING_STARTED, {
        agencyId: nearest.agencyId,
        reason: `${waiting.length} وكالة تغطي الموقع بلا سائق متاح — أقربها ${nearest.nameAr} (${nearest.distanceKm.toFixed(1)}كم)`,
      });
      await this.prisma.orderStatusHistory.create({
        data: {
          orderId,
          status: OrderStatus.WAITING_FOR_DRIVER,
          noteAr: 'جاري انتظار أقرب سائق متاح',
        },
      });
      await this.notify(
        order.customerId,
        'WAITING_FOR_DRIVER',
        'تم استلام طلبك',
        `كل السائقين مشغولون الآن — جاري انتظار أول سائق يفرغ (خلال ${Math.round(settings.maxWaitForDriverSeconds / 60)} دقيقة كحد أقصى)`,
        { orderId },
      );
      this.gateway.emitOrderStatus(
        orderId,
        order.customerId,
        OrderStatus.WAITING_FOR_DRIVER,
        'جاري انتظار أقرب سائق متاح',
      );
      await this.queue.scheduleWaitJobs(
        orderId,
        settings.waitRetryIntervalSeconds * 1000,
        until.getTime() - now.getTime(),
      );
      this.logger.log(
        `الطلب ${order.code} دخل الانتظار حتى ${until.toISOString()} (${waiting.length} وكالة مرشحة)`,
      );
    }

    return {
      status: OrderStatus.WAITING_FOR_DRIVER,
      orderId,
      waitingUntil: until,
      agencies: waiting.length,
    };
  }

  /**
   * محاولة إخراج الطلب من الطابور. الانتقال WAITING → SEARCHING ذرّي
   * (updateMany بشرط الحالة) فلا يستأنفه محرّكان معاً عندما تتزامن تكة
   * دورية مع سائق أصبح متاحاً.
   */
  private async resumeWaiting(orderId: string, reason?: string) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.WAITING_FOR_DRIVER },
      data: { status: OrderStatus.SEARCHING },
    });
    if (count === 0) return;
    if (reason) {
      await this.history(orderId, AssignmentAction.WAITING_RESUMED, { reason });
    }
    return this.selectNextAgency(orderId);
  }

  /** تكة دورية أثناء الانتظار: قد تفتح وكالة أو تشحن رصيدها أو يعود سائق */
  async handleWaitRetry(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.WAITING_FOR_DRIVER) return;
    // تكة وصلت بعد السقف تُنهي الطلب بنفسها بدل انتظار مهمة قد تكون ضاعت
    if (order.waitingUntil && order.waitingUntil.getTime() <= Date.now()) {
      return this.handleWaitTimeout(orderId);
    }
    // بلا تسجيل: التكة تتكرر عشرات المرات ولا قيمة لها في سجل الطلب إلا
    // حين تنجح — ونجاحها يُسجَّل أصلاً بـ AGENCY_SELECTED
    await this.resumeWaiting(orderId);
  }

  /** انقضى سقف الانتظار — إلغاء تلقائي مع اعتذار (لا خصم: الدفع كاش) */
  async handleWaitTimeout(orderId: string) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.WAITING_FOR_DRIVER },
      data: {
        status: OrderStatus.CANCELLED,
        cancelReason: 'إلغاء تلقائي: تعذر توفير سائق خلال المهلة',
      },
    });
    if (count === 0) return;
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // تعذّر توفير سائق ليس ذنب الزبون — كوبونه يعود إليه كاملاً
    await this.coupons.releaseForOrder(orderId);
    await this.history(orderId, AssignmentAction.WAITING_TIMEOUT, {
      reason: 'انقضى سقف الانتظار دون سائق متاح',
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.CANCELLED,
        noteAr: 'تعذر توفير سائق في الوقت الحالي',
      },
    });
    await this.notify(
      order.customerId,
      'ORDER_CANCELLED',
      'تم إلغاء طلبك',
      'تعذر توفير سائق في الوقت الحالي — أُلغي الطلب تلقائياً ولم يُخصم أي مبلغ. نعتذر عن الإزعاج.',
      { orderId },
    );
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.CANCELLED,
      'تعذر توفير سائق — أُلغي الطلب تلقائياً',
    );
    // تذكرة تكشف لفريق العمليات مناطق الطلب المفقود (نقص سائقين لا نقص تغطية)
    await this.prisma.supportTicket.create({
      data: {
        code: `TKT-${Math.floor(100000 + Math.random() * 900000)}`,
        type: 'NO_DRIVER_AVAILABLE',
        priority: 'HIGH',
        subjectAr: `طلب ${order.code} أُلغي تلقائياً — لا سائق متاح خلال مهلة الانتظار`,
        orderId,
      },
    });
    this.logger.warn(`الطلب ${order.code} أُلغي تلقائياً بعد استنفاد مهلة الانتظار`);
    return { status: OrderStatus.CANCELLED, orderId };
  }

  /**
   * سائق أصبح متاحاً (اتصل أو أنهى طلباً) — نستأنف أقدم الطلبات المنتظرة
   * التي يصلها نطاق أحد فروع وكالته. الطابور FIFO، ونتوقف فور حصول السائق
   * على عرض معلق حتى لا يستقبل عرضين معاً.
   */
  async onDriverAvailable(driverId: string) {
    try {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { userId: driverId },
      });
      if (!profile || !profile.isVerified || profile.status !== DriverStatus.AVAILABLE) {
        return;
      }
      const waitingOrders = await this.prisma.$queryRaw<
        { id: string; expired: boolean }[]
      >`
        SELECT o.id, (o."waitingUntil" IS NULL OR o."waitingUntil" <= NOW()) AS expired
        FROM "Order" o
        WHERE o.status = 'WAITING_FOR_DRIVER'
          AND EXISTS (
            SELECT 1 FROM "AgencyBranch" b
            WHERE b."agencyId" = ${profile.agencyId}
              AND b.active = true
              AND ST_DWithin(
                    ST_MakePoint(b.lng, b.lat)::geography,
                    ST_MakePoint(o."deliveryLng", o."deliveryLat")::geography,
                    b."deliveryRadiusKm" * 1000.0
                  )
          )
        ORDER BY o."waitingSince" ASC
        LIMIT 5
      `;
      for (const o of waitingOrders) {
        // طلبٌ انقضى سقف انتظاره لا يُبعث إلى سائق. مهلة الإلغاء تُجدول في
        // الطابور، وقد لا تصل: إعادة تشغيل Redis تبتلع المهام المؤجّلة،
        // فيبقى الطلب في WAITING_FOR_DRIVER بلا نهاية — ثم يفرغ سائق بعد
        // ساعات فيصله طلبٌ نسيه صاحبه، ويُقرع باب زبون لم يعد ينتظر شيئاً.
        // نُنهيه هنا كما كانت المهلة ستفعل: الوصول إلى الطلب هو فرصة
        // تصحيحه، لا فرصة إحيائه.
        if (o.expired) {
          await this.handleWaitTimeout(o.id);
          continue;
        }
        const busy = await this.prisma.driverOffer.count({
          where: { driverId, status: 'PENDING', expiresAt: { gt: new Date() } },
        });
        if (busy > 0) break;
        await this.resumeWaiting(o.id, `سائق أصبح متاحاً لدى وكالة تغطي الموقع`);
      }
    } catch (e) {
      // لا يُفشل استدعاءه (تحديث حالة السائق / إنهاء طلب) — يبقى للتكة الدورية
      this.logger.error(`فشل استئناف طلبات الانتظار للسائق ${driverId}: ${e}`);
    }
  }

  // ============================================================
  // إنقاذ يدوي من فريق العمليات
  // ============================================================

  /** الحالات التي يجوز لفريق العمليات إنقاذها — الطلب عالق ولا أحد ملتزم به */
  private static readonly RESCUABLE: OrderStatus[] = [
    OrderStatus.SEARCH_FAILED,
    OrderStatus.WAITING_FOR_DRIVER,
    OrderStatus.AGENCY_ASSIGNED,
    OrderStatus.SEARCHING,
  ];

  /**
   * كل ما يحتاجه موظف العمليات ليقرّر في طلب عالق: من يغطي الموقع، ولماذا
   * استُبعد كلٌّ منهم، ومن عنده سائق أين.
   *
   * تشمل عمداً وكالات **خارج** نطاق توصيلها المعلن، مرتّبةً بالأقرب: الطلب
   * الذي وصل SEARCH_FAILED غالباً لا تغطيه وكالة أصلاً، فقائمة «المؤهلين»
   * وحدها تكون فارغة ولا تعين على شيء. القرار هنا بشري، فمهمة الشاشة أن
   * تعرض الحقيقة كاملة — بما فيها ما يُتجاوَز — لا أن تقرّر بدله.
   */
  async rescueOptions(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { select: { bottleTypeId: true, qty: true } } },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    const settings = await this.settings();
    const neededTypes = [...new Set(order.items.map((i) => i.bottleTypeId))];
    const minBalance = Number(settings.minBalanceForDispatch);

    // أقرب فرع لكل وكالة، داخل النطاق أو خارجه — مع المسافة والفارق
    const rows = await this.prisma.$queryRaw<
      {
        agencyId: string;
        branchId: string;
        branchName: string;
        distanceKm: number;
        radiusKm: number;
        inRange: boolean;
      }[]
    >`
      SELECT DISTINCT ON (b."agencyId")
             b."agencyId", b.id AS "branchId", b."nameAr" AS "branchName",
             ST_Distance(ST_MakePoint(b.lng, b.lat)::geography,
                         ST_MakePoint(${order.deliveryLng}, ${order.deliveryLat})::geography) / 1000.0 AS "distanceKm",
             b."deliveryRadiusKm" AS "radiusKm",
             ST_DWithin(ST_MakePoint(b.lng, b.lat)::geography,
                        ST_MakePoint(${order.deliveryLng}, ${order.deliveryLat})::geography,
                        b."deliveryRadiusKm" * 1000.0) AS "inRange"
      FROM "AgencyBranch" b
      WHERE b.active = true
      ORDER BY b."agencyId", "distanceKm"
    `;
    const nearest = rows.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 12);

    const agencies = await this.prisma.agency.findMany({
      where: { id: { in: nearest.map((r) => r.agencyId) } },
      include: {
        holidays: { where: { date: this.todayDate() } },
        wallet: true,
        availability: true,
        drivers: {
          include: { user: { select: { name: true, phone: true } } },
        },
      },
    });
    const byId = new Map(agencies.map((a) => [a.id, a]));

    // من عُرض عليه هذا الطلب سابقاً — يُقال ذلك ولا يُمنع: التوزيع التلقائي
    // لا يكرر العرض (وهو محق: من تجاهله مرة قد يتجاهله ثانية)، لكن فريق
    // العمليات يرى ما لا يراه المحرك — سائق انتهت مهلته وهو يقود، أو رفض
    // لسبب زال. المنع كان يترك طلباً عالقاً وسائقاً جاهزاً لا يُعرض عليه.
    const offered = new Map(
      (
        await this.prisma.driverOffer.findMany({
          where: { orderId },
          select: { driverId: true, status: true },
        })
      ).map((o) => [o.driverId, o.status]),
    );

    const options = nearest.map((r) => {
      const a = byId.get(r.agencyId)!;
      const availableTypeIds = new Set(
        a.availability.filter((v) => v.available).map((v) => v.bottleTypeId),
      );
      const balance = Number(a.wallet?.balance ?? 0);

      // ما يمنع التوزيع التلقائي — يُعرض ليتجاوزه الموظف بعلم، لا ليخفيه
      const blockers: string[] = [];
      // المسافة معروضة في الرقاقة فوق البطاقة — هنا يكفي نطاقها المعلن
      if (!r.inRange) blockers.push(`نطاق توصيلها ${r.radiusKm}كم فقط`);
      if (a.status !== 'ACTIVE') blockers.push(`الوكالة ${a.status}`);
      if (a.holidays.length > 0) blockers.push('الوكالة في إجازة اليوم');
      const missing = neededTypes.filter((t) => !availableTypeIds.has(t));
      if (missing.length > 0) blockers.push('لا يتوفر مخزون لأصناف الطلب');
      if (balance <= 0 || balance < minBalance) {
        blockers.push(`رصيد المحفظة ${balance.toFixed(2)} غير كافٍ`);
      }

      const drivers = a.drivers.map((d) => ({
        userId: d.userId,
        name: d.user.name,
        phone: d.user.phone,
        status: d.status,
        isVerified: d.isVerified,
        rating: d.rating,
        distanceKm:
          d.currentLat != null && d.currentLng != null
            ? Math.round(
                haversineKm(d.currentLat, d.currentLng, order.deliveryLat, order.deliveryLng) * 10,
              ) / 10
            : null,
        previousOffer: offered.get(d.userId) ?? null,
        // من يصلح لعرض فوري: متاح وموثّق. سبق عرضه لا يمنع إعادة العرض
        offerable: d.status === 'AVAILABLE' && d.isVerified,
      }));
      drivers.sort((x, y) => {
        if (x.offerable !== y.offerable) return x.offerable ? -1 : 1;
        // من لم يُعرض عليه بعد أولاً — إعادة العرض خيار واعٍ لا افتراضي
        const seen = (d: { previousOffer: string | null }) => (d.previousOffer ? 1 : 0);
        if (seen(x) !== seen(y)) return seen(x) - seen(y);
        return (x.distanceKm ?? 999) - (y.distanceKm ?? 999);
      });

      return {
        agencyId: a.id,
        nameAr: a.nameAr,
        phone: a.phone,
        branchId: r.branchId,
        branchName: r.branchName,
        distanceKm: Math.round(r.distanceKm * 10) / 10,
        inRange: r.inRange,
        walletBalance: balance,
        autoDispatch: a.autoDispatch,
        rating: a.rating,
        blockers,
        eligible: blockers.length === 0,
        availableDrivers: drivers.filter((d) => d.offerable).length,
        drivers,
      };
    });

    return {
      order: {
        id: order.id,
        code: order.code,
        status: order.status,
        addressText: order.addressText,
        total: Number(order.total),
        createdAt: order.createdAt,
      },
      canRescue: DispatchService.RESCUABLE.includes(order.status),
      options,
    };
  }

  /**
   * إسناد يدوي من فريق العمليات لطلب عالق — يتجاوز شروط الأهلية عمداً.
   *
   * التوزيع التلقائي يستبعد وكالةً لسبب وجيه (رصيد، مخزون، نطاق)، لكن الطلب
   * العالق كلفته على الزبون أعلى من كلفة التجاوز، والموظف يرى الأسباب في
   * `rescueOptions` قبل أن يقرّر. ما يُتجاوَز يُسجَّل في سبب الإسناد حتى
   * يُقرأ لاحقاً لماذا خرج هذا الطلب عن القاعدة.
   *
   * بلا سائق محدَّد: توزيع تلقائي فوري داخل الوكالة المختارة (نفس منطق
   * offerToNextDriver) — لا تنتظر تعييناً يدوياً منها. إن استُنفد سائقوها
   * فالطلب يُعامَل كفشل وكالة عادي وينتقل تلقائياً للوكالة التالية، تماماً
   * كما يحدث في التوزيع الأولي.
   */
  async rescueAssign(
    orderId: string,
    agencyId: string,
    driverId: string | undefined,
    actorUserId: string,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (!DispatchService.RESCUABLE.includes(order.status)) {
      throw new BadRequestException(
        `الطلب في حالة ${order.status} — الإسناد اليدوي للطلبات العالقة فقط`,
      );
    }
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      include: { branches: { where: { active: true } } },
    });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    if (agency.branches.length === 0) {
      throw new BadRequestException('الوكالة بلا فرع نشط');
    }
    // أقرب فروعها للزبون يمثّلها، كما يفعل الترشيح التلقائي
    const inRange = await this.branchesInRange(order.deliveryLat, order.deliveryLng);
    const branchId =
      inRange.find((b) => b.agencyId === agencyId)?.branchId ??
      agency.branches[0].id;

    const pending = await this.prisma.driverOffer.findFirst({
      where: { orderId, status: 'PENDING', expiresAt: { gt: new Date() } },
    });
    if (pending) {
      throw new BadRequestException('يوجد عرض معلق لهذا الطلب — انتظر انتهاءه');
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.AGENCY_ASSIGNED,
        agencyId,
        branchId,
        agencyAssignedAt: new Date(),
        // خروج من طابور الانتظار إن كان فيه: مؤقتاته تصبح بلا معنى
        waitingSince: null,
        waitingUntil: null,
      },
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.AGENCY_ASSIGNED,
        actorUserId,
        noteAr: `أسندها فريق العمليات إلى ${agency.nameAr}`,
      },
    });
    await this.history(orderId, AssignmentAction.MANUAL_ASSIGNED, {
      agencyId,
      driverId,
      reason: `إسناد من فريق العمليات (كانت ${order.status})`,
    });

    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.AGENCY_ASSIGNED,
      'فريق العمليات يتابع طلبك — جاري تعيين سائق',
      agencyId,
    );
    await this.notify(
      order.customerId,
      'ORDER_NEEDS_ASSIGNMENT',
      'تابعنا طلبك',
      `أسندنا طلبك ${order.code} إلى ${agency.nameAr} — سيصلك السائق قريباً`,
      { orderId },
    );

    // سائق بعينه: عرض مباشر. بلا سائق: توزيع تلقائي فوري على أفضل سائق متاح —
    // الطلب المُنقَذ لا ينتظر تعييناً يدوياً من الوكالة (بصرف النظر عن autoDispatch).
    if (driverId) {
      const offer = await this.manualOffer(orderId, agencyId, driverId, actorUserId);
      return { ok: true as const, agencyId, branchId, offerId: offer.id };
    }
    const result = await this.offerToNextDriver(orderId, agencyId);
    const offerId =
      result && typeof result === 'object' && 'id' in result
        ? (result as { id: string }).id
        : null;
    return { ok: true as const, agencyId, branchId, offerId };
  }

  /** إبلاغ الوكالة بطلب بلا إسناده — تنبيه قبل القرار */
  async notifyAgencyOfOrder(orderId: string, agencyId: string, bodyAr?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');

    const staff = await agencyStaffIds(this.prisma, agencyId);
    await this.notifications.sendMany(
      staff,
      'ORDER_NEEDS_ASSIGNMENT',
      'طلب يحتاج تدخلكم',
      bodyAr ?? `الطلب ${order.code} في منطقتكم ولم يجد سائقاً — هل تستطيعون خدمته؟`,
      { orderId },
    );
    this.gateway.emitToAgency(agencyId, 'order:needs-assignment', {
      orderId,
      code: order.code,
      addressText: order.addressText,
      total: Number(order.total),
    });
    return { ok: true as const, notified: staff.length };
  }

  // ============================================================
  // مسارات الفشل
  // ============================================================

  /** أسباب اعتذار الوكالة — قائمة مغلقة ليُعدّ عليها لا نصّ حر */
  static readonly DECLINE_REASONS: Record<string, string> = {
    STOCK_UNAVAILABLE: 'الصنف المطلوب غير متوفر لدينا',
    NO_DRIVER: 'لا سائق متاح لدينا الآن',
    OUT_OF_ZONE: 'الموقع خارج نطاق خدمتنا',
    TOO_BUSY: 'ضغط طلبات — لا نستطيع خدمته الآن',
    OTHER: 'سبب آخر',
  };

  /**
   * اعتذار الوكالة عن طلب أُسند إليها — ينقله إلى الوكالة التالية فوراً.
   *
   * الترشيح يفحص المخزون لحظة الاختيار، لكن الواقع يتغيّر بعده: الصنف ينفد
   * قبل أن يُعيَّن سائق، أو تعرف الوكالة أنها لا تستطيع. كان الطلب ينتظر
   * انقضاء مهلة التعيين اليدوي كاملةً ليُنقل، والزبون ينتظر معه بلا سبب —
   * فصار للوكالة أن تقول ذلك فوراً.
   *
   * السبب يُكتب في سجل الإسناد: وكالة تعتذر كل يوم بحجة نفاد المخزون تُقرأ
   * في التقارير.
   */
  async agencyDecline(
    orderId: string,
    agencyId: string,
    reasonCode: string,
    actorUserId: string,
    note?: string,
  ) {
    const reasonAr = DispatchService.DECLINE_REASONS[reasonCode];
    if (!reasonAr) throw new BadRequestException('سبب الاعتذار غير صالح');
    const trimmed = note?.trim();
    if (reasonCode === 'OTHER' && (trimmed?.length ?? 0) < 5) {
      throw new BadRequestException('اكتب سبب الاعتذار');
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, agencyId, status: OrderStatus.AGENCY_ASSIGNED },
    });
    if (!order) {
      throw new BadRequestException('الطلب لم يعد لدى وكالتكم (نُقل أو عُيّن سائقه)');
    }
    // عرض معلّق يعني سائقاً ينظر إلى الورقة الآن — لا نسحب الطلب من تحته
    const pending = await this.prisma.driverOffer.findFirst({
      where: { orderId, status: 'PENDING', expiresAt: { gt: new Date() } },
    });
    if (pending) {
      throw new BadRequestException('يوجد عرض معلق على سائق — انتظر انتهاء مهلته');
    }

    const full = trimmed ? `${reasonAr} — ${trimmed}` : reasonAr;
    await this.history(orderId, AssignmentAction.AGENCY_SKIPPED, {
      agencyId,
      reason: `اعتذرت الوكالة: ${full}`,
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.SEARCHING,
        actorUserId,
        noteAr: `اعتذرت الوكالة عن الطلب: ${full}`,
      },
    });
    // الزبون لا يُترك في صمت: حالته ستتغير أمامه، وسببها ليس عطلاً
    await this.notify(
      order.customerId,
      'ORDER_NEEDS_ASSIGNMENT',
      'نبحث لك عن وكالة أخرى',
      `تعذّر على الوكالة خدمة طلبك ${order.code} (${reasonAr}) — نبحث لك عن وكالة أخرى الآن.`,
      { orderId },
    );
    return this.agencyFailed(orderId, agencyId, `اعتذرت الوكالة: ${full}`);
  }

  private async agencyFailed(orderId: string, agencyId: string, reason: string) {
    await this.history(orderId, AssignmentAction.AGENCY_FAILED, { agencyId, reason });
    await this.history(orderId, AssignmentAction.RETRY_STARTED, {
      reason: 'الانتقال للوكالة التالية',
    });
    // فك ارتباط الوكالة الفاشلة والعودة للبحث
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.SEARCHING, agencyId: null, branchId: null },
    });
    return this.selectNextAgency(orderId);
  }

  /**
   * مَن عُرض عليه الطلب ولم يأخذه، ووكالة كلٍّ منهم ورقمها — ما يحتاجه من
   * سيتصرف على تنبيه الفشل ليرفع السماعة فوراً.
   *
   * الطلب نفسه لا يحمل شيئاً من هذا: driverId لم يُسنَد قط (لا أحد قَبِل)،
   * وagencyId يُفرَّغ لحظة الفشل. جدول العروض هو المصدر الوحيد.
   */
  private async attemptedDriversText(orderId: string): Promise<string> {
    const offers = await this.prisma.driverOffer.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      include: {
        driver: { select: { name: true, phone: true } },
        agency: { select: { nameAr: true, phone: true } },
      },
    });
    if (offers.length === 0) {
      return 'لم يصل الطلب إلى أي سائق — لم تُرشَّح وكالة مؤهلة أصلاً';
    }
    const outcomeAr: Record<string, string> = {
      PENDING: 'لم يرد',
      REJECTED: 'رفض',
      EXPIRED: 'انتهت المهلة دون رد',
      ACCEPTED: 'قبل',
    };
    return offers
      .map(
        (o, i) =>
          `${i + 1}) السائق: ${o.driver.name} — ${o.driver.phone ?? 'بلا رقم'}\n` +
          `   الوكالة: ${o.agency.nameAr} — ${o.agency.phone ?? 'بلا رقم'}\n` +
          `   النتيجة: ${outcomeAr[o.status] ?? o.status}`,
      )
      .join('\n');
  }

  /**
   * أين الطلب بالضبط — لمن سيتصرف على التنبيه من هاتفه.
   *
   * ثلاثة مستويات لأن كلاً منها يجيب سؤالاً مختلفاً: اسم المنطقة يقول «أي
   * حي» فيعرف من يغطيه، والعنوان المكتوب يقول «وين بالظبط» للسائق، والرابط
   * يفتح الخريطة بضغطة بدل نسخ إحداثيات يدوياً.
   *
   * أسماء المواقع وصفية لا تُبنى عليها التغطية (انظر resolveLocation) —
   * فغيابها لا يمنع شيئاً، ويظهر السطر بما توفّر.
   */
  private async orderLocationText(order: {
    addressText: string;
    deliveryLat: number;
    deliveryLng: number;
  }): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ nameAr: string; level: string }[]>`
      WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(${order.deliveryLng}, ${order.deliveryLat}), 4326) AS g)
      (SELECT n."nameAr", 'neighborhood' AS level
       FROM "Neighborhood" n JOIN "District" d ON d.id = n."districtId", pt
       WHERE n.active AND d.active AND n.geom IS NOT NULL AND ST_Contains(n.geom, pt.g) LIMIT 1)
      UNION ALL
      (SELECT z."nameAr", 'zone' FROM "Zone" z, pt
       WHERE z.active AND ST_Contains(z.geom, pt.g) LIMIT 1)
      UNION ALL
      (SELECT d."nameAr", 'district' FROM "District" d, pt
       WHERE d.active AND d.geom IS NOT NULL AND ST_Contains(d.geom, pt.g) LIMIT 1)
    `;
    const pick = (l: string) => rows.find((r) => r.level === l)?.nameAr;
    const area = pick('neighborhood') ?? pick('zone') ?? pick('district');
    const lat = order.deliveryLat.toFixed(6);
    const lng = order.deliveryLng.toFixed(6);
    return (
      `\u{1F4CD} المنطقة: ${area ?? 'غير محدَّدة'}\n` +
      `\u{1F3E0} العنوان: ${order.addressText}\n` +
      `\u{1F5FA} https://maps.google.com/?q=${lat},${lng}`
    );
  }

  /** القرار 5: لا إلغاء تلقائي — إشعار الزبون + تذكرة Operations */
  private async searchFailed(orderId: string, reason: string) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.SEARCH_FAILED, agencyId: null, branchId: null },
    });
    await this.history(orderId, AssignmentAction.SEARCH_FAILED, { reason });
    await this.prisma.orderStatusHistory.create({
      data: { orderId, status: OrderStatus.SEARCH_FAILED, noteAr: reason },
    });
    await this.prisma.supportTicket.create({
      data: {
        code: `TKT-${Math.floor(100000 + Math.random() * 900000)}`,
        type: 'SEARCH_FAILED',
        priority: 'HIGH',
        subjectAr: `فشل توزيع الطلب ${order.code} — ${reason}`,
        orderId,
      },
    });
    await this.notify(
      order.customerId,
      'SEARCH_FAILED',
      'نعتذر — لم نجد سائقاً متاحاً',
      'فريق العمليات يتابع طلبك وسيتواصل معك خلال دقائق',
      { orderId },
    );
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.SEARCH_FAILED,
      'فريق العمليات يتابع طلبك',
    );
    const attempted = await this.attemptedDriversText(orderId);
    const where = await this.orderLocationText(order);
    // صاحب الطلب في نص التنبيه: التنبيه يُقرأ ليُتصرَّف، وأول تصرّف هو
    // الاتصال بالزبون. كان اسمه ورقمه يستلزمان فتح اللوحة والبحث بالرمز —
    // خطوتان بين من يقرأ ومن ينتظر مكالمة.
    const customer = await this.prisma.user.findUnique({
      where: { id: order.customerId },
      select: { name: true, phone: true },
    });
    void this.telegram.send(
      `⚠️ أعطال — تنبيه النظام\n` +
        `فشل إرسال الطلب إلى السائق\n` +
        `Order ID: #${order.code}\n` +
        `السبب: ${reason}\n\n` +
        `\u{1F464} الزبون: ${customer?.name ?? '—'}\n` +
        `\u{1F4DE} الهاتف: ${customer?.phone ?? '—'}\n` +
        `${where}\n\n` +
        `عُرض على:\n${attempted}`,
    );
    this.logger.warn(`SEARCH_FAILED للطلب ${order.code}: ${reason}`);
    return { status: OrderStatus.SEARCH_FAILED, reason };
  }
}
