import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma-v2/client';
import type { CampaignAudienceType, CampaignStatus } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { WHATSAPP_PROVIDER, type IWhatsAppProvider } from './whatsapp-provider';
import { toJordanE164 } from '../common/phone.util';
import { normalizePhoneForMatch } from './duplicate-detection.util';
import { WhatsAppQueue } from './whatsapp.queue';

export type SkipReason =
  | 'DoNotContact'
  | 'OptedOut'
  | 'NoWhatsApp'
  | 'AlreadyContacted'
  | 'InvalidNumber'
  | 'DeletedAgency'
  | 'Other';

interface Eligible {
  kind: 'LEAD' | 'USER' | 'LIST_MEMBER';
  id: string;
  phoneNumber: string;
  /** ما تُملأ به متغيّرات القالب — يختلف مصدره باختلاف نوع المستلم */
  vars: { name: string; businessName?: string; area?: string; neighborhood?: string };
}

export interface AudienceOptions {
  /** لـMANUAL_SELECTION — قائمة صريحة يختارها الأدمن من الشاشة */
  leadIds?: string[];
  /**
   * تخطّي من سبق التواصل معه. الافتراضي `true` لأن الحملة الأولى هي الحالة
   * الشائعة؛ حملة متابعة تمرّرها `false` صراحةً.
   */
  skipPreviouslyContacted?: boolean;
}

/** تباعد بين الرسائل — أدب تعامل مع بوابة وجلسة واحدة، لا التفاف على حدّ */
const SEND_SPACING_MS = Number(process.env.WHATSAPP_SEND_SPACING_MS || 8000);

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private prisma: PrismaV2Service,
    private queue: WhatsAppQueue,
    @Inject(WHATSAPP_PROVIDER) private provider: IWhatsAppProvider,
  ) {}

  private audit(
    actorUserId: string,
    action: string,
    entityId: string,
    oldValue?: unknown,
    newValue?: unknown,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType: 'WhatsAppCampaign',
        entityId,
        oldValue:
          oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
        newValue:
          newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
      },
    });
  }

  // ============ CRUD ============

  list(status?: CampaignStatus) {
    return this.prisma.whatsAppCampaign.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, name: true } } },
    });
  }

  async get(id: string) {
    const c = await this.prisma.whatsAppCampaign.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true } },
        area: { select: { id: true, nameAr: true } },
      },
    });
    if (!c) throw new NotFoundException('الحملة غير موجودة');
    return c;
  }

  async create(
    data: {
      name: string;
      description?: string;
      templateName: string;
      templateBody: string;
      templateLanguage?: string;
      audienceType?: CampaignAudienceType;
      areaId?: string;
      listId?: string;
      metaTemplateName?: string;
      metaTemplateLang?: string;
      metaTemplateParams?: string[];
      scheduledAt?: string;
    },
    actorId: string,
  ) {
    if (!data.templateBody.trim()) {
      throw new BadRequestException('نص الرسالة مطلوب');
    }
    const c = await this.prisma.whatsAppCampaign.create({
      data: {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        templateName: data.templateName.trim(),
        templateBody: data.templateBody.trim(),
        templateLanguage: data.templateLanguage || 'ar',
        audienceType: data.audienceType ?? 'PENDING_REVIEW_ONLY',
        areaId: data.areaId || null,
        listId: data.listId || null,
        metaTemplateName: data.metaTemplateName?.trim() || null,
        metaTemplateLang: data.metaTemplateLang || 'ar',
        metaTemplateParams: data.metaTemplateParams ?? [],
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        status: data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
        createdById: actorId,
      },
    });
    await this.audit(actorId, 'campaign.create', c.id, undefined, {
      name: c.name,
      audienceType: c.audienceType,
    });
    return c;
  }

  async update(id: string, patch: Record<string, unknown>, actorId: string) {
    const before = await this.get(id);
    // حملة انطلقت لا يُعدَّل نصّها: نصفُ المستلمين قرؤوا نصاً والنصف الآخر
    // سيقرأ غيره، والسجل يقول إنهم تلقّوا الشيء نفسه.
    if (!['DRAFT', 'SCHEDULED', 'PAUSED'].includes(before.status)) {
      throw new BadRequestException(
        'لا يجوز تعديل حملة قيد التشغيل أو منتهية — أنشئ حملة جديدة',
      );
    }
    const data: Prisma.WhatsAppCampaignUncheckedUpdateInput = {};
    // الوصف وحده يقبل الإفراغ؛ البقية أعمدة غير قابلة للعدم في المخطط،
    // فنصٌّ فارغ فيها إهمالٌ لا نية — يُتجاهَل بدل أن يُكتب null يفشل.
    if (typeof patch.description === 'string') {
      data.description = patch.description.trim() || null;
    }
    for (const key of [
      'name',
      'templateName',
      'templateBody',
      'templateLanguage',
    ] as const) {
      const v = patch[key];
      if (typeof v === 'string' && v.trim()) data[key] = v.trim();
    }
    if (patch.audienceType) data.audienceType = patch.audienceType as CampaignAudienceType;
    if (patch.areaId !== undefined) data.areaId = (patch.areaId as string) || null;
    if (patch.listId !== undefined) data.listId = (patch.listId as string) || null;
    if (patch.metaTemplateName !== undefined) {
      data.metaTemplateName = (patch.metaTemplateName as string)?.trim() || null;
    }
    if (patch.metaTemplateLang) data.metaTemplateLang = patch.metaTemplateLang as string;
    if (Array.isArray(patch.metaTemplateParams)) {
      data.metaTemplateParams = patch.metaTemplateParams as string[];
    }
    if (patch.scheduledAt !== undefined) {
      data.scheduledAt = patch.scheduledAt ? new Date(patch.scheduledAt as string) : null;
    }
    const after = await this.prisma.whatsAppCampaign.update({ where: { id }, data });
    await this.audit(actorId, 'campaign.update', id, before, after);
    return after;
  }

  // ============ الأهلية ============

  /**
   * الفرز الوحيد للمستلمين — تستعمله المعاينة والبدء معاً.
   *
   * توحيدهما مقصود: معاينةٌ تحسب بقواعد وبدءٌ يحسب بغيرها تجعل المعاينة
   * كذبة مطمئنة. ما تراه في المعاينة هو ما يُدرَج بالضبط.
   */
  private async resolveAudience(
    campaign: {
      id: string;
      audienceType: CampaignAudienceType;
      areaId: string | null;
      listId: string | null;
    },
    opts: AudienceOptions,
  ): Promise<{ eligible: Eligible[]; skipped: Record<SkipReason, number>; total: number }> {
    const skipped: Record<SkipReason, number> = {
      DoNotContact: 0,
      OptedOut: 0,
      NoWhatsApp: 0,
      AlreadyContacted: 0,
      InvalidNumber: 0,
      DeletedAgency: 0,
      Other: 0,
    };

    // قائمة المنع العامة تُحمَّل مرة واحدة وتُفحص لكل مرشّح مهما كان نوعه.
    // هي المرجع الأعلى: تسبق كل اعتبار آخر ولا يعلوها استثناء.
    const optedOut = new Set(
      (await this.prisma.whatsAppOptOut.findMany({ select: { phoneNumber: true } })).map(
        (o) => o.phoneNumber,
      ),
    );
    // من دخل هذه الحملة سابقاً لا يدخلها ثانية — استئنافٌ أو ضغطُ «ابدأ» مرتين
    const alreadyInCampaign = new Set(
      (
        await this.prisma.campaignRecipient.findMany({
          where: { campaignId: campaign.id },
          select: { phoneNumber: true },
        })
      ).map((r) => r.phoneNumber),
    );
    // رقم واحد لا يتكرر داخل الدفعة نفسها ولو ورد من مصدرين
    const seen = new Set<string>();
    const eligible: Eligible[] = [];

    /** الفحوص المشتركة لكل مستلم، أياً كان مصدره */
    const accept = (e: Eligible): boolean => {
      const phone = e.phoneNumber;
      if (!phone || seen.has(phone)) return false;
      if (optedOut.has(phone)) {
        skipped.OptedOut++;
        seen.add(phone);
        return false;
      }
      if (alreadyInCampaign.has(phone)) {
        skipped.AlreadyContacted++;
        seen.add(phone);
        return false;
      }
      if (!toJordanE164(phone)) {
        skipped.InvalidNumber++;
        seen.add(phone);
        return false;
      }
      seen.add(phone);
      eligible.push(e);
      return true;
    };

    const isLeadAudience = [
      'ALL_LEADS',
      'PENDING_REVIEW_ONLY',
      'APPROVED_ONLY',
      'BY_AREA',
      'MANUAL_SELECTION',
    ].includes(campaign.audienceType);

    let total = 0;

    if (isLeadAudience) {
      const where: Prisma.AgencyLeadWhereInput = (() => {
        switch (campaign.audienceType) {
          case 'PENDING_REVIEW_ONLY':
            return { approvalStatus: 'PENDING_REVIEW' };
          case 'APPROVED_ONLY':
            return { approvalStatus: 'APPROVED' };
          case 'BY_AREA':
            if (!campaign.areaId) {
              throw new BadRequestException('حملة بالمنطقة بلا منطقة محددة');
            }
            return { areaId: campaign.areaId, approvalStatus: { not: 'DELETED' } };
          case 'MANUAL_SELECTION':
            if (!opts.leadIds?.length) {
              throw new BadRequestException('اختيار يدوي بلا سجلات مختارة');
            }
            return { id: { in: opts.leadIds } };
          default:
            return { approvalStatus: { not: 'DELETED' } };
        }
      })();

      const leads = await this.prisma.agencyLead.findMany({
        where,
        include: { whatsappContacts: true, area: { select: { nameAr: true } } },
      });
      total = leads.length;
      const skipPrevious = opts.skipPreviouslyContacted ?? true;

      for (const lead of leads) {
        // المحذوف خارج كل حملة، بما فيها الاختيار اليدوي: قائمةٌ قديمة في يد
        // الأدمن قد تحمل سجلاً حُذف بعدها
        if (lead.deletedAt || lead.approvalStatus === 'DELETED') {
          skipped.DeletedAgency++;
          continue;
        }
        if (lead.doNotContact) {
          skipped.DoNotContact++;
          continue;
        }
        if (lead.whatsappOptInStatus === 'OPTED_OUT') {
          skipped.OptedOut++;
          continue;
        }
        if (skipPrevious && lead.lastContactAt) {
          skipped.AlreadyContacted++;
          continue;
        }
        const contacts = lead.whatsappContacts.filter((c) => c.optInStatus !== 'OPTED_OUT');
        if (contacts.length === 0) {
          skipped[lead.whatsappContacts.length ? 'OptedOut' : 'NoWhatsApp']++;
          continue;
        }
        const usable =
          contacts.find((c) => c.isPrimary && c.isValid) ?? contacts.find((c) => c.isValid);
        if (!usable) {
          skipped.InvalidNumber++;
          continue;
        }
        accept({
          kind: 'LEAD',
          id: lead.id,
          phoneNumber: usable.phoneNumber,
          vars: {
            name: lead.name,
            businessName: lead.businessName ?? undefined,
            area: lead.area?.nameAr ?? lead.areaName ?? undefined,
            neighborhood: lead.neighborhood ?? undefined,
          },
        });
      }
      return { eligible, skipped, total };
    }

    if (campaign.audienceType === 'CUSTOM_LIST') {
      if (!campaign.listId) throw new BadRequestException('حملة قائمة بلا قائمة محددة');
      const members = await this.prisma.recipientListMember.findMany({
        where: { listId: campaign.listId },
      });
      total = members.length;
      for (const m of members) {
        accept({
          kind: 'LIST_MEMBER',
          id: m.id,
          phoneNumber: m.phoneNumber,
          vars: { name: m.name ?? '' },
        });
      }
      return { eligible, skipped, total };
    }

    // ---- مستخدمو المنصة ----
    //
    // الفئة تُشتقّ من الأدوار لا من حقل: الزبون هو من لا دور له إطلاقاً (كما
    // في enforceSingleDevice)، والسائق من يحمل دور DRIVER، وموظف الوكالة من
    // يحمل دور وكالة غير DRIVER، وموظف المنصة من يحمل دوراً بنطاق المنصة.
    const roleFilter: Prisma.UserWhereInput = (() => {
      switch (campaign.audienceType) {
        case 'CUSTOMERS':
          return { roles: { none: {} } };
        case 'DRIVERS':
          return { roles: { some: { role: { name: 'DRIVER' } } } };
        case 'AGENCY_STAFF':
          return {
            roles: { some: { role: { scope: 'AGENCY', name: { not: 'DRIVER' } } } },
          };
        case 'PLATFORM_STAFF':
          return { roles: { some: { role: { scope: 'PLATFORM' } } } };
        default:
          return {};
      }
    })();

    const users = await this.prisma.user.findMany({
      where: {
        ...roleFilter,
        // الموقوف لا تصله حملة، ومن لا رقم له لا يُراسَل على واتساب
        status: 'ACTIVE',
        phone: { not: null },
      },
      select: { id: true, name: true, phone: true },
    });
    total = users.length;
    for (const u of users) {
      accept({
        kind: 'USER',
        id: u.id,
        phoneNumber: u.phone!,
        vars: { name: u.name },
      });
    }
    return { eligible, skipped, total };
  }

  /** معاينة — **لا ترسل شيئاً ولا تنشئ مستلماً**، تحسب فقط */
  async preview(id: string, opts: AudienceOptions) {
    const campaign = await this.get(id);
    const { eligible, skipped, total } = await this.resolveAudience(campaign, opts);
    return {
      campaignId: id,
      totalRecipients: total,
      eligible: eligible.length,
      skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
      reasons: skipped,
      sample: eligible.slice(0, 10).map((e) => ({
        kind: e.kind,
        id: e.id,
        name: e.vars.name,
        phoneNumber: e.phoneNumber,
        preview: this.render(campaign.templateBody, e.vars),
      })),
    };
  }

  /**
   * ملء متغيّرات القالب. المتغيّر الذي لا قيمة له يُستبدل بفراغ — لا يبقى
   * `{{name}}` ظاهراً في رسالة تصل إلى إنسان.
   */
  private render(template: string, vars: Eligible['vars']): string {
    const values: Record<string, string> = {
      name: vars.name ?? '',
      businessName: vars.businessName || vars.name || '',
      area: vars.area ?? '',
      neighborhood: vars.neighborhood ?? '',
    };
    return template
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => values[k] ?? '')
      .trim();
  }

  // ============ التشغيل ============

  async start(id: string, opts: AudienceOptions, actorId: string) {
    const campaign = await this.get(id);
    if (['RUNNING', 'QUEUED'].includes(campaign.status)) {
      throw new BadRequestException('الحملة تعمل بالفعل');
    }
    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) {
      throw new BadRequestException('حملة منتهية — أنشئ حملة جديدة');
    }
    if (!campaign.templateBody.trim()) {
      throw new BadRequestException('لا نص للرسالة');
    }

    // **الرفض قبل الإطلاق لا الاكتشاف بعده.** في وضع dev تُسجَّل كل رسالة
    // «أُرسلت» بينما لا تخرج واحدة، فتظهر الحملة ناجحة في اللوحة ولا يصل
    // أحداً شيء — وهذا أسوأ من الفشل الصريح لأنه يستهلك المستلمين: يصيرون
    // «سبق التواصل معهم» فلا تعيد الحملة إليهم بعد إصلاح الإعداد.
    if (!this.provider.isConfigured()) {
      throw new BadRequestException(
        'بوابة واتساب غير مضبوطة للإرسال الحقيقي (WHATSAPP_PROVIDER ليس openwa). ' +
          'الحملة لن تخرج من الخادم — اضبط البوابة أولاً.',
      );
    }
    // Meta ترفض النصّ الحرّ كأول رسالة إلى من لم يراسلنا. اكتشاف ذلك من
    // فشل كل رسالة أسوأ من رفضٍ واحد هنا: الفشل يستهلك المستلمين.
    if (
      process.env.WHATSAPP_CAMPAIGN_PROVIDER === 'meta' &&
      !campaign.metaTemplateName
    ) {
      throw new BadRequestException(
        'القناة Meta تتطلب قالباً معتمداً — حدّد اسم القالب في الحملة قبل الإطلاق.',
      );
    }
    if ((await this.provider.getConnectionStatus()) === 'disconnected') {
      throw new BadRequestException(
        'بوابة واتساب غير متصلة — تحقّق من الجلسة قبل إطلاق الحملة.',
      );
    }

    const { eligible } = await this.resolveAudience(campaign, opts);
    if (eligible.length === 0) {
      throw new BadRequestException(
        'لا مستلم مؤهَّل — راجع المعاينة لمعرفة سبب استبعاد كلٍّ منهم',
      );
    }

    // إنشاء صفوف المستلمين أولاً، ثم الإدراج في الطابور. الترتيب مقصود:
    // القيد الفريد (campaignId, leadId) يمنع الازدواج، ومهمة بلا صفٍّ يقابلها
    // ستفشل بلا أثر — أما صفٌّ بلا مهمة فيبقى PENDING ويُستأنف.
    await this.prisma.campaignRecipient.createMany({
      data: eligible.map((e) => ({
        campaignId: id,
        kind: e.kind,
        // المعرّف يذهب إلى عموده حسب النوع — والرقم يبقى المفتاح في كل حال
        leadId: e.kind === 'LEAD' ? e.id : null,
        userId: e.kind === 'USER' ? e.id : null,
        listMemberId: e.kind === 'LIST_MEMBER' ? e.id : null,
        phoneNumber: e.phoneNumber,
        status: 'PENDING' as const,
      })),
      skipDuplicates: true,
    });

    const pending = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: 'PENDING' },
      include: {
        lead: { include: { area: { select: { nameAr: true } } } },
        user: { select: { name: true } },
        listMember: { select: { name: true } },
      },
    });

    const now = new Date();
    await this.prisma.whatsAppCampaign.update({
      where: { id },
      data: {
        status: 'RUNNING',
        startedAt: campaign.startedAt ?? now,
        totalRecipients: await this.prisma.campaignRecipient.count({
          where: { campaignId: id },
        }),
      },
    });

    await this.enqueue(id, pending);
    await this.audit(actorId, 'campaign.start', id, { status: campaign.status }, {
      status: 'RUNNING',
      queued: pending.length,
    });
    return this.get(id);
  }

  /** إدراج دفعة في الطابور بتباعد متزايد، وتعليم صفوفها QUEUED */
  private async enqueue(
    campaignId: string,
    rows: {
      id: string;
      leadId: string | null;
      phoneNumber: string;
      lead: { name: string; businessName: string | null; areaName: string | null; neighborhood: string | null; area: { nameAr: string } | null } | null;
      user: { name: string } | null;
      listMember: { name: string | null } | null;
    }[],
  ) {
    const campaign = await this.get(campaignId);
    let n = 0;
    for (const r of rows) {
      // المتغيّرات من مصدر المستلم أياً كان — النصّ نفسه يخدم الأنواع الثلاثة
      const vars: Eligible['vars'] = r.lead
        ? {
            name: r.lead.name,
            businessName: r.lead.businessName ?? undefined,
            area: r.lead.area?.nameAr ?? r.lead.areaName ?? undefined,
            neighborhood: r.lead.neighborhood ?? undefined,
          }
        : { name: r.user?.name ?? r.listMember?.name ?? '' };
      await this.queue.enqueueSend(
        {
          campaignId,
          recipientId: r.id,
          leadId: r.leadId,
          phoneNumber: r.phoneNumber,
          body: this.render(campaign.templateBody, vars),
          // القالب يُبنى هنا لا في العامل: ترتيب المتغيّرات جزء من عقد
          // القالب المعتمد، وحسابه مرة واحدة يمنع اختلافه بين مهمة وأخرى
          template: campaign.metaTemplateName
            ? {
                name: campaign.metaTemplateName,
                language: campaign.metaTemplateLang,
                params: campaign.metaTemplateParams.map(
                  (key) => (vars as Record<string, string | undefined>)[key] ?? '',
                ),
              }
            : undefined,
        },
        n * SEND_SPACING_MS,
      );
      n++;
    }
    await this.prisma.campaignRecipient.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'QUEUED', queuedAt: new Date() },
    });
    await this.prisma.whatsAppCampaign.update({
      where: { id: campaignId },
      data: { queuedCount: { increment: rows.length } },
    });
  }

  async pause(id: string, actorId: string) {
    const campaign = await this.get(id);
    if (campaign.status !== 'RUNNING') {
      throw new BadRequestException('لا يمكن إيقاف حملة غير عاملة');
    }
    // الإيقاف حقيقي لا اسمي: تُنتزع المهام التي لم تبدأ من الطابور، ويبقى
    // الحارس في العامل يمنع أي مهمة قيد التنفيذ من الإرسال بعد الإيقاف.
    const queued = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: 'QUEUED' },
      select: { id: true },
    });
    await this.queue.removePending(queued.map((q) => q.id));
    await this.prisma.campaignRecipient.updateMany({
      where: { campaignId: id, status: 'QUEUED' },
      data: { status: 'PENDING', queuedAt: null },
    });
    const after = await this.prisma.whatsAppCampaign.update({
      where: { id },
      data: { status: 'PAUSED', queuedCount: 0 },
    });
    await this.audit(actorId, 'campaign.pause', id, { status: 'RUNNING' }, { status: 'PAUSED' });
    return after;
  }

  async resume(id: string, actorId: string) {
    const campaign = await this.get(id);
    if (campaign.status !== 'PAUSED') {
      throw new BadRequestException('الحملة ليست موقوفة');
    }
    // يُستأنف ما بقي PENDING فقط. من أُرسل إليه فعلاً حالته SENT أو ما بعدها،
    // فلا يدخل هذه القائمة ولا تصله الرسالة مرتين.
    const pending = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: 'PENDING' },
      include: {
        lead: { include: { area: { select: { nameAr: true } } } },
        user: { select: { name: true } },
        listMember: { select: { name: true } },
      },
    });
    await this.prisma.whatsAppCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });
    await this.enqueue(id, pending);
    await this.audit(actorId, 'campaign.resume', id, { status: 'PAUSED' }, {
      status: 'RUNNING',
      requeued: pending.length,
    });
    return this.get(id);
  }

  async cancel(id: string, actorId: string) {
    const campaign = await this.get(id);
    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) {
      throw new BadRequestException('الحملة منتهية أصلاً');
    }
    const queued = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: { in: ['QUEUED', 'PENDING'] } },
      select: { id: true },
    });
    await this.queue.removePending(queued.map((q) => q.id));
    await this.prisma.campaignRecipient.updateMany({
      where: { campaignId: id, status: { in: ['QUEUED', 'PENDING'] } },
      data: {
        status: 'SKIPPED',
        failureCode: 'CAMPAIGN_CANCELLED',
        failureReason: 'أُلغيت الحملة قبل الإرسال',
      },
    });
    const after = await this.prisma.whatsAppCampaign.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        queuedCount: 0,
        skippedCount: { increment: queued.length },
      },
    });
    await this.audit(actorId, 'campaign.cancel', id, { status: campaign.status }, {
      status: 'CANCELLED',
      dropped: queued.length,
    });
    return after;
  }

  // ============ قراءة النتائج ============

  recipients(id: string, status?: string, page = 1, pageSize = 100) {
    return this.prisma.campaignRecipient.findMany({
      where: {
        campaignId: id,
        ...(status ? { status: status as never } : {}),
      },
      orderBy: { createdAt: 'asc' },
      skip: (Math.max(1, page) - 1) * pageSize,
      take: Math.min(500, pageSize),
      include: { lead: { select: { id: true, name: true, areaName: true } } },
    });
  }

  messages(id: string) {
    return this.prisma.whatsAppMessage.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /** الإحصاءات من العدّادات المخزَّنة، مع تفصيل حيّ لحالات المستلمين */
  async stats(id: string) {
    const campaign = await this.get(id);
    const byStatus = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: { _all: true },
    });
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        startedAt: campaign.startedAt,
        completedAt: campaign.completedAt,
      },
      counters: {
        total: campaign.totalRecipients,
        queued: campaign.queuedCount,
        sending: campaign.sendingCount,
        sent: campaign.sentCount,
        delivered: campaign.deliveredCount,
        read: campaign.readCount,
        failed: campaign.failedCount,
        replied: campaign.repliedCount,
        optedOut: campaign.optedOutCount,
        skipped: campaign.skippedCount,
      },
      recipientsByStatus: Object.fromEntries(
        byStatus.map((r) => [r.status, r._count._all]),
      ),
    };
  }

  /**
   * إعادة فتح مستلمين استُهلكوا بلا إرسال حقيقي.
   *
   * الحاجة إليها من عطلٍ وقع فعلاً: حملة أُطلقت والبوابة في وضع dev، فسُجّل
   * ٣٤ مستلماً «أُرسل إليهم» ولم تخرج رسالة. ولأنهم صاروا مستلمين في الحملة
   * فإن المعاينة تعدّهم «سبق التواصل معهم» ولا تعيدهم أبداً — فالبيانات
   * صحيحة والواقع مخالف، وإصلاح الإعداد وحده لا يكفي.
   *
   * تحذف صفوف المستلمين وتصفّر العدّادات فتعود الحملة كما لم تبدأ. لا تلمس
   * إلا حملة لم تُنتج رسالة واحدة بمعرّف من البوابة — أي التي يُرجَّح أنها
   * لم تخرج أصلاً. وجود معرّف واحد يعني أن شيئاً خرج فعلاً، وعندها الحذف
   * يمحو أثراً حقيقياً.
   */
  async resetUnsent(id: string, actorId: string) {
    const campaign = await this.get(id);
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('أوقف الحملة أولاً');
    }
    const reallySent = await this.prisma.whatsAppMessage.count({
      where: { campaignId: id, externalMessageId: { not: null } },
    });
    if (reallySent > 0) {
      throw new BadRequestException(
        `${reallySent} رسالة خرجت فعلاً من البوابة — لا يمكن تصفير حملة أُرسلت`,
      );
    }

    const [messages, recipients] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.deleteMany({ where: { campaignId: id } }),
      this.prisma.campaignRecipient.deleteMany({ where: { campaignId: id } }),
    ]);
    // سجلّ التواصل على الوكالات يُنظَّف كذلك: «تواصلنا معها» وهي لم تتلقَّ شيئاً
    await this.prisma.agencyOutreach.deleteMany({ where: { campaignId: id } });
    const after = await this.prisma.whatsAppCampaign.update({
      where: { id },
      data: {
        status: 'DRAFT',
        totalRecipients: 0,
        queuedCount: 0,
        sendingCount: 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        failedCount: 0,
        repliedCount: 0,
        optedOutCount: 0,
        skippedCount: 0,
        startedAt: null,
        completedAt: null,
      },
    });
    await this.audit(actorId, 'campaign.reset', id, undefined, {
      recipientsRemoved: recipients.count,
      messagesRemoved: messages.count,
    });
    return { ok: true, recipientsRemoved: recipients.count };
  }

  /**
   * تُنادى بعد كل مهمة: هل بقي شيء؟ إن لم يبقَ، الحملة انتهت.
   *
   * الحملة الموقوفة لا تُغلَق بهذا — لها مستلمون PENDING ينتظرون استئنافها.
   */
  async completeIfDone(campaignId: string) {
    const remaining = await this.prisma.campaignRecipient.count({
      where: {
        campaignId,
        status: { in: ['PENDING', 'QUEUED', 'SENDING'] },
      },
    });
    if (remaining > 0) return;
    const campaign = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign || campaign.status !== 'RUNNING') return;
    await this.prisma.whatsAppCampaign.update({
      where: { id: campaignId },
      data: { status: 'COMPLETED', completedAt: new Date(), queuedCount: 0 },
    });
    this.logger.log(`اكتملت الحملة ${campaignId}`);
  }
}
