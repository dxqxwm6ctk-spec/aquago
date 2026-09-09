import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PaymentMethod } from '@prisma-v2/client';
import { agencyStaffIds } from '../common/agency-staff.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** أيام التنبيه قبل نهاية الشهر المدفوع */
const EXPIRY_WARNING_DAYS = 3;

/**
 * مهلة السماح بعد انتهاء الشهر المدفوع — يومان يبقى فيهما التوصيل يعمل
 * طبيعياً (كما هو دائماً، الاشتراك لا يمسّ التوزيع) لكن الوكالة تُنبَّه أن
 * وضعها صار متأخراً لا "قريب من الانتهاء".
 */
const GRACE_PERIOD_DAYS = 2;

export type SubscriptionState =
  | 'NOT_BILLED' // لا فاتورة صدرت لها بعد
  | 'ACTIVE' // مغطّاة، وبعيدة عن الانتهاء
  | 'EXPIRING_SOON' // مغطّاة، لكن خلال أيام التنبيه الثلاثة
  | 'GRACE' // انتهت التغطية، لكن ضمن يومي السماح
  | 'OVERDUE'; // تجاوزت السماح بلا تجديد (أو بلا تغطية سابقة أصلاً رغم فواتير)

/**
 * اشتراك الوكالة الشهري.
 *
 * **معزول عن التوزيع عزلاً تاماً — قرار لا تفصيل.** رصيد `Wallet` يحكم
 * التوزيع (`balance <= 0` يُخرج الوكالة منه)، فلو خُصم الاشتراك من المحفظة
 * لأوقف التوزيع من باب خلفي. لذلك للاشتراك دفتره الخاص: فاتورة شهرية
 * تتراكم كدَين، وطلب دفع يسدّدها. وكالة لم تدفع تبقى توزّع كأن شيئاً لم
 * يكن — التحصيل شأن إداري لا تقني.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private prisma: PrismaV2Service,
    private notifications: NotificationsService,
    private gateway: TrackingV2Gateway,
  ) {}

  private async monthlyPrice(): Promise<number> {
    const s = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    return Number(s.subscriptionMonthlyPrice);
  }

  // بتوقيت عمّان لا UTC: الخادم قد يعمل بـUTC، فبعد منتصف الليل محلياً يبقى
  // على الشهر السابق فتُصدَر فاتورة الشهر الخطأ
  private ammanMonthStart(d = new Date()): Date {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Amman',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return new Date(Date.UTC(get('year'), get('month') - 1, 1));
  }

  /**
   * تاريخ اليوم بلا وقت، باعتبار عمّان لا UTC — منتصف ليل UTC قد يقع بعد
   * ظهر عمّان بساعات (+3)، فمقارنة اللحظة الخام بـ`coveredUntil` بالميلي
   * ثانية (Math.ceil على الفرق) كانت تعطي يوماً إضافياً وهمياً قرب الحدود:
   * وكالة انتهت تغطيتها فعلياً بالأمس تظهر "يبقى 0 يوم" بدل "يوم سماح واحد
   * مضى". المقارنة هنا بالتواريخ الصحيحة (لا الفروق الكسرية) تحسم هذا.
   */
  private ammanDateOnly(d = new Date()): Date {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Amman',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  }

  private monthEnd(start: Date): Date {
    return new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59),
    );
  }

  private monthLabel(d: Date): string {
    return new Intl.DateTimeFormat('ar', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d);
  }

  /**
   * حالة الاشتراك من تاريخ آخر تغطية مدفوعة بالكامل — الدالة الوحيدة التي
   * تقرر الحدود الزمنية (تنبيه/سماح/تأخّر)، يستخدمها `statusFor` و
   * `overview` و`warnExpiring` معاً حتى لا تتفرّق قراءة الحالة في مكانين.
   */
  private computeState(
    coveredUntil: Date | null,
    hasInvoices: boolean,
    now = new Date(),
  ): {
    state: SubscriptionState;
    daysLeft: number | null;
    graceDaysLeft: number | null;
  } {
    if (!coveredUntil) {
      return {
        state: hasInvoices ? 'OVERDUE' : 'NOT_BILLED',
        daysLeft: null,
        graceDaysLeft: null,
      };
    }
    // coveredUntil مبنية بأرقام تقويم عمّان لكن كأرقام UTC (راجع
    // ammanMonthStart/monthEnd) — فتقطيعها بحقولها الخام (لا بإعادة قراءتها
    // عبر منطقة زمنية) يعطي "يومها" الصحيح كما قُصد عند إنشائها.
    const untilDay = Date.UTC(
      coveredUntil.getUTCFullYear(),
      coveredUntil.getUTCMonth(),
      coveredUntil.getUTCDate(),
    );
    const today = this.ammanDateOnly(now).getTime();
    const daysLeft = Math.round((untilDay - today) / 86400000);
    if (daysLeft > EXPIRY_WARNING_DAYS) {
      return { state: 'ACTIVE', daysLeft, graceDaysLeft: null };
    }
    if (daysLeft >= 0) {
      return { state: 'EXPIRING_SOON', daysLeft, graceDaysLeft: null };
    }
    // daysLeft سالب هنا: -1 هو أول يوم بعد الانتهاء لا يوم الانتهاء نفسه
    // (ذاك EXPIRING_SOON عند 0)، فيحسب مهلة يومين كاملين بدءاً منه —
    // بلا +1 كانت المهلة تُختصر إلى يوم واحد فعلي بدل يومين.
    const graceDaysLeft = GRACE_PERIOD_DAYS + daysLeft + 1;
    if (graceDaysLeft > 0) {
      return { state: 'GRACE', daysLeft, graceDaysLeft };
    }
    return { state: 'OVERDUE', daysLeft, graceDaysLeft: 0 };
  }

  /**
   * يعيد عدد من وصلهم فعلاً — وكالة بلا موظفين، أو أسكتوا هذا النوع، تعيد صفراً.
   *
   * السائقون مستثنون: فواتير الاشتراك ومتأخراته شأن مالي بين الوكالة
   * والمنصة، لا يملك السائق فيه فعلاً ولا يخصّه.
   */
  private async notifyAgency(
    agencyId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
  ): Promise<number> {
    const staff = await agencyStaffIds(this.prisma, agencyId);
    return this.notifications.sendMany(staff, type, titleAr, bodyAr, { agencyId });
  }

  /**
   * إصدار فواتير الشهر الجاري. idempotent بقيد `@@unique([agencyId,
   * periodStart])` — تشغيلها مرتين لا يضاعف الفاتورة. سعر كل وكالة
   * مستقل: سعرها المخصص إن وُجد، وإلا العام — فوكالة سعرها المخصص > 0
   * تُفوتَر حتى لو كان السعر العام صفراً (لا فوترة افتراضية).
   *
   * الفاتورة الجديدة يصلها إشعارها دائماً. أما [remindUnpaid] فتُذكِّر
   * إضافةً كل وكالة عليها متأخرات من شهور سابقة — بلا هذا الخيار لا يصل
   * المتأخرين شيء عند إعادة التشغيل، لأن فواتيرهم صدرت سابقاً فلا تُنشأ
   * من جديد ولا إشعار لها.
   */
  /**
   * الفوترة الدورية — يستدعيها `SchedulerWorker` كل ست ساعات على العامل
   * وحده. idempotent بقيد فريد على (وكالة، شهر): التكرار لا يضاعف فاتورة،
   * ولذلك لا نحتاج ضبط لحظة بعينها من الشهر ولا نخسر الفوترة إن كان الخادم
   * متوقفاً أول الشهر. القيد هو ما يجعل المهمة آمنة حتى لو تداخل تشغيلان.
   */
  async issueMonthlyInvoices(now = new Date(), remindUnpaid = false) {
    const defaultPrice = await this.monthlyPrice();
    const periodStart = this.ammanMonthStart(now);
    const periodEnd = this.monthEnd(periodStart);
    // المعفاة لا تُفوتَر أصلاً — إعفاؤها قرار المنصة لكل وكالة على حدة
    const agencies = await this.prisma.agency.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, subscriptionEnabled: true },
      select: { id: true, subscriptionMonthlyPriceOverride: true },
    });

    let issued = 0;
    const notified = new Set<string>();
    for (const a of agencies) {
      const price =
        a.subscriptionMonthlyPriceOverride != null
          ? Number(a.subscriptionMonthlyPriceOverride)
          : defaultPrice;
      if (price <= 0) continue;
      try {
        await this.prisma.subscriptionInvoice.create({
          data: { agencyId: a.id, periodStart, periodEnd, amount: price },
        });
        issued++;
        await this.notifyAgency(
          a.id,
          'SUBSCRIPTION_INVOICE',
          'فاتورة اشتراك جديدة',
          `صدرت فاتورة اشتراك ${this.monthLabel(periodStart)} بقيمة ${price.toFixed(2)} د.أ`,
        );
        notified.add(a.id);
      } catch {
        /* صدرت مسبقاً — القيد الفريد يحمي من التكرار */
      }
    }

    // من وصله إشعار فاتورته الجديدة للتوّ لا يُزعَج بإشعار ثانٍ
    const { reminded } = remindUnpaid
      ? await this.remindUnpaidAgencies(notified)
      : { reminded: 0 };

    if (issued > 0 || reminded > 0) {
      this.logger.log(
        `أُصدرت ${issued} فاتورة اشتراك لشهر ${this.monthLabel(periodStart)}` +
          (reminded > 0 ? ` وذُكِّرت ${reminded} وكالة بمتأخراتها` : ''),
      );
    }
    return { issued, reminded, periodStart, periodEnd, defaultPrice };
  }

  /**
   * تذكير كل وكالة مشترِكة عليها متأخرات — بلا إصدار أي فاتورة. الأدمن
   * ينخّ المتأخرين متى شاء دون أن يُقحم الإصدار في اللحظة الخطأ من الشهر.
   *
   * [skip] لمن وصله إشعار للتوّ من نداء الإصدار فلا يُزعَج مرتين.
   */
  async remindUnpaidAgencies(skip = new Set<string>()) {
    const agencies = await this.prisma.agency.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, subscriptionEnabled: true },
      select: { id: true },
    });
    let reminded = 0;
    for (const a of agencies) {
      if (skip.has(a.id)) continue;
      const outstanding = await this.outstandingFor(a.id);
      if (outstanding <= 0) continue;
      // العدد المعروض للأدمن هو من وصلهم فعلاً — وكالة بلا موظفين لا
      // تُحسب مذكَّرة لأن أحداً لم يقرأ شيئاً
      const sent = await this.notifyAgency(
        a.id,
        'SUBSCRIPTION_INVOICE',
        'تذكير باشتراك المنصة',
        `عليكم ${outstanding.toFixed(2)} د.أ مستحقة لاشتراك المنصة — يرجى التسديد. ` +
          'التوصيل مستمر بلا أي تأثير.',
      );
      if (sent > 0) reminded++;
    }
    return { reminded };
  }

  /** مجموع ما لم يُسدَّد من فواتير وكالة — يخدم التذكير والنظرة العامة */
  private async outstandingFor(agencyId: string): Promise<number> {
    const invoices = await this.prisma.subscriptionInvoice.findMany({
      where: { agencyId },
      select: { amount: true, paidAmount: true },
    });
    return round2(
      invoices.reduce((s, i) => s + (Number(i.amount) - Number(i.paidAmount)), 0),
    );
  }

  /** تفعيل/إعفاء وكالة من الاشتراك — لا يمسّ فواتير صدرت ولا التوزيع */
  async setEnabled(agencyId: string, enabled: boolean) {
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    await this.prisma.agency.update({
      where: { id: agencyId },
      data: { subscriptionEnabled: enabled },
    });
    return { ok: true as const, subscriptionEnabled: enabled };
  }

  /**
   * السعر العام: ما تدفعه كل وكالة شهرياً ما لم يُخصَّص لها سعر آخر.
   * صفر = لا فوترة اشتراك إطلاقاً. مخزَّن في DispatchSettings (سجل إعدادات
   * المنصة الواحد) لكن يُضبط من شاشة الاشتراكات نفسها — مكانه الطبيعي —
   * وبصلاحية المالية لا صلاحية التوزيع.
   */
  async setDefaultPrice(price: number) {
    if (Number.isNaN(price) || price < 0 || price > 10000) {
      throw new BadRequestException('سعر غير صالح');
    }
    await this.prisma.dispatchSettings.upsert({
      where: { id: 1 },
      create: { id: 1, subscriptionMonthlyPrice: price },
      update: { subscriptionMonthlyPrice: price },
    });
    return { ok: true as const, monthlyPrice: price };
  }

  /**
   * سعر مخصص لوكالة بعينها — `null` يمسح التخصيص ويعيدها للسعر العام.
   * لا يمسّ فواتير صدرت سلفاً (مبلغها ثابت وقت الإصدار)، فقط ما يُصدر
   * بعد هذا التغيير.
   */
  async setPriceOverride(agencyId: string, price: number | null) {
    if (price !== null && (Number.isNaN(price) || price < 0 || price > 10000)) {
      throw new BadRequestException('سعر غير صالح');
    }
    const agency = await this.prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    await this.prisma.agency.update({
      where: { id: agencyId },
      data: { subscriptionMonthlyPriceOverride: price },
    });
    return { ok: true as const, subscriptionMonthlyPriceOverride: price };
  }

  /** حالة اشتراك وكالة — تخدم لوحتها ولوحة المنصة معاً */
  async statusFor(agencyId: string) {
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      select: { subscriptionEnabled: true, subscriptionMonthlyPriceOverride: true },
    });
    const [invoices, payments, defaultPrice, contract] = await Promise.all([
      this.prisma.subscriptionInvoice.findMany({
        where: { agencyId },
        orderBy: { periodStart: 'desc' },
        take: 24,
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { reviewedBy: { select: { name: true } } },
      }),
      this.monthlyPrice(),
      // قيمة الاشتراك في العقد الساري — تُعرض للأدمن ليعرف من أين جاء
      // الرقم وما المتفق عليه، فتعديلٌ يخالفه يصير قراراً واعياً لا سهواً.
      this.prisma.agencyContract.findFirst({
        where: { agencyId, status: 'ACTIVE' },
        orderBy: { startsAt: 'desc' },
        select: { number: true, subscriptionMonthly: true },
      }),
    ]);
    const priceOverride =
      agency?.subscriptionMonthlyPriceOverride != null
        ? Number(agency.subscriptionMonthlyPriceOverride)
        : null;
    const price = priceOverride ?? defaultPrice;

    const outstanding = round2(
      invoices.reduce((s, i) => s + (Number(i.amount) - Number(i.paidAmount)), 0),
    );
    const fullyPaid = invoices.filter(
      (i) => Number(i.paidAmount) >= Number(i.amount),
    );
    const coveredUntil = fullyPaid.length
      ? fullyPaid
          .map((i) => i.periodEnd)
          .sort((a, b) => b.getTime() - a.getTime())[0]
      : null;
    const coveredFrom = fullyPaid.length
      ? fullyPaid
          .map((i) => i.periodStart)
          .sort((a, b) => a.getTime() - b.getTime())[0]
      : null;
    const { state, daysLeft, graceDaysLeft } = this.computeState(
      coveredUntil,
      invoices.length > 0,
    );

    return {
      monthlyPrice: price,
      /// null = تستخدم السعر العام؛ رقم = سعرها المخصص
      monthlyPriceOverride: priceOverride,
      /// معفاة من الفوترة بقرار المنصة — لا فواتير جديدة تصدر لها
      enabled: agency?.subscriptionEnabled ?? true,
      /// ما نصّ عليه العقد الساري: القيمة المتفق عليها ورقم العقد. null في
      /// القيمة = العقد يعفيها. غياب الكائن كله = لا عقد ساري.
      contract: contract
        ? {
            number: contract.number,
            monthly:
              contract.subscriptionMonthly === null
                ? null
                : Number(contract.subscriptionMonthly),
          }
        : null,
      outstanding,
      // معلومة إدارية بحتة — لا أثر لها على التوزيع بأي حال مهما كانت الحالة
      state,
      gracePeriodDays: GRACE_PERIOD_DAYS,
      warningDays: EXPIRY_WARNING_DAYS,
      coveredFrom,
      coveredUntil,
      daysLeft,
      graceDaysLeft,
      invoices: invoices.map((i) => ({
        id: i.id,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        label: this.monthLabel(i.periodStart),
        amount: Number(i.amount),
        paidAmount: Number(i.paidAmount),
        remaining: round2(Number(i.amount) - Number(i.paidAmount)),
        issuedAt: i.createdAt,
        paidAt: i.paidAt,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        method: p.method,
        noteAr: p.noteAr,
        reviewNoteAr: p.reviewNoteAr,
        reference: p.reference,
        createdAt: p.createdAt,
        reviewedAt: p.reviewedAt,
        reviewedBy: p.reviewedBy?.name ?? null,
      })),
    };
  }

  /** الوكالة تطلب دفع فاتورتها — المالية تعتمد بعد وصول المبلغ */
  async requestPayment(
    agencyId: string,
    data: { amount: number; method: PaymentMethod; noteAr?: string },
    actorId: string,
  ) {
    if (data.amount <= 0) throw new BadRequestException('المبلغ غير صالح');
    const open = await this.prisma.subscriptionPayment.count({
      where: { agencyId, status: 'PENDING' },
    });
    if (open > 0) {
      throw new BadRequestException('لديكم طلب دفع قيد المراجعة — انتظروا البتّ فيه');
    }
    const req = await this.prisma.subscriptionPayment.create({
      data: {
        agencyId,
        amount: data.amount,
        method: data.method,
        noteAr: data.noteAr,
        requestedById: actorId,
      },
    });
    this.gateway.emitToAdmins('subscription:payment', {
      id: req.id,
      agencyId,
      amount: Number(req.amount),
    });
    return req;
  }

  async cancelPayment(agencyId: string, id: string, actorId: string) {
    const { count } = await this.prisma.subscriptionPayment.updateMany({
      where: { id, agencyId, status: 'PENDING' },
      data: { status: 'CANCELLED', reviewedById: actorId, reviewedAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('لا يمكن إلغاء هذا الطلب');
    return { ok: true as const };
  }

  /**
   * اعتماد الدفع — يسدّد الفواتير من الأقدم فالأحدث. الفائض عن كل الفواتير
   * يبقى محسوباً للوكالة (يصير `outstanding` سالباً) فيُخصم تلقائياً من
   * فاتورة الشهر القادم بدل أن يضيع أو يُرفض.
   */
  async approvePayment(
    id: string,
    actorId: string,
    reference?: string,
    noteAr?: string,
  ) {
    const req = await this.prisma.subscriptionPayment.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('الطلب غير موجود');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('هذا الطلب بُتَّ فيه مسبقاً');
    }

    let left = Number(req.amount);
    const invoices = await this.prisma.subscriptionInvoice.findMany({
      where: { agencyId: req.agencyId },
      orderBy: { periodStart: 'asc' },
    });
    for (const inv of invoices) {
      if (left <= 0) break;
      const due = round2(Number(inv.amount) - Number(inv.paidAmount));
      if (due <= 0) continue;
      const pay = Math.min(due, left);
      left = round2(left - pay);
      const newPaid = round2(Number(inv.paidAmount) + pay);
      await this.prisma.subscriptionInvoice.update({
        where: { id: inv.id },
        data: {
          paidAmount: newPaid,
          paidAt: newPaid >= Number(inv.amount) ? new Date() : null,
        },
      });
    }

    await this.prisma.subscriptionPayment.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedById: actorId,
        reviewedAt: new Date(),
        reference,
        reviewNoteAr: noteAr,
      },
    });
    const state = await this.statusFor(req.agencyId);
    await this.notifyAgency(
      req.agencyId,
      'SUBSCRIPTION_PAID',
      'تم اعتماد دفعة الاشتراك',
      `اعتُمدت دفعتكم ${Number(req.amount).toFixed(2)} د.أ` +
        (state.outstanding > 0
          ? ` — المتبقي عليكم ${state.outstanding.toFixed(2)} د.أ`
          : ' — لا مستحقات عليكم'),
    );
    this.gateway.emitToAgency(req.agencyId, 'subscription:updated', {
      outstanding: state.outstanding,
    });
    return { ok: true as const, outstanding: state.outstanding, credit: left };
  }

  async rejectPayment(id: string, reasonAr: string, actorId: string) {
    const { count } = await this.prisma.subscriptionPayment.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        reviewedById: actorId,
        reviewedAt: new Date(),
        reviewNoteAr: reasonAr,
      },
    });
    if (count === 0) throw new BadRequestException('هذا الطلب بُتَّ فيه مسبقاً');
    const req = await this.prisma.subscriptionPayment.findUniqueOrThrow({
      where: { id },
    });
    await this.notifyAgency(
      req.agencyId,
      'SUBSCRIPTION_PAID',
      'رُفضت دفعة الاشتراك',
      `رُفض طلب دفع ${Number(req.amount).toFixed(2)} د.أ — ${reasonAr}`,
    );
    return { ok: true as const };
  }

  /** طلبات الدفع لكل الوكالات — شاشة المالية في لوحة المنصة */
  listPayments(status?: string) {
    return this.prisma.subscriptionPayment.findMany({
      where: status ? { status: status as never } : {},
      include: {
        agency: { select: { id: true, nameAr: true } },
        requestedBy: { select: { name: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  /**
   * نظرة المنصة: كل وكالة وما عليها وحالة اشتراكها. تجلب الفواتير خاماً لا
   * مجمَّعة بـgroupBy لأن الحالة (فعّال/قريب الانتهاء/سماح/متأخر) تحتاج
   * تاريخ آخر فاتورة مدفوعة بالكامل لكل وكالة، لا مجموع المبالغ وحده —
   * وعدد الوكالات هنا صغير (منصة B2B لا آلاف المستأجرين) فلا كلفة حقيقية.
   */
  async overview() {
    const [agencies, invoices, contracts] = await Promise.all([
      this.prisma.agency.findMany({
        select: {
          id: true,
          nameAr: true,
          status: true,
          subscriptionEnabled: true,
          subscriptionMonthlyPriceOverride: true,
        },
        orderBy: { nameAr: 'asc' },
      }),
      this.prisma.subscriptionInvoice.findMany({
        select: { agencyId: true, amount: true, paidAmount: true, periodEnd: true },
      }),
      // قيمة الاشتراك في العقد الساري — تُعرض بجانب السعر المطبَّق ليَظهر
      // للأدمن أي وكالة تُفوتَر بغير ما وقّعت عليه.
      this.prisma.agencyContract.findMany({
        where: { status: 'ACTIVE' },
        select: { agencyId: true, number: true, subscriptionMonthly: true },
        orderBy: { startsAt: 'desc' },
      }),
    ]);
    // آخر عقد ساري لكل وكالة — الأحدث يفوز (المصفوفة مرتَّبة تنازلياً)
    const contractByAgency = new Map<string, (typeof contracts)[number]>();
    for (const c of contracts) {
      if (!contractByAgency.has(c.agencyId)) contractByAgency.set(c.agencyId, c);
    }
    const byAgency = new Map<string, typeof invoices>();
    for (const inv of invoices) {
      const list = byAgency.get(inv.agencyId) ?? [];
      list.push(inv);
      byAgency.set(inv.agencyId, list);
    }
    const now = new Date();
    const defaultPrice = await this.monthlyPrice();
    return {
      monthlyPrice: defaultPrice,
      gracePeriodDays: GRACE_PERIOD_DAYS,
      warningDays: EXPIRY_WARNING_DAYS,
      agencies: agencies.map((a) => {
        const list = byAgency.get(a.id) ?? [];
        const billed = list.reduce((s, i) => s + Number(i.amount), 0);
        const paid = list.reduce((s, i) => s + Number(i.paidAmount), 0);
        const fullyPaid = list.filter((i) => Number(i.paidAmount) >= Number(i.amount));
        const coveredUntil = fullyPaid.length
          ? fullyPaid.map((i) => i.periodEnd).sort((x, y) => y.getTime() - x.getTime())[0]
          : null;
        const { state, daysLeft, graceDaysLeft } = this.computeState(
          coveredUntil,
          list.length > 0,
          now,
        );
        const priceOverride =
          a.subscriptionMonthlyPriceOverride != null
            ? Number(a.subscriptionMonthlyPriceOverride)
            : null;
        return {
          agencyId: a.id,
          nameAr: a.nameAr,
          status: a.status,
          enabled: a.subscriptionEnabled,
          price: priceOverride ?? defaultPrice,
          isCustomPrice: priceOverride !== null,
          /// ما نصّ عليه العقد الساري — null داخل الكائن = العقد يعفيها،
          /// وغياب الكائن = لا عقد ساري لهذه الوكالة
          contract: (() => {
            const c = contractByAgency.get(a.id);
            if (!c) return null;
            return {
              number: c.number,
              monthly:
                c.subscriptionMonthly === null
                  ? null
                  : Number(c.subscriptionMonthly),
            };
          })(),
          billed: round2(billed),
          paid: round2(paid),
          outstanding: round2(billed - paid),
          state,
          daysLeft,
          graceDaysLeft,
        };
      }),
    };
  }

  /**
   * تنبيه حسب حالة الاشتراك — قبل الانتهاء بثلاثة أيام، ثم كل يوم سماح،
   * ثم بعد تجاوز السماح. يُستدعى دورياً — وتكراره محتمَل هنا لأن الغرض
   * تحصيل لا منع؛ الوكالة المعفاة (subscriptionEnabled=false) لا تُنبَّه
   * أصلاً لأنها لا تُفوتَر.
   */
  async warnExpiring() {
    // لا بوابة سعر عام هنا عمداً: وكالة سعرها المخصص > 0 يجب أن تُنبَّه
    // حتى لو كان السعر العام صفراً (لا فوترة افتراضية). الحلقة رخيصة —
    // راجع تعليق overview() أعلاه عن حجم المنصة.
    const agencies = await this.prisma.agency.findMany({
      where: { status: 'ACTIVE', subscriptionEnabled: true },
      select: { id: true },
    });
    let warned = 0;
    for (const a of agencies) {
      const st = await this.statusFor(a.id);
      if (st.state === 'EXPIRING_SOON') {
        await this.notifyAgency(
          a.id,
          'SUBSCRIPTION_EXPIRING',
          'اشتراككم يقارب الانتهاء',
          `يبقى ${st.daysLeft} ${st.daysLeft === 1 ? 'يوم' : 'أيام'} على انتهاء اشتراككم — ` +
            'جدّدوه من صفحة المحفظة. توصيل الطلبات يستمر بلا أي تأثير.',
        );
        warned++;
      } else if (st.state === 'GRACE') {
        await this.notifyAgency(
          a.id,
          'SUBSCRIPTION_EXPIRING',
          'انتهى اشتراككم — مهلة سماح يومين',
          `أمامكم ${st.graceDaysLeft} ${st.graceDaysLeft === 1 ? 'يوم' : 'يومين'} لتجديد الاشتراك ` +
            'قبل أن يُعتبر متأخراً. توصيل الطلبات مستمر طبيعياً خلال هذه المهلة.',
        );
        warned++;
      } else if (st.state === 'OVERDUE' && st.outstanding > 0) {
        await this.notifyAgency(
          a.id,
          'SUBSCRIPTION_EXPIRING',
          'اشتراككم متأخر',
          'تجاوزتم مهلة السماح بلا تجديد — يرجى تسديد الاشتراك في أقرب وقت.',
        );
        warned++;
      }
    }
    return { warned };
  }
}
