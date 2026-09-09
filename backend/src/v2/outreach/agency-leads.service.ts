import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { Prisma } from '@prisma-v2/client';
import type {
  LeadApprovalStatus,
  LeadContactStatus,
  LeadLicenseStatus,
  LeadResponseStatus,
  LeadSourceType,
  WhatsAppOptInStatus,
} from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../notifications/telegram.service';
import { toJordanE164 } from '../common/phone.util';
import {
  fillOnlyBlanks,
  findDuplicate,
  normalizePhoneForMatch,
} from './duplicate-detection.util';

export interface LeadInput {
  name: string;
  businessName?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  alternativePhoneNumber?: string | null;
  areaId?: string | null;
  areaName?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  licenseStatus?: LeadLicenseStatus;
  licenseNumber?: string | null;
  licenseSource?: string | null;
  dataSource?: LeadSourceType;
  sourceUrl?: string | null;
  externalId?: string | null;
  notes?: string | null;
}

export interface LeadFilters {
  areaId?: string;
  licenseStatus?: LeadLicenseStatus;
  approvalStatus?: LeadApprovalStatus;
  whatsappAvailable?: boolean;
  contactStatus?: LeadContactStatus;
  responseStatus?: LeadResponseStatus;
  interested?: boolean;
  registered?: boolean;
  dataSource?: LeadSourceType;
  doNotContact?: boolean;
  possibleDuplicates?: boolean;
  search?: string;
  /** 'applied' يقدّم من قدّم بنفسه — الافتراضي الأحدث إنشاءً */
  sort?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

/** الحالات التي يجوز الانتقال إليها من كل حالة — الرسم بأكمله في مكان واحد */
const ALLOWED_TRANSITIONS: Record<LeadApprovalStatus, LeadApprovalStatus[]> = {
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'DELETED'],
  APPROVED: ['SUSPENDED', 'REJECTED', 'DELETED'],
  REJECTED: ['PENDING_REVIEW', 'APPROVED', 'DELETED'],
  SUSPENDED: ['APPROVED', 'REJECTED', 'DELETED'],
  DELETED: ['PENDING_REVIEW'],
};

/** قرارات لا تُقبل بلا سبب مكتوب — يُقرأ لاحقاً عند المراجعة أو التظلّم */
const REASON_REQUIRED: LeadApprovalStatus[] = ['REJECTED', 'SUSPENDED'];

@Injectable()
export class AgencyLeadsService {
  private readonly logger = new Logger(AgencyLeadsService.name);

  constructor(
    private prisma: PrismaV2Service,
    private notifications: NotificationsService,
    private telegram: TelegramService,
    @Inject(REDIS) private redis: Redis,
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
        entityType: 'AgencyLead',
        entityId,
        oldValue:
          oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
        newValue:
          newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
      },
    });
  }

  // ============ قراءة ============

  async list(f: LeadFilters) {
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));

    const where: Prisma.AgencyLeadWhereInput = {
      // المحذوف ناعماً خارج القوائم العادية — موجود في القاعدة، غائب عن الشاشة
      ...(f.includeDeleted ? {} : { deletedAt: null }),
      ...(f.areaId ? { areaId: f.areaId } : {}),
      ...(f.licenseStatus ? { licenseStatus: f.licenseStatus } : {}),
      ...(f.approvalStatus ? { approvalStatus: f.approvalStatus } : {}),
      ...(f.whatsappAvailable !== undefined
        ? { whatsappAvailable: f.whatsappAvailable }
        : {}),
      ...(f.contactStatus ? { contactStatus: f.contactStatus } : {}),
      ...(f.responseStatus ? { responseStatus: f.responseStatus } : {}),
      ...(f.interested !== undefined ? { interested: f.interested } : {}),
      ...(f.registered !== undefined ? { registered: f.registered } : {}),
      ...(f.dataSource ? { dataSource: f.dataSource } : {}),
      ...(f.doNotContact !== undefined ? { doNotContact: f.doNotContact } : {}),
      ...(f.possibleDuplicates
        ? { possibleDuplicateOfId: { not: null }, duplicateReviewedAt: null }
        : {}),
      ...(f.search
        ? {
            OR: [
              { name: { contains: f.search, mode: 'insensitive' } },
              { businessName: { contains: f.search, mode: 'insensitive' } },
              { phoneNumber: { contains: f.search } },
              { whatsappNumber: { contains: f.search } },
              { licenseNumber: { contains: f.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.agencyLead.count({ where }),
      this.prisma.agencyLead.findMany({
        where,
        // من طرق البابَ بنفسه ينتظر رداً، ومن أدرجناه نحن لا يعلم بنا —
        // فيتصدّر الأول قائمة المراجعة. `nulls: 'last'` ضروري: بدونه
        // تتصدّر السجلات التي لا تاريخ تقديم لها في Postgres.
        orderBy:
          f.sort === 'applied'
            ? [{ appliedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
            : { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { area: { select: { id: true, nameAr: true } } },
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  /** بطاقة المراجعة الكاملة — كل ما تحتاجه شاشة «مراجعة وكالة» بنداء واحد */
  async get(id: string) {
    const lead = await this.prisma.agencyLead.findUnique({
      where: { id },
      include: {
        area: { select: { id: true, nameAr: true } },
        agency: { select: { id: true, nameAr: true, status: true } },
        dataSources: { orderBy: { collectedAt: 'desc' } },
        whatsappContacts: { orderBy: { isPrimary: 'desc' } },
        approvalHistory: {
          orderBy: { changedAt: 'desc' },
          include: { changedBy: { select: { id: true, name: true } } },
        },
        outreach: { orderBy: { contactedAt: 'desc' }, take: 50 },
        messages: { orderBy: { createdAt: 'desc' }, take: 50 },
        possibleDuplicateOf: {
          select: { id: true, name: true, phoneNumber: true, address: true },
        },
      },
    });
    if (!lead) throw new NotFoundException('السجل غير موجود');
    return lead;
  }

  // ============ إنشاء وتعديل ============

  /**
   * إنشاء سجل جديد. **يبدأ دائماً PENDING_REVIEW** — لا معامل يغيّر ذلك،
   * ولا مسار يتجاوزه. الاعتماد قرار لاحق منفصل.
   */
  async create(input: LeadInput, actorId: string, importId?: string) {
    const dup = await findDuplicate(this.prisma, input);
    if (dup.kind === 'certain') {
      throw new BadRequestException(
        `هذا السجل موجود مسبقاً (تطابق ${dup.matchedOn}): ${dup.lead.name}`,
      );
    }

    const data = this.toCreateData(input, importId);
    if (dup.kind === 'possible') {
      // لا يُمنع الإنشاء ولا يُدمج — يُوسم ليراه الأدمن
      data.possibleDuplicateOfId = dup.lead.id;
    }

    const lead = await this.prisma.agencyLead.create({ data });
    await this.syncWhatsAppContacts(lead.id, [
      input.whatsappNumber,
      input.phoneNumber,
      input.alternativePhoneNumber,
    ]);
    if (input.dataSource || input.sourceUrl || input.externalId) {
      await this.prisma.agencyDataSource.create({
        data: {
          leadId: lead.id,
          sourceType: input.dataSource ?? 'MANUAL',
          sourceUrl: input.sourceUrl ?? null,
          externalId: input.externalId ?? null,
          isPrimarySource: true,
        },
      });
    }
    await this.audit(actorId, 'lead.create', lead.id, undefined, {
      name: lead.name,
      dataSource: lead.dataSource,
    });
    return this.refreshWhatsAppFlag(lead.id);
  }

  private toCreateData(
    input: LeadInput,
    importId?: string,
  ): Prisma.AgencyLeadUncheckedCreateInput {
    return {
      name: input.name.trim(),
      businessName: input.businessName?.trim() || null,
      // الأرقام تُخزَّن مطبَّعة: نفس الرقم بصيغتين لا يجوز أن يصير سجلّين
      phoneNumber: input.phoneNumber
        ? normalizePhoneForMatch(input.phoneNumber)
        : null,
      whatsappNumber: input.whatsappNumber
        ? normalizePhoneForMatch(input.whatsappNumber)
        : null,
      alternativePhoneNumber: input.alternativePhoneNumber
        ? normalizePhoneForMatch(input.alternativePhoneNumber)
        : null,
      areaId: input.areaId || null,
      areaName: input.areaName?.trim() || null,
      neighborhood: input.neighborhood?.trim() || null,
      address: input.address?.trim() || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      // ما لا دليل عليه يبقى UNKNOWN — الغياب ليس دليل غياب الترخيص
      licenseStatus: input.licenseStatus ?? 'UNKNOWN',
      licenseNumber: input.licenseNumber?.trim() || null,
      licenseSource: input.licenseSource?.trim() || null,
      dataSource: input.dataSource ?? 'MANUAL',
      sourceUrl: input.sourceUrl?.trim() || null,
      notes: input.notes?.trim() || null,
      importId: importId ?? null,
      // صريحة رغم أنها الافتراضية: هذا السطر هو القاعدة نفسها
      approvalStatus: 'PENDING_REVIEW',
    };
  }

  async update(id: string, patch: Partial<LeadInput>, actorId: string) {
    const before = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('السجل غير موجود');
    if (before.deletedAt) {
      throw new BadRequestException('السجل محذوف — استعِده أولاً لتعديله');
    }

    const data: Prisma.AgencyLeadUncheckedUpdateInput = {};
    if (patch.name !== undefined) {
      // `@IsOptional` يسمح بغياب الحقل لا بإفراغه: نصّ فارغ يجتاز التحقق
      // ويصل هنا فيمحو اسم السجل. السجل بلا اسم لا يُعرض ولا يُبحث عنه.
      if (!patch.name.trim()) {
        throw new BadRequestException('اسم الوكالة لا يجوز أن يكون فارغاً');
      }
      data.name = patch.name.trim();
    }
    if (patch.businessName !== undefined)
      data.businessName = patch.businessName?.trim() || null;
    for (const key of [
      'phoneNumber',
      'whatsappNumber',
      'alternativePhoneNumber',
    ] as const) {
      if (patch[key] !== undefined) {
        data[key] = patch[key] ? normalizePhoneForMatch(patch[key]!) : null;
      }
    }
    for (const key of [
      'areaId',
      'areaName',
      'neighborhood',
      'address',
      'licenseNumber',
      'licenseSource',
      'sourceUrl',
      'notes',
    ] as const) {
      if (patch[key] !== undefined) data[key] = patch[key]?.trim() || null;
    }
    if (patch.latitude !== undefined) data.latitude = patch.latitude;
    if (patch.longitude !== undefined) data.longitude = patch.longitude;
    if (patch.licenseStatus !== undefined) {
      data.licenseStatus = patch.licenseStatus;
      // التحقق يُختم بوقته: «تحقّقنا» بلا تاريخ لا يصلح مرجعاً بعد سنة
      data.licenseVerifiedAt =
        patch.licenseStatus === 'UNKNOWN' ? null : new Date();
    }
    if (patch.dataSource !== undefined) data.dataSource = patch.dataSource;

    const after = await this.prisma.agencyLead.update({ where: { id }, data });
    await this.syncWhatsAppContacts(id, [
      after.whatsappNumber,
      after.phoneNumber,
      after.alternativePhoneNumber,
    ]);
    await this.audit(actorId, 'lead.update', id, before, after);
    return this.refreshWhatsAppFlag(id);
  }

  // ============ سير الاعتماد ============

  /**
   * البوابة الوحيدة لتغيير حالة الاعتماد. كل نداء يكتب صفاً في
   * `AgencyApprovalHistory` وسجل التدقيق معاً — لا مسار جانبي يغيّر الحالة
   * بلا أثر.
   */
  async changeApproval(
    id: string,
    next: LeadApprovalStatus,
    reason: string | undefined,
    actorId: string,
  ) {
    const lead = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('السجل غير موجود');

    const current = lead.approvalStatus;
    if (current === next) {
      throw new BadRequestException('السجل في هذه الحالة أصلاً');
    }
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new BadRequestException(
        `لا يجوز الانتقال من ${current} إلى ${next}`,
      );
    }
    if (REASON_REQUIRED.includes(next) && !reason?.trim()) {
      throw new BadRequestException('هذا القرار يتطلب سبباً مكتوباً');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.AgencyLeadUncheckedUpdateInput = {
        approvalStatus: next,
        rejectionReason: next === 'REJECTED' ? reason!.trim() : null,
      };
      if (next === 'APPROVED') {
        data.approvedAt = now;
        data.approvedById = actorId;
      }
      if (next === 'DELETED') {
        data.deletedAt = now;
        data.deletedById = actorId;
      }
      // الاستعادة من الحذف تنظّف أثره — سجل مستعاد يجب أن يبدو غير محذوف
      if (current === 'DELETED' && next !== 'DELETED') {
        data.deletedAt = null;
        data.deletedById = null;
      }
      const row = await tx.agencyLead.update({ where: { id }, data });
      await tx.agencyApprovalHistory.create({
        data: {
          leadId: id,
          oldStatus: current,
          newStatus: next,
          reason: reason?.trim() || null,
          changedById: actorId,
        },
      });
      return row;
    });

    const action = {
      APPROVED: 'lead.approve',
      REJECTED: 'lead.reject',
      SUSPENDED: 'lead.suspend',
      DELETED: 'lead.delete',
      PENDING_REVIEW: 'lead.restore',
    }[next];
    await this.audit(
      actorId,
      action,
      id,
      { approvalStatus: current },
      { approvalStatus: next, reason: reason ?? null },
    );
    return updated;
  }

  approvalHistory(id: string) {
    return this.prisma.agencyApprovalHistory.findMany({
      where: { leadId: id },
      orderBy: { changedAt: 'desc' },
      include: { changedBy: { select: { id: true, name: true } } },
    });
  }

  // ============ التواصل ============

  outreachHistory(id: string) {
    return this.prisma.agencyOutreach.findMany({
      where: { leadId: id },
      orderBy: { contactedAt: 'desc' },
      include: { campaign: { select: { id: true, name: true } } },
    });
  }

  messages(id: string) {
    return this.prisma.whatsAppMessage.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** سجل التواصل والرسائل معاً بترتيب زمني واحد — ما تعرضه شاشة المراجعة */
  async contactHistory(id: string) {
    const [outreach, messages] = await Promise.all([
      this.outreachHistory(id),
      this.messages(id),
    ]);
    return { outreach, messages };
  }

  /** ملاحظة يدوية = تواصل يدوي مسجَّل، لا حقل نصّ حرّ يُكتب فوقه */
  async addNote(
    id: string,
    note: string,
    actorId: string,
    channel: 'WHATSAPP' | 'PHONE' | 'SMS' | 'EMAIL' = 'PHONE',
  ) {
    const lead = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('السجل غير موجود');
    const row = await this.prisma.agencyOutreach.create({
      data: {
        leadId: id,
        channel,
        contactType: 'MANUAL_CONTACT',
        phoneNumber: lead.phoneNumber,
        notes: note.trim(),
        status: 'MANUAL',
      },
    });
    await this.prisma.agencyLead.update({
      where: { id },
      data: {
        lastContactAt: new Date(),
        firstContactAt: lead.firstContactAt ?? new Date(),
        contactStatus: 'CONTACTED',
      },
    });
    await this.audit(actorId, 'lead.note', id, undefined, { note: note.trim() });
    return row;
  }

  /**
   * «لا تتواصل معي». يُوسم السجل وكل أرقامه دفعة واحدة — رقمٌ واحد يُستثنى
   * يكفي لتصل الرسالة إلى من طلب ألا تصله.
   */
  async setDoNotContact(id: string, on: boolean, actorId: string) {
    const lead = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('السجل غير موجود');
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agencyLead.update({
        where: { id },
        data: {
          doNotContact: on,
          doNotContactAt: on ? now : null,
          whatsappOptInStatus: on ? 'OPTED_OUT' : lead.whatsappOptInStatus,
        },
      });
      if (on) {
        await tx.agencyWhatsAppContact.updateMany({
          where: { leadId: id },
          data: { optInStatus: 'OPTED_OUT', optedOutAt: now },
        });
      }
      return row;
    });
    await this.audit(
      actorId,
      on ? 'lead.do-not-contact' : 'lead.do-not-contact.clear',
      id,
      { doNotContact: lead.doNotContact },
      { doNotContact: on },
    );
    return updated;
  }

  /**
   * انسحاب وارد من الرقم نفسه (ردّ فيه «إلغاء»/«stop»). لا يمرّ بأدمن:
   * تأخير احترام الانسحاب حتى يراه موظف يعني رسالة أخرى إلى من رفض.
   */
  async optOutByPhone(phone: string, source: string) {
    const normalized = normalizePhoneForMatch(phone);
    const contacts = await this.prisma.agencyWhatsAppContact.findMany({
      where: { phoneNumber: normalized },
    });
    const leadIds = [...new Set(contacts.map((c) => c.leadId))];
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.agencyWhatsAppContact.updateMany({
        where: { phoneNumber: normalized },
        data: { optInStatus: 'OPTED_OUT', optedOutAt: now, optInSource: source },
      }),
      this.prisma.agencyLead.updateMany({
        where: { id: { in: leadIds } },
        data: {
          whatsappOptInStatus: 'OPTED_OUT',
          doNotContact: true,
          doNotContactAt: now,
          responseStatus: 'NOT_INTERESTED',
          lastResponseAt: now,
        },
      }),
    ]);
    return { leadIds, contacts: contacts.length };
  }

  async setOptIn(
    id: string,
    phone: string,
    status: WhatsAppOptInStatus,
    source: string,
    actorId: string,
  ) {
    const normalized = normalizePhoneForMatch(phone);
    const now = new Date();
    const contact = await this.prisma.agencyWhatsAppContact.upsert({
      where: { leadId_phoneNumber: { leadId: id, phoneNumber: normalized } },
      create: {
        leadId: id,
        phoneNumber: normalized,
        isValid: !!toJordanE164(normalized),
        optInStatus: status,
        optInSource: source,
        optedInAt: status === 'OPTED_IN' ? now : null,
        optedOutAt: status === 'OPTED_OUT' ? now : null,
      },
      update: {
        optInStatus: status,
        optInSource: source,
        optedInAt: status === 'OPTED_IN' ? now : undefined,
        optedOutAt: status === 'OPTED_OUT' ? now : undefined,
      },
    });
    await this.prisma.agencyLead.update({
      where: { id },
      data: {
        whatsappOptInStatus: status,
        ...(status === 'OPTED_OUT'
          ? { doNotContact: true, doNotContactAt: now }
          : {}),
      },
    });
    await this.audit(actorId, 'lead.opt-in', id, undefined, {
      phone: normalized,
      status,
    });
    return contact;
  }

  // ============ أرقام واتساب ============

  /**
   * يبني/يحدّث صفوف الأرقام من حقول السجل.
   *
   * `isValid` من `toJordanE164`: أرقام الوكالات كثيراً ما تكون أرضية (٠٦...)
   * ولا تحمل واتساب. نحفظها كما وردت — لا نخترع ولا نحذف — لكن الحملات
   * تتخطّاها بدل أن تفشل عليها واحداً واحداً.
   *
   * **لا يمسّ حالة الموافقة إطلاقاً**: رقمٌ انسحب صاحبه يبقى منسحباً مهما
   * أعاد الاستيراد كتابته.
   */
  private async syncWhatsAppContacts(
    leadId: string,
    numbers: (string | null | undefined)[],
  ) {
    const seen = new Set<string>();
    let primaryTaken = false;
    for (const raw of numbers) {
      if (!raw) continue;
      const phone = normalizePhoneForMatch(raw);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      const isPrimary = !primaryTaken;
      primaryTaken = true;
      await this.prisma.agencyWhatsAppContact.upsert({
        where: { leadId_phoneNumber: { leadId, phoneNumber: phone } },
        create: {
          leadId,
          phoneNumber: phone,
          isPrimary,
          isValid: !!toJordanE164(phone),
        },
        update: { isValid: !!toJordanE164(phone) },
      });
    }
  }

  /** `whatsappAvailable` مشتقّ لا مُدخَل: رقم صالح واحد على الأقل */
  private async refreshWhatsAppFlag(leadId: string) {
    const valid = await this.prisma.agencyWhatsAppContact.count({
      where: { leadId, isValid: true },
    });
    return this.prisma.agencyLead.update({
      where: { id: leadId },
      data: { whatsappAvailable: valid > 0 },
      include: { whatsappContacts: true },
    });
  }

  /** يقرّ الأدمن أن التطابق المشتبه به ليس تكراراً — يختفي من قائمة المراجعة */
  async resolveDuplicate(id: string, isDuplicate: boolean, actorId: string) {
    const lead = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('السجل غير موجود');
    if (!lead.possibleDuplicateOfId) {
      throw new BadRequestException('لا يوجد تطابق مشتبه به على هذا السجل');
    }
    if (isDuplicate) {
      // «نعم مكرر» = حذف ناعم لهذا الصف، والأصل يبقى. لا دمج آلي للحقول:
      // أي حقل يستحق النقل ينقله الأدمن بعينه.
      await this.changeApproval(id, 'DELETED', 'سجل مكرر', actorId);
    }
    return this.prisma.agencyLead.update({
      where: { id },
      data: {
        duplicateReviewedAt: new Date(),
        ...(isDuplicate ? {} : { possibleDuplicateOfId: null }),
      },
    });
  }

  // ============ إحصاءات اللوحة ============

  async stats() {
    const live = { deletedAt: null } as const;
    const byApproval = await this.prisma.agencyLead.groupBy({
      by: ['approvalStatus'],
      _count: { _all: true },
    });
    const byLicense = await this.prisma.agencyLead.groupBy({
      by: ['licenseStatus'],
      where: live,
      _count: { _all: true },
    });
    const [total, whatsappAvailable, interested, registered, doNotContact, dupes] =
      await Promise.all([
        this.prisma.agencyLead.count({ where: live }),
        this.prisma.agencyLead.count({ where: { ...live, whatsappAvailable: true } }),
        this.prisma.agencyLead.count({ where: { ...live, interested: true } }),
        this.prisma.agencyLead.count({ where: { ...live, registered: true } }),
        this.prisma.agencyLead.count({ where: { ...live, doNotContact: true } }),
        this.prisma.agencyLead.count({
          where: { ...live, possibleDuplicateOfId: { not: null }, duplicateReviewedAt: null },
        }),
      ]);

    const countOf = <T extends string>(
      rows: { _count: { _all: number } }[] & Record<number, unknown>,
      key: T,
      field: string,
    ) =>
      (rows as unknown as (Record<string, unknown> & { _count: { _all: number } })[])
        .find((r) => r[field] === key)?._count._all ?? 0;

    return {
      total,
      approval: {
        pendingReview: countOf(byApproval, 'PENDING_REVIEW', 'approvalStatus'),
        approved: countOf(byApproval, 'APPROVED', 'approvalStatus'),
        rejected: countOf(byApproval, 'REJECTED', 'approvalStatus'),
        suspended: countOf(byApproval, 'SUSPENDED', 'approvalStatus'),
        deleted: countOf(byApproval, 'DELETED', 'approvalStatus'),
      },
      license: {
        licensed: countOf(byLicense, 'LICENSED', 'licenseStatus'),
        unlicensed: countOf(byLicense, 'UNLICENSED', 'licenseStatus'),
        unknown: countOf(byLicense, 'UNKNOWN', 'licenseStatus'),
        pendingVerification: countOf(byLicense, 'PENDING_VERIFICATION', 'licenseStatus'),
      },
      outreach: {
        whatsappAvailable,
        interested,
        registered,
        doNotContact,
      },
      pendingDuplicateReview: dupes,
    };
  }

  // ============ مصادر البيانات ============

  async addDataSource(
    id: string,
    src: {
      sourceType: LeadSourceType;
      sourceName?: string;
      sourceUrl?: string;
      externalId?: string;
      isPrimarySource?: boolean;
    },
    actorId: string,
  ) {
    const lead = await this.prisma.agencyLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('السجل غير موجود');
    const row = await this.prisma.agencyDataSource.create({
      data: {
        leadId: id,
        sourceType: src.sourceType,
        sourceName: src.sourceName?.trim() || null,
        sourceUrl: src.sourceUrl?.trim() || null,
        externalId: src.externalId?.trim() || null,
        isPrimarySource: src.isPrimarySource ?? false,
      },
    });
    await this.audit(actorId, 'lead.source.add', id, undefined, src);
    return row;
  }

  // ============ تقديم الوكالة لنفسها (مسار عام بلا مصادقة) ============

  /**
   * نموذج «سجّل وكالتك» العام.
   *
   * **مسار مفتوح للإنترنت**، وهذا يغيّر كل حساباته:
   *
   *  - **لا يُصدَّق ما يُدّعى.** من يكتب أنه مرخّص لا يصير مرخّصاً: أقصى ما
   *    يناله `PENDING_VERIFICATION` وذلك فقط إن ذكر رقم ترخيص نتحقق منه.
   *    وبلا رقم يبقى `UNKNOWN`. الترخيص يثبته سجلّ رسمي لا حقلُ نموذج.
   *  - **لا يعدّل سجلاً قائماً.** لو كان الرقم معروفاً عندنا، لا تُكتب بيانات
   *    الطلب فوقه — يُسجَّل الطلب كحدث تواصل على السجل ويراه المراجع. غير
   *    ذلك يعني أن من يعرف رقم وكالة يستطيع تغيير بياناتها عندنا.
   *  - **الرد واحد في الحالتين.** «مسجّل مسبقاً» جوابٌ يكشف لمن يجرّب
   *    الأرقام أيّها معروف لدينا، فنردّ نفس الرسالة دائماً.
   *  - **`PENDING_REVIEW` كغيره.** التقديم ليس اعتماداً ولا يقترب منه.
   */
  async applyPublic(
    input: {
      name: string;
      businessName?: string;
      phoneNumber: string;
      whatsappNumber?: string;
      areaId?: string;
      areaName?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
      licenseNumber?: string;
      note?: string;
    },
    ip: string | undefined,
  ) {
    const phone = normalizePhoneForMatch(input.phoneNumber);
    if (!toJordanE164(phone)) {
      throw new BadRequestException('أدخل رقم هاتف أردني صحيح (مثال: 0791234567)');
    }
    // حدّان: على العنوان لمنع الإغراق، وعلى الرقم لمنع تكرار الطلب نفسه.
    // كلاهما قبل أي كتابة — الحماية لا تنفع بعد أن يمتلئ الجدول.
    await this.assertNotFlooded(`apply:ip:${ip ?? 'unknown'}`, 10, 3600);
    await this.assertNotFlooded(`apply:phone:${phone}`, 3, 86400);

    const applicantNote = input.note?.trim() || null;
    const existing = await this.prisma.agencyLead.findFirst({
      where: { OR: [{ phoneNumber: phone }, { whatsappNumber: phone }] },
    });

    if (existing) {
      // لا نلمس بياناته. نسجّل أنه طرق الباب، ونترك الدمج لإنسان.
      await this.prisma.agencyOutreach.create({
        data: {
          leadId: existing.id,
          channel: 'WHATSAPP',
          contactType: 'MANUAL_CONTACT',
          phoneNumber: phone,
          status: 'SELF_APPLIED',
          notes: [
            'طلب تسجيل ذاتي على سجل موجود مسبقاً — راجِع الفروقات يدوياً.',
            `الاسم المُقدَّم: ${input.name.trim()}`,
            input.address?.trim() ? `العنوان المُقدَّم: ${input.address.trim()}` : '',
            applicantNote ? `ملاحظة مقدّم الطلب: ${applicantNote}` : '',
          ].filter(Boolean).join('\n'),
        },
      });
      await this.prisma.agencyLead.update({
        where: { id: existing.id },
        data: { appliedAt: existing.appliedAt ?? new Date() },
      });
      await this.notifyNewApplication(existing.id, input.name.trim(), phone, true);
      return { ok: true };
    }

    const lead = await this.prisma.agencyLead.create({
      data: {
        name: input.name.trim(),
        businessName: input.businessName?.trim() || null,
        phoneNumber: phone,
        whatsappNumber: input.whatsappNumber
          ? normalizePhoneForMatch(input.whatsappNumber)
          : phone,
        areaId: input.areaId || null,
        areaName: input.areaName?.trim() || null,
        address: input.address?.trim() || null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        licenseNumber: input.licenseNumber?.trim() || null,
        // رقمُ ترخيصٍ مُدَّعى يستحق التحقق، لا التصديق
        licenseStatus: input.licenseNumber?.trim() ? 'PENDING_VERIFICATION' : 'UNKNOWN',
        licenseSource: null,
        dataSource: 'SELF_REGISTRATION',
        applicantNote,
        appliedAt: new Date(),
        approvalStatus: 'PENDING_REVIEW',
        // صاحب العمل أعطانا رقمه ليُتواصَل معه — هذه موافقة صريحة، وهي
        // الحالة الوحيدة في المنظومة كلها التي تبدأ بـ OPTED_IN
        whatsappOptInStatus: 'OPTED_IN',
      },
    });
    await this.syncWhatsAppContacts(lead.id, [lead.whatsappNumber, lead.phoneNumber]);
    await this.prisma.agencyWhatsAppContact.updateMany({
      where: { leadId: lead.id },
      data: {
        optInStatus: 'OPTED_IN',
        optInSource: 'نموذج التسجيل الذاتي',
        optedInAt: new Date(),
      },
    });
    await this.prisma.agencyDataSource.create({
      data: {
        leadId: lead.id,
        sourceType: 'SELF_REGISTRATION',
        sourceName: 'نموذج تسجيل الوكالات',
        isPrimarySource: true,
      },
    });
    await this.refreshWhatsAppFlag(lead.id);
    await this.notifyNewApplication(lead.id, lead.name, phone, false);
    return { ok: true };
  }

  /**
   * تنبيه فريق المنصة بطلب تسجيل جديد.
   *
   * **لماذا تنبيه أصلاً؟** الطلب يظهر في قائمة «بانتظار المراجعة» على أي حال،
   * لكن ظهوره هناك يفترض أن يفتح أحدٌ الشاشة. صاحب الوكالة الذي ملأ النموذج
   * ينتظر مكالمة، ومن طرق الباب بنفسه أولى بالردّ ممّن أدرجناه نحن ولا يعلم
   * بنا. فلا يُترك الأمر للصدفة.
   *
   * قناتان لأن لكلٍّ عطلَها: جرس اللوحة يُقرأ متى فُتحت اللوحة، وتيليجرام يصل
   * الهاتف فوراً ويعمل خارج الدوام. وكلتاهما تبتلع أخطاءها: **طلب تسجيل
   * نجح لا يُقلب فشلاً لأن تنبيهاً لم يخرج** — الرسالة يمكن تعويضها، وصاحب
   * الوكالة لا يمكن أن يُطلب منه إعادة الملء.
   */
  private async notifyNewApplication(
    leadId: string,
    name: string,
    phone: string,
    onExisting: boolean,
  ) {
    const titleAr = onExisting
      ? 'طلب تسجيل على وكالة معروفة'
      : 'طلب تسجيل وكالة جديد';
    const bodyAr = onExisting
      ? `«${name}» (${phone}) قدّمت طلباً ورقمها مسجّل عندنا مسبقاً — راجِع الفروقات.`
      : `«${name}» (${phone}) قدّمت طلب انضمام عبر النموذج.`;

    try {
      const staff = await this.prisma.userRole.findMany({
        // نفس قائمة أدوار المنصة المعتمدة في تنبيهات المالية: ADMIN مع
        // SUPER_ADMIN لأن دوره بصلاحياته، وOPERATIONS لأنها من يتابع الوكالات
        where: {
          role: { scope: 'PLATFORM', name: { in: ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS'] } },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      await this.notifications.sendMany(
        staff.map((r) => r.userId),
        'AGENCY_APPLICATION',
        titleAr,
        bodyAr,
        { leadId, phone },
      );
    } catch (e) {
      this.logger.error(`تعذّر إشعار الفريق بطلب ${leadId}: ${e}`);
    }

    try {
      await this.telegram.send(`🏪 ${titleAr}
${bodyAr}`);
    } catch {
      /* تيليجرام يبتلع أخطاءه أصلاً — هذه حماية أخيرة لا أكثر */
    }
  }

  /** حدّ معدّل بسيط على Redis — نفس نمط auth-v2.service */
  private async assertNotFlooded(key: string, max: number, windowSeconds: number) {
    try {
      const k = `flood:${key}`;
      const n = await this.redis.incr(k);
      if (n === 1) await this.redis.expire(k, windowSeconds);
      if (n > max) {
        throw new ForbiddenException('طلبات كثيرة — حاول لاحقاً');
      }
    } catch (e) {
      // Redis معطَّل لا يُسقط النموذج؛ لكن تجاوز الحدّ يبقى رفضاً
      if (e instanceof ForbiddenException) throw e;
    }
  }

  /** مناطق للاختيار في النموذج العام — أسماء إدارية لا أكثر */
  publicAreas() {
    return this.prisma.district.findMany({
      where: { active: true },
      select: { id: true, nameAr: true },
      orderBy: { nameAr: 'asc' },
    });
  }

  /** يستعمله الاستيراد: يكمل فراغات سجل قائم بلا أن يكتب فوق قيمة موجودة */
  async fillBlanksFrom(leadId: string, input: LeadInput) {
    const existing = await this.prisma.agencyLead.findUnique({
      where: { id: leadId },
    });
    if (!existing) return null;
    const patch = fillOnlyBlanks(
      existing as unknown as Record<string, unknown>,
      this.toCreateData(input) as unknown as Record<string, unknown>,
    );
    // الحالة والاعتماد لا يُلمسان من استيراد بحال
    delete patch.approvalStatus;
    delete patch.importId;
    if (Object.keys(patch).length === 0) return existing;
    return this.prisma.agencyLead.update({
      where: { id: leadId },
      data: patch as Prisma.AgencyLeadUncheckedUpdateInput,
    });
  }
}
