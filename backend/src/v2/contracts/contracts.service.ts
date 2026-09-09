import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { Prisma } from '@prisma-v2/client';
import { ContractStatus, OnboardingStatus, WetCopyStatus } from '@prisma-v2/client';
import { verifyPassword } from '../auth/password.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { StorageService } from '../storage/storage.service';
import {
  REQUIRED_KEYS,
  VARIABLES,
  VARIABLE_KEYS,
  extractPlaceholders,
  fillTemplate,
} from './contract.catalog';
import {
  CONTRACT_TEMPLATE_V1_BODY,
  CONTRACT_TEMPLATE_V1_TITLE,
} from './contract-template.v1';
import { ContractDoc, SignatureBlock, renderContract } from './contract.render';

const STATUS_AR: Record<ContractStatus, string> = {
  DRAFT: 'مسودّة',
  PENDING_AGENCY: 'بانتظار توقيع الوكالة',
  PENDING_PLATFORM: 'بانتظار توقيع المنصة',
  ACTIVE: 'سارٍ',
  EXPIRED: 'منتهٍ',
  TERMINATED: 'مُنهى',
  CANCELLED: 'ملغى',
};

const ENTITY_AR: Record<string, string> = {
  SOLE_ESTABLISHMENT: 'مؤسسة فردية',
  LLC: 'شركة ذات مسؤولية محدودة',
};

const SIGNER_ROLE_AR: Record<string, string> = {
  OWNER: 'مالك',
  GENERAL_MANAGER: 'مدير عام',
  AUTHORIZED_SIGNATORY: 'مفوّض بالتوقيع',
};

/** أطول توقيع مرسوم نقبله — لوحة رسم عادية تنتج أقل من 100KB بكثير */
const MAX_SIGNATURE_BYTES = 400 * 1024;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const ALLOWED_DOC_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/** يُلغى ما لم يوقّعه أحد بعد؛ ما وُقِّع يُنهى لا يُلغى */
const CANCELLABLE: ContractStatus[] = [ContractStatus.DRAFT, ContractStatus.PENDING_AGENCY];
/** النسخة الورقية تُرفع بعد التوقيع الإلكتروني لا قبله */
const WET_COPY_STAGE: ContractStatus[] = [
  ContractStatus.ACTIVE,
  ContractStatus.PENDING_PLATFORM,
];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const dateAr = (d?: Date | null) =>
  d ? new Date(d).toLocaleDateString('ar-JO', { dateStyle: 'long' }) : '—';
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private prisma: PrismaV2Service,
    private storage: StorageService,
  ) {}

  // ==================== الإعدادات ====================

  /** صفٌّ واحد يُنشأ عند أول قراءة — كـInvoiceSettings */
  async settings() {
    return this.prisma.contractSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  async updateSettings(dto: Prisma.ContractSettingsUpdateInput) {
    await this.settings();
    return this.prisma.contractSettings.update({ where: { id: 1 }, data: dto });
  }

  // ==================== القوالب ====================

  /** يزرع النسخة الأولى إن لم يكن هناك قالب — مرة واحدة في عمر النظام */
  async ensureTemplate() {
    const any = await this.prisma.contractTemplate.findFirst();
    if (any) return;
    await this.prisma.contractTemplate.create({
      data: {
        version: 1,
        titleAr: CONTRACT_TEMPLATE_V1_TITLE,
        bodyHtml: CONTRACT_TEMPLATE_V1_BODY,
        isActive: true,
        notesAr: 'النسخة الأولى — النص كما ورد من الطرف الأول',
      },
    });
  }

  async listTemplates() {
    await this.ensureTemplate();
    return this.prisma.contractTemplate.findMany({
      orderBy: { version: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { contracts: true } },
      },
    });
  }

  async getTemplate(id: string) {
    const t = await this.prisma.contractTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('القالب غير موجود');
    return t;
  }

  /**
   * حفظ قالب. القالب المقفل (وُلِّد منه عقد) لا يُعدَّل — يُنسَخ إلى نسخة
   * جديدة. وهذا هو السبب الذي من أجله يوجد رقم نسخة أصلاً.
   */
  async saveTemplate(
    input: { id?: string; titleAr: string; bodyHtml: string; notesAr?: string; activate?: boolean },
    userId: string,
  ) {
    const unknown = extractPlaceholders(input.bodyHtml).filter((k) => !VARIABLE_KEYS.has(k));
    if (unknown.length) {
      // قالبٌ فيه متغيّر مجهول يُنتج عقداً مطبوعاً فيه {{...}} أمام من يوقّعه
      throw new BadRequestException(
        `متغيّرات غير معروفة في القالب: ${unknown.map((k) => `{{${k}}}`).join('، ')}`,
      );
    }

    if (input.id) {
      const existing = await this.getTemplate(input.id);
      if (!existing.isLocked) {
        const updated = await this.prisma.contractTemplate.update({
          where: { id: input.id },
          data: {
            titleAr: input.titleAr,
            bodyHtml: input.bodyHtml,
            notesAr: input.notesAr ?? null,
          },
        });
        if (input.activate) await this.activateTemplate(updated.id);
        return updated;
      }
    }

    const max = await this.prisma.contractTemplate.aggregate({ _max: { version: true } });
    const created = await this.prisma.contractTemplate.create({
      data: {
        version: (max._max.version ?? 0) + 1,
        titleAr: input.titleAr,
        bodyHtml: input.bodyHtml,
        notesAr: input.notesAr ?? null,
        createdById: userId,
      },
    });
    if (input.activate) await this.activateTemplate(created.id);
    return created;
  }

  /** قالب فعّال واحد لا أكثر — وإلا لم يُعرف من أين يُولَّد العقد التالي */
  async activateTemplate(id: string) {
    await this.getTemplate(id);
    await this.prisma.$transaction([
      this.prisma.contractTemplate.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      }),
      this.prisma.contractTemplate.update({ where: { id }, data: { isActive: true } }),
    ]);
    return this.listTemplates();
  }

  // ==================== التوليد ====================

  /** الرقم التالي بقفل الصف — أرقام متتابعة بلا ثقوب ولا تكرار */
  private async nextNumber(tx: Prisma.TransactionClient) {
    const s = await tx.contractSettings.update({
      where: { id: 1 },
      data: { nextSequence: { increment: 1 } },
    });
    const seq = s.nextSequence - 1;
    return `${s.numberPrefix}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  }

  /**
   * توليد عقد لوكالة.
   *
   * البوابة: ملف منشأة معتمد. توليد عقد ببيانات لم تُراجَع يعني أن أحدهم
   * سيطبع عقداً برقم ضريبي خاطئ ويوقّعه ويختمه — وإعادة التوقيع أغلى من
   * المراجعة قبل التوليد بكثير.
   */
  async generate(
    agencyId: string,
    opts: { subscriptionMonthly?: number | null; exempt?: boolean; serviceAreaAr?: string },
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    await this.ensureTemplate();
    const settings = await this.settings();

    if (!settings.jurisdictionClauseAr?.trim()) {
      throw new BadRequestException(
        'المادة 38-3 (جهة فض النزاع) فارغة في إعدادات العقود — لا يُولَّد عقد بمادة ناقصة. اضبطها أولاً.',
      );
    }
    const missingIdentity = (
      [
        ['platformNationalNo', 'الرقم الوطني للمنصة'],
        ['platformRegistryNo', 'السجل التجاري للمنصة'],
        ['platformTaxNumber', 'الرقم الضريبي للمنصة'],
        ['platformAddressAr', 'عنوان المنصة'],
        ['platformSignerName', 'المفوّض بالتوقيع عن المنصة'],
        ['platformSignerRole', 'صفة المفوّض عن المنصة'],
      ] as const
    ).filter(([k]) => !String((settings as Record<string, unknown>)[k] ?? '').trim());
    if (missingIdentity.length) {
      throw new BadRequestException([
        'هوية الطرف الأول ناقصة في إعدادات العقود:',
        ...missingIdentity.map(([, label]) => label),
      ]);
    }

    const template = await this.prisma.contractTemplate.findFirst({ where: { isActive: true } });
    if (!template) throw new BadRequestException('لا يوجد قالب عقد مفعَّل');

    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      include: {
        onboarding: true,
        branches: { where: { isMain: true }, take: 1 },
        _count: { select: { drivers: true } },
      },
    });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');

    const ob = agency.onboarding;
    if (!ob || ob.status !== OnboardingStatus.APPROVED) {
      throw new BadRequestException(
        'لا يُولَّد العقد قبل اعتماد ملف المنشأة — المراجعة قبل التوليد أرخص من إعادة التوقيع',
      );
    }

    const open = await this.prisma.agencyContract.findFirst({
      where: {
        agencyId,
        status: { in: [ContractStatus.DRAFT, ContractStatus.PENDING_AGENCY, ContractStatus.PENDING_PLATFORM, ContractStatus.ACTIVE] },
      },
      select: { id: true, number: true, status: true },
    });
    if (open) {
      throw new BadRequestException(
        `للوكالة عقد قائم بالفعل (${open.number} — ${STATUS_AR[open.status]}). أنهِه أو ألغِه قبل توليد عقد جديد.`,
      );
    }

    const exempt = opts.exempt === true || !agency.subscriptionEnabled;
    const subscription = exempt
      ? null
      : (opts.subscriptionMonthly ??
        (agency.subscriptionMonthlyPriceOverride
          ? Number(agency.subscriptionMonthlyPriceOverride)
          : null));
    if (!exempt && (subscription === null || subscription === undefined)) {
      throw new BadRequestException(
        'حدّد الاشتراك الشهري لهذه الوكالة أو علّمها معفاة — المادة 16 لا تُطبع فارغة',
      );
    }

    const branch = agency.branches[0];
    const address = [
      ob.addrGovernorate,
      ob.addrDistrict,
      ob.addrNeighborhood,
      ob.addrStreet,
      ob.addrBuildingNo ? `بناية ${ob.addrBuildingNo}` : null,
    ]
      .filter(Boolean)
      .join(' — ');

    const today = dayStart(new Date());
    const values: Record<string, string> = {
      'contract.number': '', // يُملأ داخل المعاملة بعد حجز الرقم
      'contract.date': dateAr(today),
      'contract.startsAt': 'يبدأ من تاريخ التفعيل',
      'contract.endsAt': `بعد ${settings.termMonths} شهرًا من تاريخ التفعيل`,

      'platform.legalName': settings.platformLegalNameAr,
      'platform.entityType': settings.platformEntityTypeAr || '—',
      'platform.nationalNo': settings.platformNationalNo!,
      'platform.registryNo': settings.platformRegistryNo!,
      'platform.taxNumber': settings.platformTaxNumber!,
      'platform.address': settings.platformAddressAr!,
      'platform.signerName': settings.platformSignerName!,
      'platform.signerRole': settings.platformSignerRole!,

      'agency.legalName': ob.legalNameAr || agency.nameAr,
      'agency.entityType': ENTITY_AR[ob.entityType ?? ''] || '—',
      'agency.nationalNo': ob.nationalEstablishmentNo || '—',
      'agency.registryNo': ob.commercialRegistryNo || '—',
      'agency.taxNumber': ob.taxNumber || 'لا يوجد',
      'agency.address': address || '—',
      'agency.signerName': ob.signerName || '—',
      'agency.signerRole': SIGNER_ROLE_AR[ob.signerRole ?? ''] || ob.signerRole || '—',
      'agency.tradeName': agency.nameAr,

      'terms.termMonths': String(settings.termMonths),
      'terms.renewNoticeDays': String(settings.renewNoticeDays),
      'terms.terminationNoticeDays': String(settings.terminationNoticeDays),
      'terms.commissionNoticeDays': String(settings.commissionNoticeDays),
      'terms.legacyGraceDays': String(settings.legacyGraceDays),
      'terms.wetCopyDueDays': String(settings.wetCopyDueDays),
      'terms.jurisdiction': settings.jurisdictionClauseAr!,
      'terms.stampDuty': settings.stampDutyEnabled ? (settings.stampDutyNoteAr || '') : '',

      'deal.subscription': exempt ? 'معفاة من الاشتراك' : `${subscription!.toFixed(2)} دينار أردني`,
      'deal.subscriptionBox': exempt
        ? '[ ] خاضعًا للاشتراك&nbsp;&nbsp;&nbsp;&nbsp;[✓] معفًى من الاشتراك'
        : '[✓] خاضعًا للاشتراك&nbsp;&nbsp;&nbsp;&nbsp;[ ] معفًى من الاشتراك',
      'deal.branchName': branch?.nameAr || agency.nameAr,
      'deal.serviceArea': opts.serviceAreaAr?.trim() || 'وفق التغطية المسجّلة على المنصة',
      'deal.driversCount': String(agency._count.drivers),
      'deal.verificationStatus': 'ملف المنشأة معتمد',
    };

    const stillMissing = REQUIRED_KEYS.filter((k) => !String(values[k] ?? '').trim() && k !== 'contract.number');
    if (stillMissing.length) {
      throw new BadRequestException([
        'بيانات ناقصة تمنع توليد العقد:',
        ...stillMissing,
      ]);
    }

    return this.prisma.$transaction(async (tx) => {
      const number = await this.nextNumber(tx);
      values['contract.number'] = number;

      // `deal.subscriptionBox` يحمل كيانات HTML مقصودة، والتعبئة تهرّب كل
      // قيمة — فيُحقن بعدها مباشرةً بلا تهريب، وهو نصّ من عندنا لا من مُدخِل.
      const box = values['deal.subscriptionBox'];
      const filled = fillTemplate(template.bodyHtml, { ...values, 'deal.subscriptionBox': ' BOX ' })
        .replace(' BOX ', box);

      const contentHash = sha256(filled);
      const wetCopyRequired = settings.wetCopyRequired;

      const contract = await tx.agencyContract.create({
        data: {
          agencyId,
          number,
          templateId: template.id,
          templateVersion: template.version,
          status: ContractStatus.DRAFT,
          contractDate: today,
          autoRenew: true,
          subscriptionMonthly: exempt ? null : subscription,
          serviceAreaAr: values['deal.serviceArea'],
          branchNameAr: values['deal.branchName'],
          renderedHtml: filled,
          contentHash,
          wetCopyStatus: wetCopyRequired ? WetCopyStatus.PENDING : WetCopyStatus.NOT_REQUIRED,
          createdById: userId,
        },
      });

      if (!template.isLocked) {
        // القالب صار مرجعاً لعقدٍ قائم — لا يُعدَّل بعدها، يُنسَخ
        await tx.contractTemplate.update({
          where: { id: template.id },
          data: { isLocked: true },
        });
      }

      await tx.contractEvent.create({
        data: {
          contractId: contract.id,
          type: 'GENERATED',
          note: `نسخة القالب ${template.version}`,
          actorId: userId,
          ip: ip?.slice(0, 60),
          userAgent: ua?.slice(0, 300),
        },
      });

      return contract;
    });
  }

  /** إرسال العقد للوكالة — يفتح باب التوقيع */
  async send(contractId: string, userId: string, ip?: string, ua?: string) {
    const c = await this.mustFind(contractId);
    if (c.status !== ContractStatus.DRAFT) {
      throw new BadRequestException('لا يُرسَل إلا عقد في حالة مسودّة');
    }
    await this.prisma.agencyContract.update({
      where: { id: contractId },
      data: { status: ContractStatus.PENDING_AGENCY },
    });
    await this.event(contractId, 'SENT', null, userId, ip, ua);
    return this.detail(contractId);
  }

  async cancel(contractId: string, note: string, userId: string, ip?: string, ua?: string) {
    const c = await this.mustFind(contractId);
    if (!CANCELLABLE.includes(c.status)) {
      throw new BadRequestException('لا يُلغى عقد وقّعه أحد الطرفين — استخدم الإنهاء');
    }
    if (!note?.trim()) throw new BadRequestException('اكتب سبب الإلغاء');
    await this.prisma.agencyContract.update({
      where: { id: contractId },
      data: { status: ContractStatus.CANCELLED },
    });
    await this.event(contractId, 'CANCELLED', note.trim(), userId, ip, ua);
    return this.detail(contractId);
  }

  async terminate(contractId: string, note: string, userId: string, ip?: string, ua?: string) {
    const c = await this.mustFind(contractId);
    if (c.status !== ContractStatus.ACTIVE) {
      throw new BadRequestException('لا يُنهى إلا عقد سارٍ');
    }
    if (!note?.trim()) throw new BadRequestException('اكتب سبب الإنهاء');
    await this.prisma.agencyContract.update({
      where: { id: contractId },
      data: {
        status: ContractStatus.TERMINATED,
        terminatedAt: new Date(),
        terminationNote: note.trim(),
      },
    });
    await this.event(contractId, 'TERMINATED', note.trim(), userId, ip, ua);
    return this.detail(contractId);
  }

  // ==================== التوقيع ====================

  /**
   * توقيع الوكالة.
   *
   * ثلاث حركات واعية لا زرّ واحد: إقرار صريح بقراءة البنود، ورسم توقيع،
   * وإعادة إدخال كلمة مرور الحساب. الأخيرة هي إثبات الهوية — الجهاز
   * المتروك مفتوحاً على مكتب لا يكفي لإبرام عقد، وهي الآلية نفسها التي
   * تحرس تغيير موقع الفرع في هذا النظام.
   *
   * (خدمة OTP من الخادم لم تعد قائمة بعد الانتقال إلى Firebase Phone Auth،
   * فالتحقق بكلمة المرور هو ما تملكه المنصة فعلاً — والمادة 27-1 تجيزه.)
   */
  async signAsAgency(
    agencyId: string,
    contractId: string,
    dto: { password: string; consent: boolean; signaturePng?: string },
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    const c = await this.mustFind(contractId);
    if (c.agencyId !== agencyId) throw new ForbiddenException('هذا العقد لوكالة أخرى');
    if (c.status !== ContractStatus.PENDING_AGENCY) {
      throw new BadRequestException(
        c.status === ContractStatus.DRAFT
          ? 'العقد لم يُرسَل بعد من المنصة'
          : 'العقد ليس بانتظار توقيعك',
      );
    }
    if (!dto.consent) {
      throw new BadRequestException('يجب الإقرار بقراءة البنود والموافقة عليها قبل التوقيع');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) throw new BadRequestException('لا كلمة مرور لهذا الحساب');
    if (!(await verifyPassword(dto.password, user.passwordHash))) {
      throw new ForbiddenException('كلمة المرور غير صحيحة');
    }

    const signature = this.decodeSignature(dto.signaturePng);
    const ob = await this.prisma.agencyOnboarding.findUnique({ where: { agencyId } });
    const signatureImageKey = await this.storeSignature(signature);

    await this.prisma.$transaction([
      this.prisma.contractSignature.upsert({
        where: { contractId_side: { contractId, side: 'AGENCY' } },
        create: {
          contractId,
          side: 'AGENCY',
          signerUserId: userId,
          signerName: ob?.signerName || user.name,
          signerRole: SIGNER_ROLE_AR[ob?.signerRole ?? ''] || ob?.signerRole || null,
          signerPhone: ob?.signerPhone || user.phone,
          signatureImageKey,
          verificationMethod: 'PASSWORD',
          verifiedAt: new Date(),
          documentHash: c.contentHash,
          ip: ip?.slice(0, 60),
          userAgent: ua?.slice(0, 300),
        },
        update: {
          signatureImageKey,
          verifiedAt: new Date(),
          documentHash: c.contentHash,
          signedAt: new Date(),
          ip: ip?.slice(0, 60),
          userAgent: ua?.slice(0, 300),
        },
      }),
      this.prisma.agencyContract.update({
        where: { id: contractId },
        data: { status: ContractStatus.PENDING_PLATFORM },
      }),
    ]);

    await this.event(contractId, 'SIGNED_AGENCY', null, userId, ip, ua);
    return this.agencyView(agencyId);
  }

  /**
   * التوقيع المقابل من المنصة — وبه يصير العقد سارياً وتبدأ المدة.
   *
   * المدة تبدأ من هنا لا من التوليد: عقدٌ عُدّت أيامه وهو ينتظر توقيعاً
   * يخسر الوكالة أياماً لم تحصل فيها على شيء.
   */
  async signAsPlatform(
    contractId: string,
    dto: { password: string; consent: boolean; signaturePng?: string },
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    const c = await this.mustFind(contractId);
    if (c.status !== ContractStatus.PENDING_PLATFORM) {
      throw new BadRequestException('العقد ليس بانتظار توقيع المنصة');
    }
    if (!dto.consent) throw new BadRequestException('يجب الإقرار قبل التوقيع');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) throw new BadRequestException('لا كلمة مرور لهذا الحساب');
    if (!(await verifyPassword(dto.password, user.passwordHash))) {
      throw new ForbiddenException('كلمة المرور غير صحيحة');
    }

    const settings = await this.settings();
    const signature = this.decodeSignature(dto.signaturePng);
    const signatureImageKey = await this.storeSignature(signature);
    const startsAt = dayStart(new Date());
    const endsAt = new Date(startsAt);
    endsAt.setUTCMonth(endsAt.getUTCMonth() + settings.termMonths);

    const wetDue = new Date(startsAt);
    wetDue.setUTCDate(wetDue.getUTCDate() + settings.wetCopyDueDays);

    await this.prisma.$transaction([
      this.prisma.contractSignature.upsert({
        where: { contractId_side: { contractId, side: 'PLATFORM' } },
        create: {
          contractId,
          side: 'PLATFORM',
          signerUserId: userId,
          signerName: settings.platformSignerName || user.name,
          signerRole: settings.platformSignerRole,
          signerPhone: user.phone,
          signatureImageKey,
          verificationMethod: 'PLATFORM_STAFF',
          verifiedAt: new Date(),
          documentHash: c.contentHash,
          ip: ip?.slice(0, 60),
          userAgent: ua?.slice(0, 300),
        },
        update: {
          signatureImageKey,
          verifiedAt: new Date(),
          documentHash: c.contentHash,
          signedAt: new Date(),
        },
      }),
      this.prisma.agencyContract.update({
        where: { id: contractId },
        data: {
          status: ContractStatus.ACTIVE,
          startsAt,
          endsAt,
          wetCopyDueAt: c.wetCopyStatus === WetCopyStatus.NOT_REQUIRED ? null : wetDue,
        },
      }),
      // **قيمة العقد تصير سعر اشتراك الوكالة.** كانت تُطبع في الوثيقة ولا
      // تصل الفوترة، فتُصدَر الفاتورة بالسعر العام ويدفع الطرفان ما لم
      // يتفقا عليه — والمكتوب في عقدٍ موقَّع هو المُلزِم لا الافتراضي.
      //
      // `null` في العقد = معفاة (المادة ١٦)، فتُطفأ الفوترة لا تُصفَّر:
      // الصفر وكالةٌ مشترِكة بسعر صفر، والإعفاء غيابُ اشتراك أصلاً.
      this.prisma.agency.update({
        where: { id: c.agencyId },
        data:
          c.subscriptionMonthly === null
            ? { subscriptionEnabled: false }
            : {
                subscriptionEnabled: true,
                subscriptionMonthlyPriceOverride: c.subscriptionMonthly,
              },
      }),
    ]);

    await this.event(contractId, 'SIGNED_PLATFORM', null, userId, ip, ua);
    return this.detail(contractId);
  }

  /** data:image/png;base64,... → بايتات، بحدّ حجم */
  private decodeSignature(dataUri?: string): Buffer | null {
    if (!dataUri) return null;
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri.trim());
    if (!m) throw new BadRequestException('صيغة التوقيع غير مدعومة — PNG فقط');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_SIGNATURE_BYTES) throw new BadRequestException('صورة التوقيع كبيرة جداً');
    if (buf.length < 100) throw new BadRequestException('ارسم توقيعك قبل الإرسال');
    return buf;
  }

  /** يرفع بايتات التوقيع إلى التخزين قبل دخول المعاملة — لا مفتاح لتوقيع غائب */
  private async storeSignature(signature: Buffer | null): Promise<string | null> {
    if (!signature) return null;
    const stored = await this.storage.put(signature, 'image/png', 'contract-signatures');
    return stored.key;
  }

  // ==================== النسخة الورقية ====================

  async uploadWetCopy(
    agencyId: string,
    contractId: string,
    file: { buffer: Buffer; mimetype: string; originalname?: string; size: number },
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    const c = await this.mustFind(contractId);
    if (c.agencyId !== agencyId) throw new ForbiddenException('هذا العقد لوكالة أخرى');
    if (c.wetCopyStatus === WetCopyStatus.NOT_REQUIRED) {
      throw new BadRequestException('النسخة الورقية غير مطلوبة لهذا العقد');
    }
    if (!WET_COPY_STAGE.includes(c.status)) {
      throw new BadRequestException('ارفع النسخة الورقية بعد توقيع العقد إلكترونياً');
    }
    if (!ALLOWED_DOC_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('صيغة غير مدعومة — PNG أو JPEG أو WebP أو PDF');
    }
    if (file.size > MAX_DOC_BYTES) throw new BadRequestException('الملف أكبر من ٨ ميغابايت');

    // الرفع إلى التخزين قبل المعاملة لا داخلها: صيغة $transaction([...])
    // مصفوفة لا تتحمّل await بين عناصرها، وطلب شبكة لمخزن خارجي لا يجوز أن
    // يطيل قفل الصفوف التي تُحدَّث داخل المعاملة.
    const previous = await this.prisma.contractDocument.findUnique({
      where: { contractId_kind: { contractId, kind: 'WET_COPY' } },
      select: { storageKey: true },
    });
    const stored = await this.storage.put(file.buffer, file.mimetype, 'contract-docs');

    const payload = {
      storageKey: stored.key,
      data: null, // الرفعات الجديدة لا تكتب بايتات في القاعدة بعد الآن
      mimeType: file.mimetype,
      fileName: file.originalname?.slice(0, 200) || null,
      sizeBytes: file.size,
      uploadedAt: new Date(),
      uploadedById: userId,
    };
    await this.prisma.$transaction([
      this.prisma.contractDocument.upsert({
        where: { contractId_kind: { contractId, kind: 'WET_COPY' } },
        create: { contractId, kind: 'WET_COPY', ...payload },
        update: payload,
      }),
      this.prisma.agencyContract.update({
        where: { id: contractId },
        // الرفع بعد رفضٍ يعيدها للطابور: إبقاؤها مرفوضة يجعل الوكالة ترفع
        // ولا يتغيّر شيء أمامها
        data: { wetCopyStatus: WetCopyStatus.UPLOADED, wetCopyRejection: null },
      }),
    ]);
    // بعد نجاح المعاملة لا قبلها — فشل حذف كائن مستبدَل لا يجوز أن يُسقط
    // رفعاً نجح فعلاً.
    if (previous?.storageKey) {
      this.storage.delete(previous.storageKey).catch((e) =>
        this.logger.warn(`تعذّر حذف نسخة ورقية قديمة ${previous.storageKey}: ${e}`),
      );
    }
    await this.event(contractId, 'WET_COPY_UPLOADED', null, userId, ip, ua);
    return this.agencyView(agencyId);
  }

  async reviewWetCopy(
    contractId: string,
    verified: boolean,
    reason: string | undefined,
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    await this.mustFind(contractId);
    if (!verified && !reason?.trim()) {
      throw new BadRequestException('اكتب سبب الرفض — بلا سبب لا تعرف الوكالة ماذا ترفع');
    }
    await this.prisma.agencyContract.update({
      where: { id: contractId },
      data: {
        wetCopyStatus: verified ? WetCopyStatus.VERIFIED : WetCopyStatus.REJECTED,
        wetCopyRejection: verified ? null : reason!.trim(),
      },
    });
    await this.event(
      contractId,
      verified ? 'WET_COPY_VERIFIED' : 'WET_COPY_REJECTED',
      reason?.trim(),
      userId,
      ip,
      ua,
    );
    return this.detail(contractId);
  }

  /**
   * `data` بالنتيجة محلولة دوماً — من storageKey إن وُجد وإلا من العمود
   * القديم — فالمستدعي لا يتغيّر رغم انتقال التخزين.
   */
  async documentBytes(contractId: string, kind: string) {
    const doc = await this.prisma.contractDocument.findUnique({
      where: { contractId_kind: { contractId, kind } },
    });
    if (!doc) throw new NotFoundException('المرفق غير موجود');
    const data = doc.storageKey ? await this.storage.get(doc.storageKey) : doc.data;
    if (!data) throw new NotFoundException('المرفق غير موجود'); // صف فاسد نظرياً فقط
    return { ...doc, data };
  }

  // ==================== العرض ====================

  /** قائمة المتغيّرات كما يعرضها محرّر القالب */
  templateVariables() {
    return VARIABLES;
  }

  /**
   * حارس ملكية: مسارات الوكالة تحمل `:agencyId`، والحارس يتحقق من الصلاحية
   * داخلها — لكنه لا يعرف أن هذا العقد بعينه يخصّها. بلا هذا الفحص يفتح
   * موظف وكالة عقد وكالة أخرى بتبديل المعرّف في العنوان.
   */
  async assertBelongsTo(contractId: string, agencyId: string) {
    const c = await this.mustFind(contractId);
    if (c.agencyId !== agencyId) throw new ForbiddenException('هذا العقد لوكالة أخرى');
    return c;
  }

  private async mustFind(id: string) {
    const c = await this.prisma.agencyContract.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('العقد غير موجود');
    return c;
  }

  /**
   * الأيام المتبقية من العقد. سالبٌ يعني انقضاءه — والفرق بين «لم يُفعَّل
   * بعد» (null) و«انتهى» (سالب) فرقٌ يهمّ من ينظر إلى الشاشة.
   */
  private remaining(endsAt: Date | null) {
    if (!endsAt) return null;
    return Math.ceil((dayStart(new Date(endsAt)).getTime() - dayStart(new Date()).getTime()) / 86400000);
  }

  private wetDueIn(c: { wetCopyDueAt: Date | null; wetCopyStatus: WetCopyStatus }) {
    if (!c.wetCopyDueAt || c.wetCopyStatus === WetCopyStatus.VERIFIED) return null;
    return Math.ceil((dayStart(new Date(c.wetCopyDueAt)).getTime() - dayStart(new Date()).getTime()) / 86400000);
  }

  /** ما تراه الوكالة: عقدها الحالي وتاريخ عقودها */
  async agencyView(agencyId: string) {
    const contracts = await this.prisma.agencyContract.findMany({
      where: { agencyId },
      orderBy: { createdAt: 'desc' },
      include: {
        signatures: { select: { side: true, signerName: true, signedAt: true } },
        documents: { select: { kind: true, fileName: true, sizeBytes: true, uploadedAt: true } },
      },
    });
    const settings = await this.settings();
    return {
      wetCopyRequired: settings.wetCopyRequired,
      wetCopyDueDays: settings.wetCopyDueDays,
      contracts: contracts.map((c) => this.publicContract(c)),
    };
  }

  private publicContract(c: {
    renderedHtml?: string;
    endsAt: Date | null;
    wetCopyDueAt: Date | null;
    wetCopyStatus: WetCopyStatus;
    status: ContractStatus;
    subscriptionMonthly: Prisma.Decimal | null;
    [k: string]: unknown;
  }) {
    // النص المُصيَّر لا يُرسَل في القوائم: عقدٌ كامل لكل صف يعني مئات
    // الكيلوبايتات لعرض جدول. له مساره الخاص.
    const { renderedHtml, ...rest } = c;
    void renderedHtml;
    return {
      ...rest,
      statusAr: STATUS_AR[c.status],
      subscriptionMonthly: c.subscriptionMonthly === null ? null : Number(c.subscriptionMonthly),
      remainingDays: this.remaining(c.endsAt),
      wetCopyDueInDays: this.wetDueIn(c),
    };
  }

  async list(params: { status?: ContractStatus; q?: string; expiringInDays?: number }) {
    const where: Prisma.AgencyContractWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.expiringInDays) {
      const until = new Date();
      until.setDate(until.getDate() + params.expiringInDays);
      where.status = ContractStatus.ACTIVE;
      where.endsAt = { lte: until };
    }
    if (params.q?.trim()) {
      const q = params.q.trim();
      where.OR = [
        { number: { contains: q, mode: 'insensitive' } },
        { agency: { nameAr: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, counts] = await Promise.all([
      this.prisma.agencyContract.findMany({
        where,
        orderBy: [{ endsAt: 'asc' }, { createdAt: 'desc' }],
        take: 300,
        select: {
          id: true,
          number: true,
          status: true,
          contractDate: true,
          startsAt: true,
          endsAt: true,
          subscriptionMonthly: true,
          wetCopyStatus: true,
          wetCopyDueAt: true,
          templateVersion: true,
          agency: { select: { id: true, nameAr: true, phone: true, status: true } },
          signatures: { select: { side: true, signedAt: true } },
        },
      }),
      this.prisma.agencyContract.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    return {
      rows: rows.map((c) => this.publicContract(c)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  async detail(id: string) {
    const c = await this.prisma.agencyContract.findUnique({
      where: { id },
      include: {
        agency: { select: { id: true, nameAr: true, phone: true, status: true } },
        template: { select: { id: true, version: true, titleAr: true } },
        createdBy: { select: { id: true, name: true } },
        signatures: {
          select: {
            side: true,
            signerName: true,
            signerRole: true,
            signerPhone: true,
            verificationMethod: true,
            verifiedAt: true,
            documentHash: true,
            ip: true,
            signedAt: true,
          },
        },
        documents: {
          select: { kind: true, fileName: true, mimeType: true, sizeBytes: true, uploadedAt: true },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { actor: { select: { id: true, name: true } } },
        },
      },
    });
    if (!c) throw new NotFoundException('العقد غير موجود');
    const { renderedHtml, ...rest } = c;
    void renderedHtml;
    return {
      ...rest,
      statusAr: STATUS_AR[c.status],
      subscriptionMonthly: c.subscriptionMonthly === null ? null : Number(c.subscriptionMonthly),
      remainingDays: this.remaining(c.endsAt),
      wetCopyDueInDays: this.wetDueIn(c),
    };
  }

  /**
   * الوثيقة المطبوعة. تُبنى من `renderedHtml` المجمَّد لا من القالب الحالي:
   * تعديل القالب بعد التوقيع لا يجوز أن يغيّر ما وقّعه أحد.
   */
  async renderHtml(id: string, actorId?: string, ip?: string, ua?: string) {
    const c = await this.prisma.agencyContract.findUnique({
      where: { id },
      include: {
        template: { select: { titleAr: true } },
        signatures: true,
        agency: { select: { nameAr: true } },
      },
    });
    if (!c) throw new NotFoundException('العقد غير موجود');

    const settings = await this.settings();
    // بايتات التوقيع تُحلّ هنا قبل بناء الكتلة — storage.get غير متزامنة،
    // وsignatureImageKey أولاً ثم العمود القديم كبقية مخازن الملفات.
    const sigBytes = async (
      s: (typeof c.signatures)[number],
    ): Promise<Buffer | null> => {
      if (s.signatureImageKey) return this.storage.get(s.signatureImageKey);
      return s.signatureImage;
    };
    const block = async (side: 'AGENCY' | 'PLATFORM'): Promise<SignatureBlock | null> => {
      const s = c.signatures.find((x) => x.side === side);
      if (!s) return null;
      const bytes = await sigBytes(s);
      return {
        sideAr: side === 'AGENCY' ? 'توقيع الطرف الثاني — الوكالة' : 'توقيع الطرف الأول — AquaGo',
        partyName: side === 'AGENCY' ? c.agency.nameAr : settings.platformLegalNameAr,
        signerName: s.signerName,
        signerRole: s.signerRole,
        signerPhone: s.signerPhone,
        signedAt: s.signedAt,
        verificationAr:
          s.verificationMethod === 'PASSWORD'
            ? 'كلمة مرور الحساب المسجّل'
            : 'موظف منصة مصادَق عليه',
        ip: s.ip,
        signatureDataUri: bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null,
      };
    };

    const [agencySignature, platformSignature] = await Promise.all([
      block('AGENCY'),
      block('PLATFORM'),
    ]);
    const doc: ContractDoc = {
      number: c.number,
      titleAr: c.template.titleAr,
      bodyHtml: c.renderedHtml,
      contentHash: c.contentHash,
      templateVersion: c.templateVersion,
      statusAr: STATUS_AR[c.status],
      agencySignature,
      platformSignature,
      watermarkAr:
        c.status === ContractStatus.ACTIVE
          ? null
          : `هذه النسخة ${STATUS_AR[c.status]} — لا تُعدّ وثيقة نافذة حتى يوقّعها الطرفان.`,
    };

    if (actorId) await this.event(id, 'DOWNLOADED', null, actorId, ip, ua);
    return renderContract(doc);
  }

  /** رابط عام برمز مُجزَّأ — الرمز الخام لا يُخزَّن، فقط بصمته */
  async createPublicLink(id: string) {
    await this.mustFind(id);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    await this.prisma.contractPublicLink.upsert({
      where: { contractId: id },
      create: { contractId: id, tokenHash },
      update: { tokenHash, revokedAt: null },
    });
    return { token };
  }

  async byPublicToken(token: string) {
    const link = await this.prisma.contractPublicLink.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!link || link.revokedAt) throw new NotFoundException('الرابط غير صالح');
    await this.prisma.contractPublicLink.update({
      where: { id: link.id },
      data: { lastAccessedAt: new Date() },
    });
    return this.renderHtml(link.contractId);
  }

  private async event(
    contractId: string,
    type: string,
    note?: string | null,
    actorId?: string,
    ip?: string,
    ua?: string,
  ) {
    await this.prisma.contractEvent.create({
      data: {
        contractId,
        type,
        note: note?.slice(0, 500) || null,
        actorId: actorId || null,
        ip: ip?.slice(0, 60) || null,
        userAgent: ua?.slice(0, 300) || null,
      },
    });
  }
}
