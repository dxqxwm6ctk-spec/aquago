import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ContractAlertKind, ContractStatus, OnboardingStatus, WetCopyStatus } from '@prisma-v2/client';
import { agencyStaffIds } from '../common/agency-staff.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * تنبيهات الاستحقاق والدورة التلقائية للعقود.
 *
 * **لا شيء هنا مثبَّت في الشيفرة عدا آلية العدّ.** ما يُنبَّه عليه، وقبل كم
 * يوماً، ولمن، وبأي نصّ — كلّه صفوف يحرّرها الأدمن. لأن «60 و30 و7» عددٌ
 * اخترناه لا حكمٌ قانوني، وأول مرة يريد أحدهم تنبيهاً قبل 90 يوماً يجب
 * ألّا ينتظر نشر إصدار.
 *
 * الجدولة في طابور BullMQ (`SchedulerWorker`) لا في مؤقّت داخلي: المؤقّت
 * يعيش داخل العملية، فكل حاوية API كانت تشغّل نسختها منه — ومع حاويتين
 * يصير المسح مزدوجاً. والتكرار غير ضارّ بحد ذاته: كل تنبيه محميّ بقيد فريد
 * على (القاعدة، الموضوع، دورة الاستحقاق) فلا يخرج مرتين مهما تكرّر الفحص.
 */
@Injectable()
export class ContractAlertsService {
  private readonly logger = new Logger(ContractAlertsService.name);

  constructor(
    private prisma: PrismaV2Service,
    private notifications: NotificationsService,
  ) {}

  private lastRunAt = 0;

  /**
   * نبضة كل ساعة يستدعيها `SchedulerWorker`، لكن العمل يقع كل
   * `alertCheckHours` — الفاصل إعدادٌ يبدّله الأدمن وقت التشغيل، ولو كان هو
   * نفسه فترة الجدولة لاحتاج تغييره إعادة نشر.
   *
   * `lastRunAt` داخل العملية: يكفي لأن المستهلك واحد (ROLE=worker بـ
   * concurrency 1)، والتنبيهات نفسها محميّة بقيد فريد على أي حال.
   */
  async tick() {
    try {
      const s = await this.settings();
      if (!s.alertsEnabled) return;
      const dueAfterMs = Math.max(1, s.alertCheckHours) * 3600_000;
      if (Date.now() - this.lastRunAt < dueAfterMs) return;
      this.lastRunAt = Date.now();
      await this.run();
    } catch (e) {
      this.logger.error(`فشل فحص تنبيهات العقود: ${e}`);
    }
  }

  private settings() {
    return this.prisma.contractSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }

  // ==================== القواعد ====================

  /** القواعد الافتراضية — تُزرع مرة واحدة، ثم يملكها الأدمن بالكامل */
  async ensureRules() {
    const any = await this.prisma.contractAlertRule.findFirst();
    if (any) return;
    await this.prisma.contractAlertRule.createMany({
      data: [
        {
          kind: 'CONTRACT_EXPIRY', offsetDays: 60, sortOrder: 1,
          titleAr: 'عقدكم يقارب الانتهاء',
          bodyAr: 'يتبقّى {{days}} يوماً على انتهاء العقد {{number}} بتاريخ {{date}}. للتجديد أو عدمه، الإشعار الخطّي مطلوب قبل المدة المنصوص عليها في المادة 4-2.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'CONTRACT_EXPIRY', offsetDays: 30, sortOrder: 2,
          titleAr: 'شهر على انتهاء عقدكم',
          bodyAr: 'يتبقّى {{days}} يوماً على انتهاء العقد {{number}} بتاريخ {{date}}.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'CONTRACT_EXPIRY', offsetDays: 7, sortOrder: 3,
          titleAr: 'أسبوع على انتهاء عقدكم',
          bodyAr: 'يتبقّى {{days}} أيام على انتهاء العقد {{number}}. تواصلوا معنا إن كان لديكم أي استفسار.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'WET_COPY_DUE', offsetDays: 7, sortOrder: 4,
          titleAr: 'النسخة الورقية من العقد',
          bodyAr: 'يتبقّى {{days}} أيام لتسليم نسخة العقد {{number}} موقّعة ومختومة. ارفعوها من لوحة الوكالة ← عقدي.',
          notifyAgency: true, notifyPlatform: false,
        },
        {
          kind: 'WET_COPY_DUE', offsetDays: 0, sortOrder: 5,
          titleAr: 'اليوم آخر موعد للنسخة الورقية',
          bodyAr: 'اليوم آخر موعد لتسليم نسخة العقد {{number}} موقّعة ومختومة (المادة 28-2).',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'WET_COPY_DUE', offsetDays: -7, sortOrder: 6,
          titleAr: 'تأخّرت النسخة الورقية',
          bodyAr: 'مضى {{days}} يوماً على موعد تسليم نسخة العقد {{number}} الورقية. التأخّر يجيز تعليق الحساب وفق المادة 28-3.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'LICENSE_EXPIRY', offsetDays: 60, sortOrder: 7,
          titleAr: 'ترخيص يقارب الانتهاء',
          bodyAr: '{{item}} تنتهي بتاريخ {{date}} — يتبقّى {{days}} يوماً. جدّدوها وحدّثوا صورتها في ملف المنشأة.',
          notifyAgency: true, notifyPlatform: false,
        },
        {
          kind: 'LICENSE_EXPIRY', offsetDays: 30, sortOrder: 8,
          titleAr: 'شهر على انتهاء ترخيص',
          bodyAr: '{{item}} تنتهي بتاريخ {{date}} — يتبقّى {{days}} يوماً.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'LICENSE_EXPIRY', offsetDays: 0, sortOrder: 9,
          titleAr: 'ترخيص ينتهي اليوم',
          bodyAr: '{{item}} تنتهي اليوم. العمل بترخيص منتهٍ يجيز الإيقاف الفوري وفق المادة 5-3.',
          notifyAgency: true, notifyPlatform: true,
        },
        {
          kind: 'ONBOARDING_GRACE', offsetDays: 14, sortOrder: 10,
          titleAr: 'أكملوا ملف المنشأة',
          bodyAr: 'يتبقّى {{days}} يوماً لاستكمال بيانات ووثائق ملف المنشأة (المادة 6-6). الملف غير المكتمل يجيز تعليق الحساب.',
          notifyAgency: true, notifyPlatform: false,
        },
      ],
    });
  }

  async listRules() {
    await this.ensureRules();
    const [rules, settings, log] = await Promise.all([
      this.prisma.contractAlertRule.findMany({
        orderBy: [{ kind: 'asc' }, { offsetDays: 'desc' }],
        include: { _count: { select: { logs: true } } },
      }),
      this.settings(),
      this.prisma.contractAlertLog.findMany({
        orderBy: { sentAt: 'desc' },
        take: 50,
        include: { rule: { select: { kind: true, offsetDays: true, titleAr: true } } },
      }),
    ]);
    return { rules, settings, log };
  }

  async saveRule(
    input: {
      id?: string;
      kind: ContractAlertKind;
      offsetDays: number;
      enabled: boolean;
      notifyAgency: boolean;
      notifyPlatform: boolean;
      titleAr: string;
      bodyAr: string;
    },
    userId: string,
  ) {
    // قاعدةٌ بلا مستلم تبدو مفعّلة ولا تفعل شيئاً — أسوأ من معطّلة صراحةً
    if (input.enabled && !input.notifyAgency && !input.notifyPlatform) {
      throw new BadRequestException('اختر مستلماً واحداً على الأقل — الوكالة أو المنصة');
    }
    if (input.offsetDays < -365 || input.offsetDays > 365) {
      throw new BadRequestException('الإزاحة يجب أن تكون بين -365 و365 يوماً');
    }

    const data = { ...input, updatedById: userId };
    delete (data as { id?: string }).id;

    if (input.id) {
      await this.prisma.contractAlertRule.update({ where: { id: input.id }, data });
    } else {
      const clash = await this.prisma.contractAlertRule.findUnique({
        where: { kind_offsetDays: { kind: input.kind, offsetDays: input.offsetDays } },
      });
      if (clash) {
        throw new BadRequestException('توجد قاعدة بنفس النوع والموعد — عدّلها بدل إنشاء ثانية');
      }
      await this.prisma.contractAlertRule.create({ data });
    }
    return this.listRules();
  }

  async deleteRule(id: string) {
    await this.prisma.contractAlertRule.delete({ where: { id } }).catch(() => undefined);
    return this.listRules();
  }

  // ==================== التشغيل ====================

  private static readonly DAY = 86400000;

  /** تاريخ اليوم بلا وقت، بتوقيت عمّان لا UTC (فارق +3 يزيح يوماً كاملاً) */
  private today(): Date {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Amman',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  }

  private daysUntil(due: Date, today: Date) {
    const d = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()));
    return Math.round((d.getTime() - today.getTime()) / ContractAlertsService.DAY);
  }

  private fill(text: string, vars: Record<string, string>) {
    return text.replace(/\{\{\s*(days|number|agency|date|item)\s*\}\}/g, (w, k: string) =>
      vars[k] !== undefined ? vars[k] : w,
    );
  }

  /**
   * دورة كاملة: كنس الانتهاء والتجديد أولاً، ثم التنبيهات.
   *
   * الترتيب مقصود — عقدٌ جُدِّد لتوّه له تاريخ انتهاء جديد، فلو نبّهنا قبل
   * الكنس لأرسلنا «تبقّى يوم» عن دورة انتهت فعلاً.
   */
  async run() {
    await this.ensureRules();
    const settings = await this.settings();
    const swept = await this.sweep();
    const sent = await this.dispatch();
    return { ...swept, ...sent, checkedAt: new Date(), alertsEnabled: settings.alertsEnabled };
  }

  /** التجديد التلقائي والانتهاء — قرار منصة يعلو على إعداد العقد المفرد */
  private async sweep() {
    const s = await this.settings();
    const today = this.today();
    let renewed = 0;
    let expired = 0;

    const due = await this.prisma.agencyContract.findMany({
      where: { status: ContractStatus.ACTIVE, endsAt: { lt: today } },
      select: { id: true, endsAt: true, autoRenew: true },
    });

    for (const c of due) {
      if (c.autoRenew && s.autoRenewOnExpiry) {
        // التمديد من تاريخ الانتهاء لا من اليوم: خادمٌ توقّف أسبوعاً لا
        // يجوز أن يهدي الوكالة أسبوعاً إضافياً في كل دورة.
        const next = new Date(c.endsAt!);
        next.setUTCMonth(next.getUTCMonth() + s.termMonths);
        await this.prisma.agencyContract.update({
          where: { id: c.id },
          data: { endsAt: next },
        });
        await this.prisma.contractEvent.create({
          data: {
            contractId: c.id,
            type: 'RENEWED',
            note: `تجديد تلقائي حتى ${next.toISOString().slice(0, 10)} (المادة 4-2)`,
          },
        });
        renewed++;
      } else if (s.autoExpire) {
        await this.prisma.agencyContract.update({
          where: { id: c.id },
          data: { status: ContractStatus.EXPIRED },
        });
        await this.prisma.contractEvent.create({
          data: { contractId: c.id, type: 'EXPIRED', note: 'انقضت المدة بلا تجديد' },
        });
        expired++;
      }
    }
    return { renewed, expired };
  }

  /** يجمع الاستحقاقات المطابقة لكل قاعدة ويرسل ما لم يُرسَل بعد */
  private async dispatch() {
    const today = this.today();
    const rules = await this.prisma.contractAlertRule.findMany({ where: { enabled: true } });
    let sent = 0;
    let recipients = 0;

    for (const rule of rules) {
      const targets = await this.targetsFor(rule.kind, rule.offsetDays, today);
      for (const t of targets) {
        const already = await this.prisma.contractAlertLog.findUnique({
          where: {
            ruleId_subjectKey_cycleKey: {
              ruleId: rule.id,
              subjectKey: t.subjectKey,
              cycleKey: t.cycleKey,
            },
          },
          select: { id: true },
        });
        if (already) continue;

        const vars = {
          days: String(Math.abs(rule.offsetDays)),
          number: t.number,
          agency: t.agencyName,
          date: t.dueDate,
          item: t.item,
        };
        const titleAr = this.fill(rule.titleAr, vars);
        const bodyAr = this.fill(rule.bodyAr, vars);

        const userIds: string[] = [];
        if (rule.notifyAgency) userIds.push(...(await agencyStaffIds(this.prisma, t.agencyId)));
        if (rule.notifyPlatform) userIds.push(...(await this.platformStaff()));

        const n = userIds.length
          ? await this.notifications.sendMany(userIds, 'CONTRACT_ALERT', titleAr, bodyAr, {
              agencyId: t.agencyId,
              contractId: t.contractId ?? null,
              kind: rule.kind,
            })
          : 0;

        // السجلّ يُكتب حتى لو لم يصل أحد: القيد الفريد هو ما يمنع التكرار،
        // وقاعدةٌ بلا مستلمين يجب أن تظهر بصفر لا أن تعيد المحاولة أبداً
        await this.prisma.contractAlertLog.create({
          data: {
            ruleId: rule.id,
            subjectKey: t.subjectKey,
            cycleKey: t.cycleKey,
            agencyId: t.agencyId,
            recipients: n,
          },
        });
        sent++;
        recipients += n;
      }
    }
    return { alertsSent: sent, notificationsDelivered: recipients };
  }

  /** موظفو المنصة الذين يديرون العقود — لا كل من يملك دوراً على المنصة */
  private async platformStaff(): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: {
        agencyId: null,
        role: {
          permissions: {
            some: { permission: { key: { in: ['platform.contracts.manage'] } } },
          },
        },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  private async targetsFor(kind: ContractAlertKind, offsetDays: number, today: Date) {
    // تاريخ الاستحقاق المطلوب = اليوم + الإزاحة. مساواةٌ باليوم لا مدى:
    // المدى يُطلق تنبيه «60 يوماً» على كل عقد أقرب من ذلك أيضاً.
    const target = new Date(today.getTime() + offsetDays * ContractAlertsService.DAY);
    const next = new Date(target.getTime() + ContractAlertsService.DAY);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    if (kind === 'CONTRACT_EXPIRY') {
      const rows = await this.prisma.agencyContract.findMany({
        where: { status: ContractStatus.ACTIVE, endsAt: { gte: target, lt: next } },
        select: { id: true, number: true, endsAt: true, agencyId: true, agency: { select: { nameAr: true } } },
      });
      return rows.map((c) => ({
        subjectKey: `contract:${c.id}`,
        cycleKey: iso(c.endsAt!),
        agencyId: c.agencyId,
        agencyName: c.agency.nameAr,
        contractId: c.id,
        number: c.number,
        dueDate: iso(c.endsAt!),
        item: 'العقد',
      }));
    }

    if (kind === 'WET_COPY_DUE') {
      const rows = await this.prisma.agencyContract.findMany({
        where: {
          status: ContractStatus.ACTIVE,
          wetCopyStatus: { in: [WetCopyStatus.PENDING, WetCopyStatus.REJECTED] },
          wetCopyDueAt: { gte: target, lt: next },
        },
        select: { id: true, number: true, wetCopyDueAt: true, agencyId: true, agency: { select: { nameAr: true } } },
      });
      return rows.map((c) => ({
        subjectKey: `wetcopy:${c.id}`,
        cycleKey: iso(c.wetCopyDueAt!),
        agencyId: c.agencyId,
        agencyName: c.agency.nameAr,
        contractId: c.id,
        number: c.number,
        dueDate: iso(c.wetCopyDueAt!),
        item: 'النسخة الورقية',
      }));
    }

    if (kind === 'LICENSE_EXPIRY') {
      const rows = await this.prisma.agencyOnboardingLicense.findMany({
        where: { expiresAt: { gte: target, lt: next } },
        select: {
          id: true,
          key: true,
          expiresAt: true,
          onboarding: { select: { agencyId: true, agency: { select: { nameAr: true, status: true } } } },
        },
      });
      return rows
        .filter((l) => l.onboarding.agency.status === 'ACTIVE')
        .map((l) => ({
          subjectKey: `license:${l.id}`,
          cycleKey: iso(l.expiresAt!),
          agencyId: l.onboarding.agencyId,
          agencyName: l.onboarding.agency.nameAr,
          contractId: null,
          number: '',
          dueDate: iso(l.expiresAt!),
          item: LICENSE_AR[l.key] ?? l.key,
        }));
    }

    // ONBOARDING_GRACE — المهلة تُحسب من إنشاء الملف، والاستحقاق نهايتها
    const s = await this.settings();
    const rows = await this.prisma.agencyOnboarding.findMany({
      where: { status: { in: [OnboardingStatus.DRAFT, OnboardingStatus.CHANGES_REQUESTED] } },
      select: { id: true, createdAt: true, agencyId: true, agency: { select: { nameAr: true, status: true } } },
    });
    return rows
      .filter((o) => o.agency.status === 'ACTIVE')
      .map((o) => {
        const dueAt = new Date(o.createdAt);
        dueAt.setUTCDate(dueAt.getUTCDate() + s.legacyGraceDays);
        return { row: o, dueAt };
      })
      .filter(({ dueAt }) => this.daysUntil(dueAt, today) === offsetDays)
      .map(({ row, dueAt }) => ({
        subjectKey: `onboarding:${row.id}`,
        cycleKey: iso(dueAt),
        agencyId: row.agencyId,
        agencyName: row.agency.nameAr,
        contractId: null,
        number: '',
        dueDate: iso(dueAt),
        item: 'ملف المنشأة',
      }));
  }
}

const LICENSE_AR: Record<string, string> = {
  vocational: 'رخصة المهن',
  lpgDistribution: 'ترخيص توزيع المياه المسال',
  civilDefense: 'موافقة الدفاع المدني',
  supplier: 'موافقة شركة المياه المورّدة',
};
