import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppTarget, AssignmentAction, OrderStatus, Prisma, DeviceApp} from '@prisma-v2/client';
import type Redis from 'ioredis';
import { agencyStaffIds } from '../common/agency-staff.util';
import { containsProfanity } from '../common/profanity.util';
import { recordRateLimitViolation } from '../common/rate-limit.util';
import { CouponsService } from '../coupons/coupons.service';
import { PrismaV2Service } from '../database/prisma-v2.service';
import {
  ammanNow,
  describeOpensIn,
  isWithinWorkingHours,
  nextOpeningAt,
} from '../common/working-hours.util';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../notifications/telegram.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { estimateEta } from '../dispatch/eta.util';
import { haversineKm } from '../dispatch/geo.util';
import { LedgerService } from '../finance/ledger.service';
import { REDIS } from '../redis/redis.module';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';

export interface CreateOrderV2Input {
  customerId: string;
  addressId: string;
  items: { bottleTypeId: string; qty: number }[];
  notes?: string;
  /** تأكيد صريح لإلغاء هذا الطلب النشط تحديداً واستبداله بالطلب الجديد */
  cancelActiveOrderId?: string;
  /** الإجمالي كما عُرض للزبون — للتحقق لا للحساب (انظر create) */
  expectedTotal?: number;
  /** رمز كوبون الخصم إن أدخله الزبون — يُتحقق منه هنا لا في التطبيق */
  couponCode?: string;
  ip?: string;
}

/**
 * الطلب لسا بلا التزام خارجي (لا وكالة ولا سائق) — يقبل استبداله بطلب جديد.
 *
 * SEARCH_FAILED منها: طلبٌ لم تقبله وكالة ولا سائق، وفريق العمليات يتابعه.
 * كان غائباً عن القائمتين معاً، فلا يُرى أصلاً عند إنشاء طلب جديد: يخرج
 * الزبون بطلبين، القديم عالق بتذكرة مفتوحة والجديد يمضي — ولو وصل سائقٌ
 * للقديم بعدها لطُرق بابه مرتين لطلب واحد. الآن يراه الخادم ويسأل قبل أن
 * يمضي: «عندك طلب سابق — المتابعة رح تلغيه. متابعة؟»
 */
const CUSTOMER_CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.SEARCHING,
  OrderStatus.WAITING_FOR_DRIVER,
  OrderStatus.SEARCH_FAILED,
];
/** نشط من منظور الزبون — طلب واحد فعّال بحد أقصى لكل زبون */
const CUSTOMER_ACTIVE_STATUSES: OrderStatus[] = [
  ...CUSTOMER_CANCELLABLE_STATUSES,
  OrderStatus.AGENCY_ASSIGNED,
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PICKED_UP,
  OrderStatus.DELIVERING,
];

/**
 * الطلب بيد السائق ولم يُسلَّم بعد — هذه وحدها نافذة انسحابه. بعد COMPLETED
 * انتهى الطلب فلا شيء يُلغى، وقبل DRIVER_ASSIGNED لم يلتزم به أصلاً (عنده
 * رفض العرض).
 */
const DRIVER_CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PICKED_UP,
  OrderStatus.DELIVERING,
];

/**
 * أسباب انسحاب السائق — قائمة مغلقة لا نصّ حر وحده: الوكالة تحتاج سبباً
 * تتصرف عليه في ثوانٍ، والتقارير تحتاج تصنيفاً يُعدّ. الملاحظة الحرة تبقى
 * إضافة اختيارية فوقه (إلزامية مع "سبب آخر" وحده).
 */
export const DRIVER_CANCEL_REASONS = {
  VEHICLE_BREAKDOWN: 'عطل في المركبة',
  ACCIDENT_OR_EMERGENCY: 'حادث أو ظرف طارئ',
  CUSTOMER_UNREACHABLE: 'الزبون لا يرد',
  CUSTOMER_REQUESTED_CANCEL: 'الزبون طلب إلغاء الطلب',
  ADDRESS_UNREACHABLE: 'تعذّر الوصول إلى الموقع',
  STOCK_UNAVAILABLE: 'القوارير غير متوفرة في المستودع',
  OTHER: 'سبب آخر',
} as const;

export type DriverCancelReason = keyof typeof DRIVER_CANCEL_REASONS;

/**
 * انسحاب السائق لا يُلغي الطلب: الزبون ما زال يريد مياهه، فيُستأنف البحث عن
 * سائق آخر تلقائياً. الاستثناء هذان السببان — كلاهما يقول إن الزبون نفسه قد
 * لا يريد الطلب أصلاً، فإرسال سائق آخر إليه بلا سؤال يكرّر الرحلة الفاشلة.
 * هنا يُوقَف الطلب ويُسأل صاحبه.
 */
const CUSTOMER_SIDE_CANCEL_REASONS: DriverCancelReason[] = [
  'CUSTOMER_UNREACHABLE',
  'CUSTOMER_REQUESTED_CANCEL',
];

/**
 * مهلة رد الزبون على سؤال «نبحث عن سائق آخر؟» — بعدها يُلغى الطلب تلقائياً.
 * سخية عمداً: السبب الغالب لعدم الرد هو أن الزبون بعيد عن هاتفه، وهو نفسه
 * سبب انسحاب السائق.
 */
const REDISPATCH_DECISION_TIMEOUT_SECONDS = 15 * 60;

// سقف إنشاء الطلبات: كل طلب يستدعي محرك التوزيع فوراً (create يتبعه
// dispatchOrder دائماً) — بلا حد، نقر متكرر أو سكربت يغرق التوزيع والخادم
// بعشرات الطلبات بثوانٍ. سخي عمداً لأن محاولة استبدال طلب نشط (409 ثم إعادة
// إرسال بتأكيد) تستهلك محاولتين لطلب واحد فعلي.
const MAX_ORDER_CREATE_ATTEMPTS = 5;
const ORDER_CREATE_WINDOW_SECONDS = 10 * 60;

// سقف العناوين المحفوظة لكل زبون — قائمة قصيرة يسهل التصفح منها عند
// الطلب، بلا تراكم عشوائي. وسقف إضافة منفصل يمنع إغراق الخادم بنقر متكرر
// أو سكربت حتى لو حذف الزبون وأعاد الإضافة للدوران حول سقف العدد.
const MAX_ADDRESSES_PER_CUSTOMER = 5;
const MAX_ADDRESS_CREATE_ATTEMPTS = 10;
const ADDRESS_CREATE_WINDOW_SECONDS = 60 * 60;

// سقف فحص التغطية — المسار الوحيد المفتوح بلا دخول الذي يأخذ إحداثيات من
// الطالب ويشغّل استعلام PostGIS مكانياً. الهوية الوحيدة المتاحة هي الـIP،
// وهو خلف وسيط Railway مشترك بين الزبائن كلهم — فالسقف سخيّ عمداً: زبون
// واحد يحرّك الدبوس على الخريطة يستهلك عشرات الفحوص في دقائق، والغرض هنا
// كبح إغراق آلي لا تضييق على استعمال حقيقي.
const MAX_COVERAGE_CHECK_ATTEMPTS = 600;
const COVERAGE_CHECK_WINDOW_SECONDS = 5 * 60;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * إنشاء الطلب فقط — التوزيع مسؤولية DispatchService المستقلة.
 * العمولة تُترك 0 عند الإنشاء وتُثبَّت لحظة قبول السائق، لأن الوكالة
 * (وبالتالي نسبتها) غير معروفة قبل انتهاء التوزيع.
 */
/**
 * بيانات الزبون التي يحتاجها السائق ليطرق الباب الصحيح: اسم ينادي به، ورقم
 * يتصل عليه إن تاه. لا بريد ولا معرّف ولا أي حقل آخر من جدول المستخدمين —
 * `select` هنا صريح عمداً حتى لا يتسرب حقل جديد للسائق لمجرد إضافته للنموذج.
 */
const CUSTOMER_CONTACT = { select: { name: true, phone: true } } as const;

/**
 * رقم الزبون بيد السائق ما دام التوصيل قائماً — به يجده حين يتوه أمام العمارة.
 * بعد COMPLETED ينتهي هذا السبب، فيُسقط الرقم ويبقى الاسم وحده: السجل يحتاج
 * ما يميّز الرحلة، لا دفتر أرقام يتراكم مع كل توصيلة.
 *
 * يُطبَّق على السائق وحده. الزبون يرى بياناته هو، فلا شيء يُحجب عنه.
 */
export function hideCustomerPhoneFromDriver<
  T extends {
    status: OrderStatus;
    customerId: string;
    driverId: string | null;
    customer: { name: string; phone: string | null };
  },
>(order: T, viewerId: string): T {
  const viewerIsDriver =
    order.driverId === viewerId && order.customerId !== viewerId;
  if (!viewerIsDriver || order.status !== OrderStatus.COMPLETED) return order;
  return { ...order, customer: { ...order.customer, phone: null } };
}

const ORDER_INCLUDE = {
  items: { include: { bottleType: true } },
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
  agency: { select: { id: true, nameAr: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true, driverProfile: true } },
  // من يصل إليه هذا الكائن محكوم أصلاً: getForUser لا تُرجعه إلا لصاحب الطلب
  // أو للسائق المُسنَد إليه، وdriverUpdateStatus تبحث بـ driverId.
  customer: CUSTOMER_CONTACT,
} satisfies Prisma.OrderInclude;

// دورة حياة التوصيل بعد التعيين (التوزيع نفسه مسؤولية DispatchService)
const DRIVER_FLOW: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.DRIVER_ASSIGNED]: [OrderStatus.PICKED_UP],
  [OrderStatus.PICKED_UP]: [OrderStatus.DELIVERING],
  [OrderStatus.DELIVERING]: [OrderStatus.COMPLETED],
};

const STATUS_NOTES: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.PICKED_UP]: 'استلم السائق القوارير من المستودع',
  [OrderStatus.DELIVERING]: 'السائق في الطريق إليك',
  [OrderStatus.COMPLETED]: 'تم التوصيل بنجاح',
};

@Injectable()
export class OrdersV2Service {
  constructor(
    private prisma: PrismaV2Service,
    private gateway: TrackingV2Gateway,
    private ledger: LedgerService,
    private dispatch: DispatchService,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    private coupons: CouponsService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  /**
   * رقم الطلب: متتالية PostgreSQL (`order_code_seq`) لا صفّ عدّاد.
   *
   * **لماذا تغيّر:** كان `UPDATE OrderCounter … id=1` داخل معاملة الإنشاء،
   * فيُقفل الصفّ حتى نهايتها — شاملةً استعلام PostGIS وتعيين الوكالة
   * وإدراج BullMQ. أي أن إنشاء الطلبات كان **متسلسلاً عالمياً**: سقفه
   * ≈ 1÷مدة المعاملة مهما بلغ عدد حاويات API. قياس DigitalOcean التقط
   * ذلك حيّاً — `Lock | transactionid` بانتظار يبلغ تسع ثوانٍ، وانهيار
   * إنشاء الطلبات إلى 3.8% عند ألف مستخدم متزامن بينما القاعدة تستعمل
   * 28 اتصالاً من مئة (أي أن العتاد لم يكن الاختناق أصلاً).
   *
   * `nextval()` لا يأخذ قفل صفّ ولا ينتظر معاملة أخرى: كل جلسة تحجز
   * رقمها فوراً وتمضي.
   *
   * **الثمن المقبول — ثقوب في التسلسل:** `nextval()` لا يتراجع مع
   * المعاملة، فالطلب الفاشل يترك فجوة (JOR-00007 ثم JOR-00009). هذه
   * مقايضة مقصودة لا سهو: التسلسل المتّصل تماماً يتطلب بالضبط القفلَ
   * الذي نزيله. الأرقام تبقى **فريدة وتصاعدية**، وهو ما يهمّ الفاتورة
   * والشكوى والبحث.
   *
   * البادئة تُقرأ من `OrderCounter` (صفّ إعداد الآن لا عدّاد ساخن) —
   * قراءةٌ لا تقفل شيئاً. وقيد `Order.code UNIQUE` يبقى الحارس الأخير:
   * حلقة إعادة المحاولة على P2002 حول المعاملة تلتقط أي تصادم نادر.
   */
  private async nextCode(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<{ n: bigint; prefix: string }[]>`
      SELECT nextval('order_code_seq') AS n,
             coalesce((SELECT prefix FROM "OrderCounter" WHERE id = 1), 'JOR') AS prefix
    `;
    return `${row.prefix}-${String(Number(row.n)).padStart(5, '0')}`;
  }

  /** بطاقات «مطوّرو التطبيق» المفعّلة — تُدار من لوحة المنصة */
  listAppDevelopers() {
    return this.prisma.appDeveloper.findMany({
      where: { active: true },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, nameAr: true, roleAr: true, url: true, avatarUrl: true },
    });
  }

  /**
   * تسمية موقع من GPS — **وصفية فقط**: عنوان مقروء وفلاتر وتقارير.
   * الأدق أولاً: حي (حدود GIS مستوردة) ← zone قديمة ← منطقة إدارية.
   * الأهلية للتوصيل لا تعتمد عليها إطلاقاً (انظر isCovered).
   */
  async resolveLocation(lat: number, lng: number): Promise<{
    level: 'neighborhood' | 'zone' | 'district';
    zoneId: string | null;
    neighborhoodId: string | null;
    districtId: string | null;
    nameAr: string;
    cityId: string;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      {
        level: string; id: string; nameAr: string; cityId: string;
        neighborhoodId: string | null; districtId: string | null;
      }[]
    >`
      WITH pt AS (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS g)
      (SELECT 'neighborhood' AS level, n.id, n."nameAr", d."cityId",
              n.id AS "neighborhoodId", d.id AS "districtId"
       FROM "Neighborhood" n
       JOIN "District" d ON d.id = n."districtId", pt
       WHERE n.active AND d.active AND n.geom IS NOT NULL AND ST_Contains(n.geom, pt.g)
       LIMIT 1)
      UNION ALL
      (SELECT 'zone', z.id, z."nameAr", z."cityId",
              z."neighborhoodId", n."districtId"
       FROM "Zone" z
       LEFT JOIN "Neighborhood" n ON n.id = z."neighborhoodId", pt
       WHERE z.active AND ST_Contains(z.geom, pt.g)
       LIMIT 1)
      UNION ALL
      (SELECT 'district', d.id, d."nameAr", d."cityId",
              NULL, d.id
       FROM "District" d, pt
       WHERE d.active AND d.geom IS NOT NULL AND ST_Contains(d.geom, pt.g)
       LIMIT 1)
    `;
    const byLevel = (l: string) => rows.find((r) => r.level === l);
    const hit = byLevel('neighborhood') ?? byLevel('zone') ?? byLevel('district');
    if (!hit) return null;
    return {
      level: hit.level as 'neighborhood' | 'zone' | 'district',
      zoneId: hit.level === 'zone' ? hit.id : null,
      neighborhoodId: hit.neighborhoodId,
      districtId: hit.districtId,
      nameAr: hit.nameAr,
      cityId: hit.cityId,
    };
  }

  /**
   * التغطية = وكالة نشطة واحدة على الأقل يقع الموقع داخل نطاق توصيلها.
   * (ST_DWithin على geography = أمتار حقيقية)
   */
  async isCovered(lat: number, lng: number): Promise<boolean> {
    return (await this.coverageStatus(lat, lng)).covered;
  }

  /**
   * حالة التغطية مفصَّلة: هل توجد وكالة تخدم الموقع، وهل هي مفتوحة الآن؟
   *
   * **التمييز بين الحالتين هو الغرض.** «لا نخدم منطقتك» و«الوكالة مغلقة
   * الآن» جوابان مختلفان تماماً للزبون: الأول نهائي فينصرف، والثاني مؤقت
   * فينتظر ساعة الفتح — وخلطهما يُفقد زبوناً كان سيطلب بعد ساعتين.
   *
   * **ويطابق ترشيح التوزيع في شرطَي الدوام والإجازة** ليُمنع الطلب الذي لن
   * تقبله وكالة، بدل أن يُنشأ ثم يبقى معلّقاً بلا وكالة. وما عداهما من
   * شروط التوزيع (الرصيد، المخزون، السائقون) لا يُفحص هنا عمداً: تلك تتقلّب
   * في دقائق وقد تتغيّر قبل أن يُنشأ الطلب، ومنعُ الزبون بها يُغلق الباب
   * على طلبٍ كان سينجح.
   */
  async coverageStatus(
    lat: number,
    lng: number,
  ): Promise<{
    covered: boolean;
    anyAgency: boolean;
    openNow: boolean;
    /// دقائق حتى أقرب فتح — null إن كانت مفتوحة أو تعذّر معرفة موعدها
    opensInMinutes: number | null;
  }> {
    const agencies = await this.prisma.$queryRaw<{ agencyId: string }[]>`
      SELECT DISTINCT b."agencyId" AS "agencyId"
      FROM "AgencyBranch" b
      JOIN "Agency" a ON a.id = b."agencyId"
      WHERE b.active = true
        AND a.status = 'ACTIVE'
        AND ST_DWithin(
              ST_MakePoint(b.lng, b.lat)::geography,
              ST_MakePoint(${lng}, ${lat})::geography,
              b."deliveryRadiusKm" * 1000.0
            )
    `;
    if (agencies.length === 0) {
      return {
        covered: false,
        anyAgency: false,
        openNow: false,
        opensInMinutes: null,
      };
    }

    // الرايةُ نفسها التي يقرؤها التوزيع: إن أطفأها الأدمن فالدوام لا يمنع
    // هناك، ولا يجوز أن يمنع هنا — وإلا مُنع الزبون من طلبٍ كان سيُقبل.
    const settings = await this.prisma.dispatchSettings.findUnique({
      where: { id: 1 },
      select: { respectWorkingHours: true },
    });
    if (settings && !settings.respectWorkingHours) {
      return {
        covered: true,
        anyAgency: true,
        openNow: true,
        opensInMinutes: null,
      };
    }

    const ids = agencies.map((a) => a.agencyId);
    const now = ammanNow();
    const rows = await this.prisma.agency.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        workingHours: { select: { dayOfWeek: true, opensAt: true, closesAt: true } },
        holidays: { where: { date: now.date }, select: { id: true } },
      },
    });

    const openNow = rows.some(
      (a) =>
        a.holidays.length === 0 &&
        // الغياب فتحٌ لا إغلاق — وكالة بلا جدول تعمل على مدار الساعة
        (a.workingHours.length === 0 ||
          isWithinWorkingHours(a.workingHours, now)),
    );

    if (openNow) {
      return { covered: true, anyAgency: true, openNow: true, opensInMinutes: null };
    }

    // **مغلقة الآن: نقول متى تفتح.** «مغلقة» وحدها تُنهي المحاولة، و«تفتح
    // بعد ساعتين» تجعل الزبون ينتظر بدل أن ينصرف. نأخذ أقرب فتحٍ بين كل
    // الوكالات المغطية — أوّلها فتحاً هي من ستخدمه.
    //
    // وكالة في إجازة اليوم تُستثنى من الحساب: جدولها يقول إنها تفتح بعد
    // ساعة، والإجازة تنقض ذلك — فوعدٌ بموعد لا يتحقّق أسوأ من لا وعد.
    let soonest: number | null = null;
    for (const a of rows) {
      if (a.holidays.length > 0 || a.workingHours.length === 0) continue;
      const next = nextOpeningAt(a.workingHours, now);
      if (next && (soonest === null || next.minutesUntil < soonest)) {
        soonest = next.minutesUntil;
      }
    }

    return {
      covered: false,
      anyAgency: true,
      openNow: false,
      opensInMinutes: soonest,
    };
  }

  /**
   * فحص تغطية موقع قبل الدخول — للزائر الذي يحدّد عنوانه وهو بلا حساب.
   *
   * الرحلة صارت تُجهَّز كاملة بلا حساب، والحساب يُطلب عند «تأكيد الطلب».
   * ولولا هذا المسار لما عرف الزائر أن موقعه خارج نطاق كل الوكالات إلا بعد
   * أن يسجّل دخوله — إحباطٌ بعد جهد، وحسابٌ أُنشئ لطلب لن يقوم.
   *
   * **لا يكشف شيئاً عن الوكالات**: يرجع نعم/لا واسم المنطقة الوصفي وحده —
   * لا مواقع فروع ولا أنصاف أقطار ولا عددها. وهو ما تعرضه `listAddresses`
   * أصلاً لكل زبون عن عنوانه.
   */
  async coverageAt(lat: number, lng: number, ip?: string) {
    await this.assertCoverageCheckQuota(ip);
    const [status, location] = await Promise.all([
      this.coverageStatus(lat, lng),
      this.resolveLocation(lat, lng),
    ]);
    return {
      inCoverage: status.covered,
      areaName: location?.nameAr ?? null,
      // يفرّق للتطبيق بين «لا نخدم منطقتك» (نهائي) و«مغلقة الآن» (مؤقت):
      // الأولى تُنهي الرحلة، والثانية تدعو للعودة لاحقاً.
      hasAgency: status.anyAgency,
      openNow: status.openNow,
      /// دقائق حتى أقرب فتح — يبنيها التطبيق نصّاً بلغته
      opensInMinutes: status.opensInMinutes,
    };
  }

  /**
   * سقف فحص التغطية بالـIP.
   *
   * يختلف عن سقوف المسارات المحمية في نقطة واحدة: **عطل Redis هنا يرفض ولا
   * يسمح.** هناك يقف خلف الطلب حسابٌ موثَّق فيُغلَّب مرور الطلب الحقيقي على
   * الحد؛ وهنا لا هوية إطلاقاً، وفتحُ مسار مكاني بلا سقف لأن الكاش متعطل هو
   * بالضبط اللحظة التي يُستغل فيها. الفحص تحسينُ تجربة لا شرطُ طلب — من
   * يُمنع منه يكمل رحلته، ويُعرف حال عنوانه عند الحفظ بعد الدخول.
   */
  private async assertCoverageCheckQuota(ip?: string) {
    const identifier = ip ?? 'unknown';
    try {
      const key = `coverage:check:${identifier}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, COVERAGE_CHECK_WINDOW_SECONDS);
      if (n > MAX_COVERAGE_CHECK_ATTEMPTS) {
        void recordRateLimitViolation(this.prisma, {
          scope: 'coverage_check', identifier, ip,
        });
        throw new ForbiddenException('محاولات كثيرة خلال وقت قصير — حاول بعد قليل');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      throw new ServiceUnavailableException(
        'تعذّر فحص التغطية الآن — تابع طلبك وسنتحقق من عنوانك عند تأكيده',
      );
    }
  }

  /** عمولة الخدمة كما تظهر للزبون قبل التأكيد */
  async serviceFee() {
    return { commissionPerOrder: await this.platformCommission() };
  }

  /**
   * تحقق من كوبون قبل التأكيد: هل هو صالح لهذا الزبون وهذه السلة، وكم يوفّر.
   * لا يستهلك شيئاً — الحجز يقع داخل معاملة إنشاء الطلب وحدها.
   */
  async checkCoupon(
    customerId: string,
    code: string,
    addressId: string,
    items: { bottleTypeId: string; qty: number }[],
  ) {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId: customerId },
    });
    if (!address) throw new NotFoundException('العنوان غير موجود');

    const types = await this.prisma.waterBottleType.findMany({
      where: { id: { in: items.map((i) => i.bottleTypeId) }, active: true },
    });
    const subtotal = round2(
      items.reduce((sum, i) => {
        const type = types.find((t) => t.id === i.bottleTypeId);
        if (!type) throw new NotFoundException('نوع قارورة غير متوفر');
        return sum + Number(type.price) * i.qty;
      }, 0),
    );
    const commissionAmount = await this.platformCommission();
    const grossTotal = round2(subtotal + commissionAmount);
    const location = await this.resolveLocation(address.lat, address.lng);

    const quote = await this.coupons.quote({
      code,
      customerId,
      cityId: location?.cityId ?? null,
      orderTotal: grossTotal,
      commission: commissionAmount,
    });
    return {
      code: quote.code,
      descAr: quote.descAr,
      discount: quote.discount,
      subtotal,
      commissionAmount,
      total: round2(grossTotal - quote.discount),
    };
  }

  /** عمولة المنصة الثابتة عن الطلب — يدفعها الزبون وتُخصم من محفظة الوكالة */
  private async platformCommission(): Promise<number> {
    const s = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 }, create: { id: 1 }, update: {},
    });
    return Number(s.commissionPerOrder);
  }

  /** يمنع إغراق التوزيع/الخادم بطلبات متتالية — فشل Redis لا يمنع طلباً مشروعاً */
  private async assertOrderCreateQuota(customerId: string, ip?: string) {
    try {
      const key = `order:create:${customerId}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, ORDER_CREATE_WINDOW_SECONDS);
      if (n > MAX_ORDER_CREATE_ATTEMPTS) {
        void recordRateLimitViolation(this.prisma, {
          scope: 'order_create', identifier: customerId, userId: customerId, ip,
        });
        throw new ForbiddenException('طلبات كثيرة خلال وقت قصير — حاول بعد قليل');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      /* Redis غير متاح — لا نمنع طلباً حقيقياً بسبب عطل بالكاش */
    }
  }

  /**
   * **لا طلب برقم غير موثَّق.** منذ صار الدخول بجوجل (قرار 2026-08-30) يمكن
   * أن يوجد حساب بلا هاتف إطلاقاً — والسائق لا يستطيع تسليم قارورة إلى
   * حسابٍ بلا رقم يتصل به.
   *
   * الفحص هنا لا في التطبيق وحده: شاشة التوثيق تُحسّن التجربة، لكن الطلب
   * يصل عبر HTTP ويمكن استدعاؤه مباشرة بتجاوزها. هذا هو الحارس الفعلي.
   *
   * `error: 'PhoneVerificationRequired'` ليقود التطبيق إلى شاشة التوثيق بدل
   * أن يعرض نص الخطأ ويترك الزبون عالقاً بلا طريق للأمام.
   */
  private async assertPhoneVerified(customerId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: customerId },
      select: { phone: true, phoneVerifiedAt: true },
    });
    if (!user?.phone || !user.phoneVerifiedAt) {
      throw new BadRequestException({
        error: 'PhoneVerificationRequired',
        message: 'وثّق رقم هاتفك قبل إرسال الطلب — السائق يحتاجه للتواصل معك',
      });
    }
  }

  async create(input: CreateOrderV2Input) {
    if (!input.items?.length) throw new BadRequestException('السلة فارغة');
    await this.assertPhoneVerified(input.customerId);
    await this.assertOrderCreateQuota(input.customerId, input.ip);

    // طلب واحد فعّال بحد أقصى لكل زبون. طلب سابق بلا التزام (وكالة/سائق)
    // بعد يقبل الاستبدال بتأكيد صريح؛ طلب ملتزم به طرف آخر لا يُلغى ضمنياً.
    const activeOrder = await this.prisma.order.findFirst({
      where: { customerId: input.customerId, status: { in: CUSTOMER_ACTIVE_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    let replacedOrderId: string | null = null;
    if (activeOrder) {
      if (!CUSTOMER_CANCELLABLE_STATUSES.includes(activeOrder.status)) {
        throw new BadRequestException(
          `عندك طلب توصيل قيد التنفيذ الآن (${activeOrder.code}) — انتظر اكتماله، أو تواصل مع الدعم لإلغائه قبل إنشاء طلب جديد`,
        );
      }
      if (input.cancelActiveOrderId !== activeOrder.id) {
        throw new ConflictException({
          error: 'ActiveOrderExists',
          message: `عندك طلب سابق (${activeOrder.code}) لسا قيد الانتظار — المتابعة رح تلغيه وتفعّل هذا الطلب الجديد. متابعة؟`,
          activeOrder: { id: activeOrder.id, code: activeOrder.code, status: activeOrder.status },
        });
      }
      replacedOrderId = activeOrder.id;
    }

    const address = await this.prisma.address.findFirst({
      where: { id: input.addressId, userId: input.customerId },
    });
    if (!address) throw new NotFoundException('العنوان غير موجود');

    // قاعدة العمل 1: التغطية = وجود وكالة يقع الموقع داخل نطاق توصيلها،
    // **وهي مفتوحة الآن**. الحدود الإدارية (حي/منطقة) اختيارية — للرسوم
    // واسم الموقع فقط.
    //
    // الرسالتان مختلفتان عمداً: من لا وكالة في منطقته يعرف أن لا فائدة من
    // المحاولة، ومن وكالتُه مغلقة يعرف أن عليه العودة لا الانصراف. ورسالة
    // واحدة لحالتين كانت تُفقد الثاني وهو زبون قائم.
    const coverage = await this.coverageStatus(address.lat, address.lng);
    if (!coverage.anyAgency) {
      throw new BadRequestException('لا توجد وكالة تخدم موقعك حالياً');
    }
    if (!coverage.openNow) {
      // الموعد في الرسالة لا في حقلٍ منفصل: الرفض يصل الزبونَ نصّاً، ومن
      // يعرف متى يفتح ينتظر بدل أن ينصرف.
      throw new BadRequestException(
        `الوكالة التي تخدم منطقتك مغلقة الآن${describeOpensIn(coverage.opensInMinutes)}`,
      );
    }
    const location = await this.resolveLocation(address.lat, address.lng);

    const types = await this.prisma.waterBottleType.findMany({
      where: { id: { in: input.items.map((i) => i.bottleTypeId) }, active: true },
    });
    const items = input.items.map((i) => {
      const type = types.find((t) => t.id === i.bottleTypeId);
      if (!type) throw new NotFoundException('نوع قارورة غير متوفر');
      if (i.qty < 1 || i.qty > 20) throw new BadRequestException('كمية غير صالحة');
      return { type, qty: i.qty, unitPrice: Number(type.price) };
    });

    // الفاتورة: مياه + عمولة المنصة. تُثبَّت العمولة الآن (لا عند قبول السائق)
    // لأن الزبون يجب أن يرى المبلغ النهائي قبل التأكيد.
    //
    // الأسعار تُقرأ من WaterBottleType هنا ولا تُقبل من العميل إطلاقاً — الطلب
    // لا يحمل حقل سعر أصلاً، فتطبيق معدَّل لا يستطيع تغيير ما يُحتسب.
    const subtotal = round2(items.reduce((s, i) => s + i.unitPrice * i.qty, 0));
    const commissionAmount = await this.platformCommission();
    const grossTotal = round2(subtotal + commissionAmount);

    // الخصم تموّله المنصة من عمولتها، فيُقيَّد بها: يُخصم من الوكالة عمولةٌ
    // أقل بمقداره فتخرج بثمن المياه كاملاً. يُتحقق منه هنا ثم يُحجز داخل
    // المعاملة أدناه — التحقق وحده لا يمنع طلبين متزامنين من تجاوز سقفه.
    const quote = input.couponCode
      ? await this.coupons.quote({
          code: input.couponCode,
          customerId: input.customerId,
          cityId: location?.cityId ?? null,
          orderTotal: grossTotal,
          commission: commissionAmount,
        })
      : null;
    const discountAmount = quote?.discount ?? 0;
    const total = round2(grossTotal - discountAmount);

    // ما عرضه التطبيق للزبون قبل التأكيد. ليس مصدراً للسعر بل تحقّقٌ منه:
    // كتالوج التطبيق مخزّن، فتغيير سعر من لوحة المنصة بينما الزبون في شاشة
    // المراجعة كان يعني أن يؤكد رقماً ويُحاسَب بآخر. نرفض بدل أن نفاجئه.
    if (
      input.expectedTotal !== undefined &&
      Math.abs(input.expectedTotal - total) > 0.001
    ) {
      throw new ConflictException({
        error: 'PriceChanged',
        message: `تغيّر السعر قبل تأكيد طلبك — الإجمالي الآن ${total.toFixed(3)} د.أ بدل ${input.expectedTotal.toFixed(3)}`,
        total,
        subtotal,
        commissionAmount,
        discountAmount,
      });
    }

    let created;
    for (let attempt = 0; ; attempt++) {
      try {
        created = await this.prisma.$transaction(async (tx) => {
          if (replacedOrderId) {
            // فحص وتبديل ذرّي: لو صار الطلب ملتزَماً به بين الفحص الأول
            // وهذه اللحظة (وكالة/سائق قَبِله للتو) نتراجع كاملاً بدل إلغائه
            // ضمنياً — نفس ما يفعله cancelByCustomer تماماً.
            const { count } = await tx.order.updateMany({
              where: {
                id: replacedOrderId,
                customerId: input.customerId,
                status: { in: CUSTOMER_CANCELLABLE_STATUSES },
              },
              data: {
                status: OrderStatus.CANCELLED,
                cancelReason: 'استبدله الزبون بطلب جديد',
                cancelledByUserId: input.customerId,
              },
            });
            if (count === 0) {
              throw new ConflictException(
                'طلبك السابق أصبح قيد التنفيذ للتو — أعد المحاولة',
              );
            }
            await tx.orderStatusHistory.create({
              data: {
                orderId: replacedOrderId,
                status: OrderStatus.CANCELLED,
                actorUserId: input.customerId,
                noteAr: 'استبدله الزبون بطلب جديد',
              },
            });
            // تذكرة «تعذّر إيجاد سائق» فقدت موضوعها: صاحب الطلب استبدله
            // بنفسه، ولا معنى لأن يتصل به فريق العمليات عن طلب ملغى
            await tx.supportTicket.updateMany({
              where: {
                orderId: replacedOrderId,
                type: 'SEARCH_FAILED',
                status: { in: ['OPEN', 'IN_PROGRESS'] },
              },
              data: { status: 'CLOSED', resolvedAt: new Date() },
            });
          }
          const order = await tx.order.create({
            data: {
              code: await this.nextCode(tx),
              customerId: input.customerId,
              addressId: address.id,
              zoneId: location?.zoneId ?? null,
              neighborhoodId: location?.neighborhoodId ?? null,
              districtId: location?.districtId ?? null,
              status: OrderStatus.CREATED,
              deliveryLat: address.lat,
              deliveryLng: address.lng,
              addressText: [
                location?.nameAr,
                `${address.street}${address.building ? ` عمارة ${address.building}` : ''}`,
              ].filter(Boolean).join(' — '),
              subtotal,
              commissionAmount,
              discountAmount,
              couponId: quote?.couponId ?? null,
              couponCode: quote?.code ?? null,
              total,
              notes: input.notes,
              items: {
                create: items.map((i) => ({
                  bottleTypeId: i.type.id,
                  qty: i.qty,
                  unitPrice: i.unitPrice,
                })),
              },
              statusHistory: {
                create: { status: OrderStatus.CREATED, noteAr: 'تم استلام الطلب' },
              },
            },
            include: { items: true, zone: false },
          });
          // داخل المعاملة نفسها: طلبٌ بخصم بلا استخدام مسجَّل يعني كوبوناً
          // بلا سقف فعلي، واستخدامٌ بلا طلب يحرق حصة الزبون بلا مقابل
          if (quote) {
            await this.coupons.redeemInTx(tx, {
              couponId: quote.couponId,
              customerId: input.customerId,
              orderId: order.id,
              amount: discountAmount,
            });
          }
          return order;
        });
        break;
      } catch (e) {
        const unique =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          (e.meta?.target as string[] | undefined)?.includes('code') === true;
        if (!unique || attempt >= 4) throw e;
      }
    }
    if (replacedOrderId) {
      // الطلب المستبدَل أُلغي داخل المعاملة أعلاه — كوبونه يعود بعد أن ثبتت
      // (الإرجاع يفتح معاملته الخاصة فلا يصح استدعاؤه داخل الأولى)
      await this.coupons.releaseForOrder(replacedOrderId);
      this.gateway.emitOrderStatus(
        replacedOrderId,
        input.customerId,
        OrderStatus.CANCELLED,
        'استبدله الزبون بطلب جديد',
      );
    }
    return created;
  }

  myOrders(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getForUser(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { ...ORDER_INCLUDE, branch: { select: { lat: true, lng: true } } },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.customerId !== userId && order.driverId !== userId) {
      // موظفو المنصة يمرون من مسار admin لاحقاً — هنا صاحب العلاقة فقط
      throw new ForbiddenException('لا تملك صلاحية عرض هذا الطلب');
    }
    // مع القراءة الأولى: الشاشة تعرض الوقت المتوقع فوراً بدل انتظار أول
    // نبضة موقع من السائق (قد تتأخر ثوانيَ أو دقيقة)
    const eta = estimateEta({
      status: order.status,
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
      driverLat: order.driver?.driverProfile?.currentLat,
      driverLng: order.driver?.driverProfile?.currentLng,
      branchLat: order.branch?.lat,
      branchLng: order.branch?.lng,
    });
    return { ...hideCustomerPhoneFromDriver(order, userId), eta };
  }

  /** تقدم السائق بعد التعيين: PICKED_UP → DELIVERING → COMPLETED */
  async driverUpdateStatus(orderId: string, driverId: string, next: OrderStatus) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    const allowed = DRIVER_FLOW[order.status] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(`لا يمكن الانتقال من ${order.status} إلى ${next}`);
    }

    const data: Prisma.OrderUpdateInput = { status: next };
    if (next === OrderStatus.PICKED_UP) data.pickedUpAt = new Date();
    if (next === OrderStatus.COMPLETED) data.deliveredAt = new Date();

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data,
      include: ORDER_INCLUDE,
    });
    await this.prisma.orderStatusHistory.create({
      data: { orderId, status: next, actorUserId: driverId, noteAr: STATUS_NOTES[next] },
    });

    // الزبون كان لا يسمع شيئاً حتى انتهاء التوصيل: الحالتان الوسيطتان تصلانه
    // عبر الـSocket وحده، فمن أغلق التطبيق — وهو الحال الغالب أثناء انتظاره —
    // لا يعرف أن طلبه تحرّك أصلاً. هاتان الرسالتان تُبقيانه على علم قبل أن
    // يطرق أحدٌ بابه ويطلب منه المبلغ.
    if (next === OrderStatus.PICKED_UP) {
      await this.notifications.send(
        order.customerId,
        'ORDER_PICKED_UP',
        'جاري تجهيز طلبك',
        `استلم السائق قوارير طلبك ${order.code} من المستودع`,
        { orderId },
        { app: DeviceApp.CUSTOMER },
      );
    }
    if (next === OrderStatus.DELIVERING) {
      await this.notifications.send(
        order.customerId,
        'ORDER_DELIVERING',
        'السائق في الطريق إليك',
        `انطلق السائق بطلبك ${order.code} — تابعه على الخريطة`,
        { orderId },
        { app: DeviceApp.CUSTOMER },
      );
    }

    if (next === OrderStatus.COMPLETED) {
      // السائق يعود متاحاً لاستقبال عروض جديدة
      await this.prisma.driverProfile.update({
        where: { userId: driverId },
        data: { status: 'AVAILABLE' },
      });
      await this.notifications.send(
        order.customerId,
        'ORDER_COMPLETED',
        'تم التوصيل',
        `اكتمل طلبك ${order.code} — بالسلامة!`,
        { orderId },
        { app: DeviceApp.CUSTOMER },
      );
      // المرحلة 5: الوكالة قبضت الكاش — عمولة المنصة تُخصم من محفظتها
      await this.ledger.chargeCommission(updated);
      // السائق فرغ: إن كان هناك طلب منتظر في نطاق وكالته يذهب إليه فوراً
      await this.dispatch.onDriverAvailable(driverId);
    }

    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      next,
      STATUS_NOTES[next],
      order.agencyId,
    );
    // ردّ نقلة COMPLETED نفسه لا يحمل الرقم: هي اللحظة التي ينتهي فيها سببه
    return hideCustomerPhoneFromDriver(updated, driverId);
  }

  /**
   * سياج «وصلتُ»: لا يؤكد السائق وصوله وهو بعيد عن باب الزبون.
   *
   * تأكيد الوصول يُطلق إشعاراً يُنزل الزبون بالمبلغ إلى الباب؛ إطلاقه من
   * الشارع التالي يُنزله ليقف. والسائق يفتح به شاشة التسليم فيؤكد تسليماً
   * لم يقع بعد.
   *
   * المفتاح ونصف القطر بيد الأدمن (DispatchSettings): مدن ضيقة الأزقة أو
   * أبنية عالية تُفسد GPS، وهناك تُوسَّع المسافة أو يُطفأ الشرط كله.
   *
   * الموقع من التطبيق أولاً (لحظي)، ثم آخر موقع بثّه السائق. بلا موقع
   * إطلاقاً والشرط مفعّل: يُرفض ويُقال له شغّل الموقع — لولا ذلك لكان إطفاء
   * الـGPS هو طريق الالتفاف على الشرط كله.
   */
  private async assertNearCustomer(
    order: { deliveryLat: number; deliveryLng: number },
    driverId: string,
    coords?: { lat?: number; lng?: number },
  ) {
    const settings = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    if (!settings.arrivalGeofenceEnabled) return;

    let lat = coords?.lat;
    let lng = coords?.lng;
    if (lat == null || lng == null) {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { userId: driverId },
        select: { currentLat: true, currentLng: true, lastSeenAt: true },
      });
      // موقع قديم لا يقول أين هو الآن — تطبيق أُغلق في المستودع يبقى موقعه
      // هناك. السائق الواقف عند الباب لا يبثّ (البثّ عند الحركة) لكن وصوله
      // كان قبل دقائق، فالمهلة سخية بما يكفي له وضيّقة عن موقع الأمس.
      const freshMs = 15 * 60_000;
      const fresh =
        profile?.lastSeenAt != null &&
        Date.now() - +profile.lastSeenAt <= freshMs;
      if (fresh) {
        lat = profile?.currentLat ?? undefined;
        lng = profile?.currentLng ?? undefined;
      }
    }
    if (lat == null || lng == null) {
      throw new BadRequestException(
        'تعذّر تحديد موقعك — شغّل خدمة الموقع وامنح التطبيق الإذن ثم أعد المحاولة',
      );
    }

    const limit = settings.arrivalRadiusMeters;
    const meters = Math.round(
      haversineKm(lat, lng, order.deliveryLat, order.deliveryLng) * 1000,
    );
    if (meters > limit) {
      throw new BadRequestException(
        `ما زلت على بُعد ${meters} متر من الزبون — اقترب إلى ${limit} متر أو أقل لتأكيد وصولك`,
      );
    }
  }

  /**
   * وصل السائق إلى باب الزبون — يسبق تأكيد التسليم وتحصيل المبلغ.
   *
   * ليست نقلة في OrderStatus: الحالة تبقى DELIVERING لأن التوصيل لم ينتهِ،
   * وإقحام حالة جديدة كان سيمسّ آلة الحالات وكل ما يقرأها (شاشة الزبون،
   * لوحة الوكالة، شروط الإلغاء) مقابل خبرٍ لا يغيّر ما هو مسموح.
   *
   * وحدها اللحظة التي يحتاج فيها الزبون أن ينزل ومعه المبلغ. قبلها كان لا
   * يعلم بشيء حتى يُطرق الباب.
   */
  async driverArrived(
    orderId: string,
    driverId: string,
    coords?: { lat?: number; lng?: number },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (order.status !== OrderStatus.DELIVERING) {
      throw new BadRequestException('لا يمكن تسجيل الوصول قبل الانطلاق للعميل');
    }
    await this.assertNearCustomer(order, driverId, coords);
    // ضغطة ثانية على الزر — رجوعٌ من شاشة التأكيد ثم دخولها من جديد — لا
    // تُزعج الزبون بإشعار مكرر. الوصول لحظة واحدة لا تتكرر.
    if (order.arrivedAt) return { arrivedAt: order.arrivedAt };

    const arrivedAt = new Date();
    await this.prisma.order.update({ where: { id: orderId }, data: { arrivedAt } });
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.DELIVERING,
        actorUserId: driverId,
        noteAr: 'وصل السائق إلى موقع التسليم',
      },
    });

    await this.notifications.send(
      order.customerId,
      'ORDER_ARRIVED',
      'السائق وصل',
      `السائق عند موقع التسليم بطلبك ${order.code} — جهّز المبلغ ${Number(order.total).toFixed(2)} د.أ`,
      { orderId },
      { app: DeviceApp.CUSTOMER },
    );
    // الحالة لم تتغير، والحدث يحمل الملاحظة: تطبيق الزبون يعيد قراءة الطلب
    // على order:status، فتصل الملاحظة إلى سجل الحالات المعروض أمامه.
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.DELIVERING,
      'وصل السائق إلى موقع التسليم',
      order.agencyId,
    );
    return { arrivedAt };
  }

  /**
   * إلغاء الزبون — مسموح فقط قبل تعيين أي سائق: طلب لم يوزَّع بعد أو ينتظر
   * سائقاً. بعد إسناده لوكالة يوجد عرض حي قد يقبله سائق في نفس اللحظة،
   * فالإلغاء هناك يمر عبر الدعم لا عبر التطبيق.
   */
  /**
   * إلغاء الزبون لطلبه — الحدّ هو **انطلاق السائق إليه**، لا استلامه من
   * المستودع. ما دامت الحالة قبل DELIVERING فالسائق لم يتحرك نحو الزبون،
   * وهذا ما يراه على شاشته: PICKED_UP تُعرض «جاري تجهيز طلبك» بينما
   * DELIVERING تُعرض «في الطريق إليك».
   *
   * AGENCY_ASSIGNED داخلة في المسموح — وهي الحالة التي يعود إليها الطلب بعد
   * انسحاب سائق. كانت مستثناة فيُقال للزبون «تواصل مع خدمة العملاء» عن طلب
   * انسحب سائقه للتو ولم يبدأ أحد به شيئاً؛ من ينتظر بلا سائق يملك إلغاء
   * انتظاره. سؤال «نبحث لك عن سائق آخر؟» يبقى معروضاً، والإلغاء من هنا
   * يُسقطه لأن صاحبه أجاب بفعله.
   *
   * SEARCH_FAILED داخلة كذلك: طلب لم يقبله أي سائق ولا وكالة تمسك به. كان
   * يُرفَض إلغاؤه فيُقال لصاحبه «تواصل مع خدمة العملاء» عن طلب لا أحد يعمل
   * عليه أصلاً — أسوأ حالة يُحبس فيها الزبون. من انتظر ولم يجد سائقاً يملك
   * أن ينهي انتظاره، وتذكرة العمليات تُغلق معه فلا يُلاحَق طلب ملغى.
   *
   * عند PICKED_UP تكون القوارير قد خرجت من المستودع فعلاً، فالإلغاء له
   * كلفة على الوكالة — لذلك تُشعَر هي والسائق، بخلاف الإلغاء قبل التعيين.
   * بعد DELIVERING يُرفض دائماً؛ حينها التواصل مع الدعم.
   */
  async cancelByCustomer(orderId: string, customerId: string, reason?: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    const { count } = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        customerId,
        status: {
          in: [
            OrderStatus.CREATED,
            OrderStatus.SEARCHING,
            OrderStatus.WAITING_FOR_DRIVER,
            OrderStatus.SEARCH_FAILED,
            OrderStatus.AGENCY_ASSIGNED,
            OrderStatus.DRIVER_ASSIGNED,
            OrderStatus.PICKED_UP,
          ],
        },
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelReason: reason?.trim() || 'ألغى الزبون الطلب',
        cancelledByUserId: customerId,
        // سؤال «نبحث لك عن سائق آخر؟» لم يعد معلّقاً — أجاب صاحبه بالإلغاء،
        // وتركه يجعل مهلته تحاول إلغاء طلب ملغى
        redispatchAskedAt: null,
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        'لا يمكن إلغاء الطلب في هذه المرحلة — تواصل مع خدمة العملاء',
      );
    }
    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.CANCELLED,
        actorUserId: customerId,
        noteAr: 'ألغى الزبون الطلب',
      },
    });
    // الكوبون يعود لصاحبه: من ألغى لم ينتفع بالخصم، وحرق حصته على طلب لم
    // يصل شكوى مؤكدة
    await this.coupons.releaseForOrder(orderId);

    // سائق مُعيَّن لم ينطلق بعد — يعود متاحاً فوراً بلا أثر عليه
    if (order.driverId) {
      const afterPickup = order.status === OrderStatus.PICKED_UP;
      await this.prisma.driverProfile.update({
        where: { userId: order.driverId },
        data: { status: 'AVAILABLE' },
      });
      await this.notifications.send(
        order.driverId,
        'ORDER_CANCELLED',
        'أُلغي الطلب',
        afterPickup
          ? `ألغى الزبون الطلب ${order.code} — أعد القوارير إلى المستودع`
          : `ألغى الزبون الطلب ${order.code} قبل الاستلام من المستودع`,
        { orderId },
        { app: DeviceApp.DRIVER },
      );
      // القوارير خرجت من المستودع وستعود — الوكالة تحتاج أن تعرف، فهي
      // من يستقبلها ويسوّي مخزونها
      if (afterPickup && order.agencyId) {
        const staff = await this.prisma.userRole.findMany({
          where: { agencyId: order.agencyId },
          select: { userId: true },
          distinct: ['userId'],
        });
        await this.notifications.sendMany(
          staff.map((s) => s.userId),
          'ORDER_CANCELLED',
          'إلغاء بعد الاستلام من المستودع',
          `ألغى الزبون الطلب ${order.code} بعد تحميل القوارير — السائق يعيدها إليكم`,
          { orderId },
          { app: DeviceApp.DRIVER },
        );
      }
      await this.dispatch.onDriverAvailable(order.driverId);
    } else if (order.agencyId) {
      // الطلب كان بيد الوكالة بلا سائق (أو عاد إليها بعد انسحاب سائق):
      // هي من كانت تبحث عن سائق أو تجهّز — فتوقف عن ذلك
      await this.notifications.sendMany(
        await agencyStaffIds(this.prisma, order.agencyId),
        'ORDER_CANCELLED',
        'ألغى الزبون الطلب',
        `أُلغي الطلب ${order.code} من الزبون قبل تعيين سائق — لا حاجة لمتابعته`,
        { orderId },
        { app: DeviceApp.DRIVER },
      );
    }

    // تذكرة «تعذّر إيجاد سائق» فقدت موضوعها: صاحب الطلب أنهاه بنفسه، ولا
    // معنى لأن يتصل به فريق العمليات بعد ذلك
    if (order.status === OrderStatus.SEARCH_FAILED) {
      await this.prisma.supportTicket.updateMany({
        where: {
          orderId,
          type: 'SEARCH_FAILED',
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        data: { status: 'CLOSED', resolvedAt: new Date() },
      });
    }

    this.gateway.emitOrderStatus(
      orderId,
      customerId,
      OrderStatus.CANCELLED,
      'ألغى الزبون الطلب',
      order.agencyId,
    );
    return { ok: true };
  }

  /**
   * إلغاء من فريق العمليات لطلب علِق — زبون لا يرد، منطقة بلا وكالة، أو
   * طلب بقي معلّقاً بلا حل حتى فقد معناه.
   *
   * كان المخرج الوحيد أمام الطلب العالق هو الإسناد القسري: إن لم تكن هناك
   * وكالة تخدمه بقي معلّقاً إلى الأبد، لا الزبون يراه ينتهي ولا التقارير
   * تتخلص منه. الإلغاء هنا هو الاعتراف بذلك صراحةً.
   *
   * ما بعد الاستلام من المستودع لا يُلغى من هنا: القوارير خارج المستودع
   * وبيد السائق، وإنهاء الطلب بضغطة من مكتب بعيد يترك مالاً وبضاعة بلا
   * تسوية. هناك ينسحب السائق بسببه، أو يُغلق الطلب بعد التسليم.
   *
   * السبب إلزامي: يظهر للزبون في شاشته، ولمن يقرأ الطلب بعد شهر.
   */
  async cancelByPlatform(orderId: string, actorId: string, reasonAr: string) {
    const reason = reasonAr.trim();
    if (reason.length < 5) {
      throw new BadRequestException('اكتب سبب الإلغاء (5 أحرف على الأقل)');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    const cancellable: OrderStatus[] = [
      OrderStatus.CREATED,
      OrderStatus.SEARCHING,
      OrderStatus.WAITING_FOR_DRIVER,
      OrderStatus.SEARCH_FAILED,
      OrderStatus.AGENCY_ASSIGNED,
      OrderStatus.DRIVER_ASSIGNED,
    ];
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: cancellable } },
      data: {
        status: OrderStatus.CANCELLED,
        cancelReason: reason,
        cancelledByUserId: actorId,
        // القرار اتُّخذ نيابةً عن الزبون — سؤاله المعلّق سقط معه
        redispatchAskedAt: null,
        waitingUntil: null,
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        `لا يُلغى طلب حالته ${order.status} من هنا — بعد الاستلام تُسوّى القوارير أولاً`,
      );
    }

    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.CANCELLED,
        actorUserId: actorId,
        noteAr: `ألغاه فريق العمليات: ${reason}`,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'order.cancel',
        entityType: 'Order',
        entityId: orderId,
        oldValue: { status: order.status, code: order.code },
        newValue: { status: OrderStatus.CANCELLED, reasonAr: reason },
      },
    });
    await this.coupons.releaseForOrder(orderId);

    // سائق كان مُعيَّناً ولم يستلم بعد — يعود متاحاً فوراً ويُخبَر لئلا يذهب
    if (order.driverId) {
      await this.prisma.driverProfile.update({
        where: { userId: order.driverId },
        data: { status: 'AVAILABLE' },
      });
      await this.notifications.send(
        order.driverId,
        'ORDER_CANCELLED',
        'أُلغي الطلب',
        `أُلغي الطلب ${order.code} من فريق العمليات: ${reason}`,
        { orderId },
        { app: DeviceApp.DRIVER },
      );
      await this.dispatch.onDriverAvailable(order.driverId);
    }
    if (order.agencyId) {
      await this.notifications.sendMany(
        await agencyStaffIds(this.prisma, order.agencyId),
        'ORDER_CANCELLED',
        'أُلغي الطلب من المنصة',
        `أُلغي الطلب ${order.code} من فريق العمليات: ${reason}`,
        { orderId },
        { app: DeviceApp.DRIVER },
      );
    }
    await this.notifications.send(
      order.customerId,
      'ORDER_CANCELLED',
      'أُلغي طلبك',
      `أُلغي طلبك ${order.code}: ${reason} — اعتذارنا، ويمكنك إعادة الطلب الآن.`,
      { orderId },
      { app: DeviceApp.CUSTOMER },
    );
    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.CANCELLED,
      `أُلغي الطلب من فريق العمليات: ${reason}`,
      order.agencyId,
    );
    void this.telegram.send(
      `🛑 إلغاء إداري
` +
        `الطلب: #${order.code} (كان ${order.status})
` +
        `السبب: ${reason}`,
    );
    return { ok: true as const, status: OrderStatus.CANCELLED };
  }

  /**
   * انسحاب السائق بعد قبوله الطلب — مسموح حتى لحظة التسليم (عطل مركبة،
   * حادث، زبون لا يرد). الطلب يُلغى ولا يُعاد توزيعه: بعد الاستلام تكون
   * القوارير بيد السائق، وإعادة الطلب لسائق آخر تعِد الزبون بما لا يملكه
   * أحد. الاعتذار للزبون وتذكرة العمليات هما ما يُغلق الحلقة.
   *
   * لا سقف يمنع التكرار (قرار: لا نحبس سائقاً في طريق مسدود)، لكن كل إلغاء
   * يُسجَّل بسببه في OrderAssignmentHistory ويصل الوكالة فوراً — الضبط
   * إداري لا برمجي.
   */
  async cancelByDriver(
    orderId: string,
    driverId: string,
    reason: DriverCancelReason,
    note?: string,
  ) {
    const reasonAr = DRIVER_CANCEL_REASONS[reason];
    if (!reasonAr) throw new BadRequestException('سبب الإلغاء غير صالح');

    const trimmedNote = note?.trim();
    // "سبب آخر" بلا شرح لا يقول شيئاً لمن سيتصرف على التذكرة
    if (reason === 'OTHER' && (trimmedNote?.length ?? 0) < 10) {
      throw new BadRequestException('اكتب سبب الإلغاء (10 أحرف على الأقل)');
    }
    if (trimmedNote && containsProfanity(trimmedNote)) {
      throw new BadRequestException('الرجاء كتابة السبب بلا كلمات غير لائقة');
    }
    const fullReason = trimmedNote ? `${reasonAr} — ${trimmedNote}` : reasonAr;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
      include: { customer: CUSTOMER_CONTACT, driver: { select: { name: true } } },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    // انسحاب السائق لا يُنهي الطلب: الزبون ما زال ينتظر مياهه. الطلب يعود إلى
    // وكالته بلا سائق ليُستأنف البحث — إلا إن كان السبب يخص الزبون نفسه،
    // فيُوقَف بانتظار قراره. تفاصيل السبب تُخزَّن في redispatchReason ليقرأها
    // الزبون؛ ملاحظة السائق الحرة تخص من سيتصرف (الوكالة والعمليات)، فمكانها
    // سجل الإسناد والتذكرة لا شاشة الزبون.
    const askCustomer = CUSTOMER_SIDE_CANCEL_REASONS.includes(reason);
    // ذرّي: الزبون قد يكون ألغى للتو، أو السائق أنهى التسليم من شاشة أخرى
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, driverId, status: { in: DRIVER_CANCELLABLE_STATUSES } },
      data: {
        status: OrderStatus.AGENCY_ASSIGNED,
        driverId: null,
        driverAssignedAt: null,
        pickedUpAt: null,
        arrivedAt: null,
        redispatchAskedAt: askCustomer ? new Date() : null,
        redispatchReason: reasonAr,
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        'لا يمكن إلغاء الطلب في هذه المرحلة — تواصل مع وكالتك',
      );
    }

    // بعد الاستلام تكون القوارير خارج المستودع بلا وجهة — أمرٌ يستحق
    // تدخلاً أسرع من انسحاب قبل الاستلام
    const afterPickup = order.status !== OrderStatus.DRIVER_ASSIGNED;

    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.AGENCY_ASSIGNED,
        actorUserId: driverId,
        noteAr: `انسحب السائق: ${reasonAr}`,
      },
    });
    // الكوبون يبقى محجوزاً: الطلب لم يُلغَ بل يبحث عن سائق آخر. يُحرَّر عند
    // الإلغاء الفعلي وحده — في answerRedispatch أو مهلة القرار.
    await this.prisma.orderAssignmentHistory.create({
      data: {
        orderId,
        agencyId: order.agencyId,
        driverId,
        action: AssignmentAction.DRIVER_CANCELLED,
        reason: `${fullReason} (عند ${order.status})`,
      },
    });

    // السائق يعود متاحاً فوراً: انسحابه من هذا الطلب لا يعني توقفه عن العمل
    await this.prisma.driverProfile.update({
      where: { userId: driverId },
      data: { status: 'AVAILABLE' },
    });

    if (askCustomer) {
      await this.notifications.send(
        order.customerId,
        'ORDER_REDISPATCH_ASK',
        'هل نبحث لك عن سائق آخر؟',
        `اعتذر السائق عن إكمال طلبك ${order.code} (${reasonAr}). طلبك ما زال قائماً — افتح التطبيق وأخبرنا إن كنت تريد سائقاً آخر أم إلغاء الطلب.`,
        { orderId },
        { app: DeviceApp.CUSTOMER },
      );
      await this.dispatch.scheduleRedispatchDecision(
        orderId,
        REDISPATCH_DECISION_TIMEOUT_SECONDS * 1000,
      );
    } else {
      await this.notifications.send(
        order.customerId,
        'ORDER_DRIVER_CHANGED',
        'نبحث لك عن سائق آخر',
        `تعذّر على السائق إكمال طلبك ${order.code} (${reasonAr}) — طلبك لم يُلغَ، ونبحث لك عن سائق آخر الآن.`,
        { orderId },
        { app: DeviceApp.CUSTOMER },
      );
    }

    // تنبيه الوكالة: من يملك التصرف — يتابع القوارير ويحاسب السائق
    if (order.agencyId) {
      await this.notifications.sendMany(
        await agencyStaffIds(this.prisma, order.agencyId),
        'ORDER_DRIVER_CANCELLED',
        'انسحب سائق من طلب بعد قبوله',
        `${order.driver?.name ?? 'سائق'} انسحب من الطلب ${order.code}: ${fullReason}` +
          (afterPickup ? ' — القوارير خرجت من المستودع' : '') +
          (askCustomer ? ' — الطلب موقوف بانتظار قرار الزبون' : ' — يُبحث عن سائق آخر'),
        { orderId },
        { app: DeviceApp.DRIVER },
      );
      this.gateway.emitToAgency(order.agencyId, 'order:driver-cancelled', {
        orderId,
        code: order.code,
        driverName: order.driver?.name ?? null,
        reasonAr: fullReason,
        afterPickup,
      });
    }

    await this.prisma.supportTicket.create({
      data: {
        code: `TKT-${Math.floor(100000 + Math.random() * 900000)}`,
        type: 'DRIVER_CANCELLED',
        priority: afterPickup ? 'URGENT' : 'HIGH',
        subjectAr:
          `انسحب السائق من الطلب ${order.code} عند ${order.status} — ${fullReason}`,
        createdByUserId: driverId,
        orderId,
        agencyId: order.agencyId,
      },
    });

    this.gateway.emitOrderStatus(
      orderId,
      order.customerId,
      OrderStatus.AGENCY_ASSIGNED,
      askCustomer
        ? `انسحب السائق (${reasonAr}) — بانتظار قرارك`
        : `انسحب السائق (${reasonAr}) — نبحث لك عن سائق آخر`,
      order.agencyId,
    );

    void this.telegram.send(
      `⚠️ انسحاب سائق\n` +
        `الطلب: #${order.code} (${order.status})\n` +
        `السائق: ${order.driver?.name ?? '—'}\n` +
        `السبب: ${fullReason}\n` +
        (askCustomer ? `⏸️ موقوف بانتظار قرار الزبون` : `🔄 يُعاد البحث عن سائق آخر`) +
        (afterPickup ? `\n🔺 بعد الاستلام — القوارير خارج المستودع` : ''),
    );

    // فرغ السائق: طلب منتظر في نطاق وكالته قد يذهب إليه الآن
    await this.dispatch.onDriverAvailable(driverId);

    // استئناف البحث داخل نفس الوكالة — من انسحب مستبعَد تلقائياً (عرضه
    // ACCEPTED لا EXPIRED)، وإن نفد سائقوها انتقل المحرك لوكالة أخرى.
    if (!askCustomer && order.agencyId) {
      await this.dispatch.continueWithinAgency(orderId, order.agencyId);
    }
    return { ok: true, redispatching: !askCustomer, awaitingCustomer: askCustomer };
  }

  /**
   * رد الزبون على «هل نبحث لك عن سائق آخر؟» بعد انسحاب سائق لسبب يخصّه.
   * نعم → يُستأنف البحث من نفس الوكالة، لا → يُلغى الطلب ويُحرَّر كوبونه.
   */
  async answerRedispatch(orderId: string, customerId: string, search: boolean) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (!order.redispatchAskedAt) {
      throw new BadRequestException('لا يوجد قرار معلّق على هذا الطلب');
    }

    // ذرّي: مهلة القرار قد تكون ألغت الطلب في هذه اللحظة بالذات
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, customerId, redispatchAskedAt: { not: null } },
      data: search
        ? { redispatchAskedAt: null, redispatchReason: null }
        : {
            redispatchAskedAt: null,
            status: OrderStatus.CANCELLED,
            cancelReason: 'ألغى الزبون الطلب بعد انسحاب السائق',
            cancelledByUserId: customerId,
          },
    });
    if (count === 0) throw new BadRequestException('انتهت مهلة الرد على هذا الطلب');

    if (!search) {
      await this.prisma.orderStatusHistory.create({
        data: {
          orderId,
          status: OrderStatus.CANCELLED,
          actorUserId: customerId,
          noteAr: 'ألغى الزبون الطلب بعد انسحاب السائق',
        },
      });
      await this.coupons.releaseForOrder(orderId);
      this.gateway.emitOrderStatus(
        orderId,
        customerId,
        OrderStatus.CANCELLED,
        'ألغى الزبون الطلب بعد انسحاب السائق',
        order.agencyId,
      );
      return { ok: true, status: OrderStatus.CANCELLED };
    }

    await this.prisma.orderStatusHistory.create({
      data: {
        orderId,
        status: OrderStatus.AGENCY_ASSIGNED,
        actorUserId: customerId,
        noteAr: 'طلب الزبون البحث عن سائق آخر',
      },
    });
    if (!order.agencyId) throw new BadRequestException('الطلب بلا وكالة — تواصل مع خدمة العملاء');
    await this.dispatch.continueWithinAgency(orderId, order.agencyId);
    return { ok: true, status: OrderStatus.AGENCY_ASSIGNED };
  }

  /**
   * تقييم الزبون بعد الإنجاز — يُحدَّث تقييم السائق والوكالة معاً.
   *
   * النجوم تُغذّي متوسطاً يقرؤه محرك التوزيع، والكلام يبقى على الطلب نفسه:
   * المتوسط يقول «3.8» ولا يقول لماذا، ولوحتا المنصة والوكالة تعرضان الكلام
   * منسوباً إلى طلبه وسائقه فيُعرف ما الذي تكرّر.
   */
  async rate(
    orderId: string,
    customerId: string,
    stars: number,
    comment?: string,
  ) {
    if (stars < 1 || stars > 5) throw new BadRequestException('تقييم غير صالح');
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId, status: OrderStatus.COMPLETED },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود أو لم يكتمل');
    if (order.rating) throw new BadRequestException('تم التقييم مسبقاً');

    const text = comment?.trim();
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        rating: stars,
        ratingComment: text ? text : null,
        ratedAt: new Date(),
      },
    });
    if (order.driverId) {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { userId: order.driverId },
      });
      if (profile) {
        const count = profile.ratingCount + 1;
        await this.prisma.driverProfile.update({
          where: { userId: order.driverId },
          data: {
            rating: Math.round(((profile.rating * profile.ratingCount + stars) / count) * 100) / 100,
            ratingCount: count,
          },
        });
      }
    }
    if (order.agencyId) {
      const agency = await this.prisma.agency.findUnique({ where: { id: order.agencyId } });
      if (agency) {
        const count = agency.ratingCount + 1;
        await this.prisma.agency.update({
          where: { id: order.agencyId },
          data: {
            rating: Math.round(((agency.rating * agency.ratingCount + stars) / count) * 100) / 100,
            ratingCount: count,
          },
        });
      }
    }
    return { ok: true };
  }

  // ============ العناوين والكتالوج ============

  /** المناطق النشطة بمراكز مشتقة من الـ polygons — لواجهة اختيار العنوان */
  listZones() {
    return this.prisma.$queryRaw`
      SELECT z.id, z."nameAr", z."cityId", z."neighborhoodId",
             ST_Y(ST_Centroid(z.geom)) AS "centerLat",
             ST_X(ST_Centroid(z.geom)) AS "centerLng"
      FROM "Zone" z
      WHERE z.active = true
      ORDER BY z."nameAr"
    `;
  }

  /** شجرة المواقع: مدينة ← مناطق ← أحياء — لاختيار التغطية في لوحة الوكالة */
  listGeoTree() {
    return this.prisma.city.findMany({
      select: {
        id: true,
        nameAr: true,
        active: true,
        districts: {
          where: { active: true },
          orderBy: { nameAr: 'asc' },
          select: {
            id: true,
            nameAr: true,
            neighborhoods: {
              where: { active: true },
              orderBy: { nameAr: 'asc' },
              select: { id: true, nameAr: true },
            },
          },
        },
      },
      orderBy: { nameAr: 'asc' },
    });
  }

  /** العناوين مع اسم موقعها (وصفي) وتغطيتها الفعلية (نطاق الوكالات) */
  async listAddresses(userId: string) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string; label: string; street: string; building: string | null;
        floor: string | null; notes: string | null; lat: number; lng: number;
        isDefault: boolean; locName: string | null; covered: boolean;
      }[]
    >`
      SELECT a.id, a.label, a.street, a.building, a.floor, a.notes,
             a.lat, a.lng, a."isDefault",
             COALESCE(n."nameAr", z."nameAr", d."nameAr") AS "locName",
             EXISTS (
               SELECT 1 FROM "AgencyBranch" b
               JOIN "Agency" ag ON ag.id = b."agencyId"
               WHERE b.active AND ag.status = 'ACTIVE'
                 AND ST_DWithin(
                       ST_MakePoint(b.lng, b.lat)::geography,
                       ST_MakePoint(a.lng, a.lat)::geography,
                       b."deliveryRadiusKm" * 1000.0)
             ) AS covered
      FROM "Address" a
      LEFT JOIN LATERAL (
        SELECT nb."nameAr"
        FROM "Neighborhood" nb JOIN "District" dd ON dd.id = nb."districtId"
        WHERE nb.active AND dd.active AND nb.geom IS NOT NULL
          AND ST_Contains(nb.geom, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326))
        LIMIT 1
      ) n ON true
      LEFT JOIN LATERAL (
        SELECT zz."nameAr"
        FROM "Zone" zz
        WHERE zz.active AND ST_Contains(zz.geom, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326))
        LIMIT 1
      ) z ON true
      LEFT JOIN LATERAL (
        SELECT di."nameAr"
        FROM "District" di
        WHERE di.active AND di.geom IS NOT NULL
          AND ST_Contains(di.geom, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326))
        LIMIT 1
      ) d ON true
      WHERE a."userId" = ${userId} AND a.active
      ORDER BY a."isDefault" DESC
    `;
    return rows.map(({ locName, covered, ...a }) => ({
      ...a,
      areaName: locName, // اسم الموقع للعرض فقط
      inCoverage: covered,
    }));
  }

  /** يمنع إغراق الخادم بإضافات متتالية — فشل Redis لا يمنع طلباً مشروعاً */
  private async assertAddressCreateQuota(userId: string, ip?: string) {
    try {
      const key = `address:create:${userId}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, ADDRESS_CREATE_WINDOW_SECONDS);
      if (n > MAX_ADDRESS_CREATE_ATTEMPTS) {
        void recordRateLimitViolation(this.prisma, {
          scope: 'address_create', identifier: userId, userId, ip,
        });
        throw new ForbiddenException('إضافات كثيرة خلال وقت قصير — حاول بعد قليل');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      /* Redis غير متاح — لا نمنع إضافة حقيقية بسبب عطل بالكاش */
    }
  }

  /** حقل عنوان إلزامي: بلا فراغ فقط، وبلا كلمات غير لائقة */
  private assertCleanAddressField(value: string, fieldLabel: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) throw new BadRequestException(`الحقل "${fieldLabel}" مطلوب`);
    if (containsProfanity(trimmed)) {
      throw new BadRequestException('الرجاء كتابة عنوان بلا كلمات غير لائقة');
    }
    return trimmed;
  }

  /** حقل عنوان اختياري: يُقبل فارغاً، لكن إن كُتب فبلا كلمات غير لائقة */
  private assertCleanOptionalField(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (containsProfanity(trimmed)) {
      throw new BadRequestException('الرجاء كتابة ملاحظات بلا كلمات غير لائقة');
    }
    return trimmed;
  }

  async createAddress(
    userId: string,
    data: { label: string; street: string; building: string; floor: string; notes?: string; lat: number; lng: number },
    ip?: string,
  ) {
    await this.assertAddressCreateQuota(userId, ip);
    const label = this.assertCleanAddressField(data.label, 'اسم العنوان');
    const street = this.assertCleanAddressField(data.street, 'الشارع');
    const building = this.assertCleanAddressField(data.building, 'رقم العمارة');
    const floor = this.assertCleanAddressField(data.floor, 'الطابق');
    const notes = this.assertCleanOptionalField(data.notes);
    const count = await this.prisma.address.count({ where: { userId, active: true } });
    if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
      throw new BadRequestException(
        `أقصى عدد عناوين محفوظة ${MAX_ADDRESSES_PER_CUSTOMER} — احذف عنواناً قديماً لتضيف غيره`,
      );
    }
    // نكشف مبكراً إن كان العنوان خارج نطاق كل الوكالات بدل مفاجأة الزبون عند الطلب
    const [covered, location] = await Promise.all([
      this.isCovered(data.lat, data.lng),
      this.resolveLocation(data.lat, data.lng),
    ]);
    const address = await this.prisma.address.create({
      data: {
        label, street, building, floor, notes,
        lat: data.lat, lng: data.lng, userId, isDefault: count === 0,
      },
    });
    return { ...address, inCoverage: covered, areaName: location?.nameAr ?? null };
  }

  /**
   * تعيين العنوان الافتراضي — العنوان الذي يُقترح أولاً عند الطلب.
   *
   * كان يُثبَّت عند أول عنوان يضيفه الزبون بلا أي طريق لتغييره، فمن انتقل
   * بيته بقي طلبه يقترح عنوانه القديم. الاثنتان في معاملة واحدة: صفةٌ واحدة
   * لا تحتمل أن تُرفع عن القديم وتفشل قبل أن تُوضع على الجديد.
   */
  async setDefaultAddress(userId: string, addressId: string) {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId, active: true },
    });
    if (!address) throw new NotFoundException('العنوان غير موجود');
    if (address.isDefault) return { ok: true };

    await this.prisma.$transaction([
      this.prisma.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.address.update({
        where: { id: addressId },
        data: { isDefault: true },
      }),
    ]);
    return { ok: true };
  }

  /**
   * حذف عنوان: فعلياً إن لم يُستخدم بأي طلب قط، وإلا "منطقياً" (active=false)
   * فيبقى Order.address سليماً بالسجل القديم. عنوان افتراضي يُحذف ينقل
   * الصفة لأقدم عنوان متبقٍّ حتى لا يبقى الزبون بلا عنوان افتراضي.
   */
  async deleteAddress(userId: string, addressId: string) {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId, active: true },
    });
    if (!address) throw new NotFoundException('العنوان غير موجود');

    const usedInOrders = await this.prisma.order.count({ where: { addressId } });
    if (usedInOrders > 0) {
      await this.prisma.address.update({
        where: { id: addressId },
        data: { active: false, isDefault: false },
      });
    } else {
      await this.prisma.address.delete({ where: { id: addressId } });
    }

    if (address.isDefault) {
      const next = await this.prisma.address.findFirst({
        where: { userId, active: true, id: { not: addressId } },
        orderBy: { id: 'asc' },
      });
      if (next) {
        await this.prisma.address.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    return { ok: true };
  }

  listWaterBottleTypes() {
    return this.prisma.waterBottleType.findMany({
      where: { active: true },
      orderBy: { sort: 'asc' },
    });
  }

  /**
   * بانرات تطبيق واحد. الجمهور صريح لا مستنتَج من هوية الطالب: المسار عام بلا
   * توكن (يراه الزائر قبل أن يسجّل)، فلا حساب يُقرأ منه أي تطبيق يسأل.
   */
  listActivePromoBanners(audience: AppTarget) {
    return this.prisma.promoBanner.findMany({
      where: { active: true, audience },
      orderBy: { sort: 'asc' },
    });
  }
}
