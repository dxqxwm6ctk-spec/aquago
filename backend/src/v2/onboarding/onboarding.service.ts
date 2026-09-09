import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma-v2/client';
import {
  OnboardingFieldMode,
  OnboardingStatus,
  Prisma as PrismaRuntime,
} from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { StorageService } from '../storage/storage.service';
import {
  ALL_KEYS,
  CatalogField,
  DOCUMENTS,
  DOCUMENT_BY_KEY,
  FIELDS,
  FIELD_BY_KEY,
  FormShape,
  LICENSES,
  LICENSE_BY_KEY,
  STEPS,
  normalizeFieldValue,
  requirementKey,
  validateFieldValue,
} from './onboarding.catalog';

/** ما تراه الوكالة والأدمن: الكتالوج بعد تطبيق قرارات الأدمن عليه */
type EffectiveMode = OnboardingFieldMode;

const HIDDEN = OnboardingFieldMode.HIDDEN;
const REQUIRED = OnboardingFieldMode.REQUIRED;

/** الحالات التي تسمح للوكالة بالتعديل */
const EDITABLE: OnboardingStatus[] = [
  OnboardingStatus.DRAFT,
  OnboardingStatus.CHANGES_REQUESTED,
];

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private prisma: PrismaV2Service,
    private storage: StorageService,
  ) {}

  // ==================== إعدادات الأدمن ====================

  /** قرارات الأدمن المخزّنة، مفهرسة بالمفتاح */
  private async overrides() {
    const rows = await this.prisma.agencyOnboardingRequirement.findMany();
    return new Map(rows.map((r) => [r.key, r]));
  }

  /**
   * الكتالوج كاملاً مع الحالة السارية لكل مفتاح — هذا ما تبني عليه اللوحتان
   * والتحقق معاً. مصدرٌ واحد للطرفين يعني أن ما يعرضه النموذج هو بعينه ما
   * يفرضه الخادم: لا نموذجَ يطلب حقلاً لا يفحصه أحد، ولا خادمَ يرفض ما لم
   * يُعرض أصلاً.
   */
  async catalog() {
    const ov = await this.overrides();
    const pick = (key: string, fallback: EffectiveMode) => ov.get(key)?.mode ?? fallback;
    const label = (key: string, fallback: string) => ov.get(key)?.labelAr || fallback;
    const hint = (key: string, fallback?: string) => ov.get(key)?.hintAr || fallback || null;

    return {
      steps: STEPS,
      fields: FIELDS.map((f) => {
        const k = requirementKey.field(f.key);
        return {
          key: f.key,
          step: f.step,
          kind: f.kind,
          labelAr: label(k, f.labelAr),
          hintAr: hint(k, f.hintAr),
          options: f.options ?? null,
          maxLength: f.maxLength ?? null,
          locked: !!f.locked,
          // المفتاح المقفل لا يقبل تغييراً: نعيد حالته من الكتالوج مهما
          // حمل الجدول، فصفٌّ قديم لمفتاح صار مقفلاً لا يعطّل النموذج.
          mode: f.locked ? f.defaultMode : pick(k, f.defaultMode),
          defaultMode: f.defaultMode,
          showIfKey: f.showIf ? this.showIfName(f.key) : null,
        };
      }),
      licenses: LICENSES.map((l) => {
        const k = requirementKey.license(l.key);
        return {
          key: l.key,
          labelAr: label(k, l.labelAr),
          authorityAr: l.authorityAr,
          expires: l.expires,
          mode: pick(k, l.defaultMode),
          defaultMode: l.defaultMode,
        };
      }),
      documents: DOCUMENTS.map((d) => {
        const k = requirementKey.doc(d.key);
        return {
          key: d.key,
          labelAr: label(k, d.labelAr),
          hintAr: hint(k, d.hintAr),
          mode: pick(k, d.defaultMode),
          defaultMode: d.defaultMode,
          showIfKey: d.showIf ? this.showIfName(d.key) : null,
        };
      }),
    };
  }

  /**
   * اسم شرط الظهور كما تفهمه الواجهة. الدالة نفسها لا تعبر JSON، والواجهة
   * لا تُعيد تنفيذ منطقٍ خاص بكل حقل: اسمٌ من ثلاثة تقيّمه بسطر واحد.
   */
  private showIfName(key: string): string | null {
    if (key === 'proxyNumber' || key === 'proxyDate' || key === 'signingAuthorization') {
      return 'needsProxy';
    }
    if (key === 'vatNumber') return 'isVat';
    if (key === 'articlesOfAssociation') return 'isLlc';
    return null;
  }

  /** يضبط الأدمن حالة مفاتيح. المفتاح المجهول يُرفض لا يُتجاهَل بصمت. */
  async setRequirements(
    items: { key: string; mode: OnboardingFieldMode; labelAr?: string; hintAr?: string }[],
    userId: string,
  ) {
    const lockedFields = new Set(
      FIELDS.filter((f) => f.locked).map((f) => requirementKey.field(f.key)),
    );
    for (const it of items) {
      if (!ALL_KEYS.has(it.key)) {
        throw new BadRequestException(`مفتاح غير معروف: ${it.key}`);
      }
      if (lockedFields.has(it.key)) {
        throw new BadRequestException(
          'الصفة القانونية ومن يوقّع لا يمكن إخفاؤهما — عليهما يتفرّع باقي النموذج',
        );
      }
    }

    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.agencyOnboardingRequirement.upsert({
          where: { key: it.key },
          create: {
            key: it.key,
            mode: it.mode,
            labelAr: it.labelAr || null,
            hintAr: it.hintAr || null,
            updatedById: userId,
          },
          update: {
            mode: it.mode,
            labelAr: it.labelAr || null,
            hintAr: it.hintAr || null,
            updatedById: userId,
          },
        }),
      ),
    );

    return this.catalog();
  }

  // ==================== جانب الوكالة ====================

  /** الملف، منشأً عند أول فتح. لا يُنشأ مع الوكالة: صفٌّ فارغ لكل وكالة
   *  قديمة يجعل «لم يبدأ» و«بدأ ولم يكتب شيئاً» حالةً واحدة لا تُميَّز. */
  private async ensure(agencyId: string) {
    const existing = await this.prisma.agencyOnboarding.findUnique({ where: { agencyId } });
    if (existing) return existing;
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, nameAr: true },
    });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');
    return this.prisma.agencyOnboarding.create({
      data: { agencyId, legalNameAr: agency.nameAr },
    });
  }

  /** الملف كما تراه الوكالة: بياناتها + الكتالوج + ما ينقصها */
  async myFile(agencyId: string) {
    const row = await this.ensure(agencyId);
    const [catalog, licenses, documents] = await Promise.all([
      this.catalog(),
      this.prisma.agencyOnboardingLicense.findMany({ where: { onboardingId: row.id } }),
      this.prisma.agencyOnboardingDocument.findMany({
        where: { onboardingId: row.id },
        // البايتات تُستثنى صراحةً: قائمة بعشر وثائق تعني عشرات الميغابايتات
        // تعبر الشبكة لتُرسم أسماء ملفات.
        select: {
          key: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          rejectionReason: true,
          uploadedAt: true,
        },
      }),
    ]);

    const missing = await this.missing(row, licenses, documents, catalog);
    return {
      catalog,
      file: this.publicFile(row),
      licenses,
      documents,
      missing,
      canEdit: EDITABLE.includes(row.status),
      canSubmit: EDITABLE.includes(row.status) && missing.length === 0,
      completionPercent: await this.completion(row, licenses, documents, catalog),
    };
  }

  /**
   * ما يُعاد للوكالة والأدمن — أعمدة الصفّ وحدها.
   *
   * العلاقات تُنزع صراحةً: `detail` يمرّر الصفَّ بعلاقاته المحمَّلة، وبلا
   * هذا النزع تعود الوثائق والأحداث مرتين في الرد — مرة تحت `file` ومرة
   * في مكانها — فيقرأ المستهلك إحداهما ويظنّ الأخرى شيئاً آخر.
   */
  private publicFile(row: Record<string, unknown>) {
    const d = (v: unknown) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null);
    const { agency, reviewedBy, licenses, documents, events, ...cols } = row as Record<
      string,
      unknown
    >;
    void agency;
    void reviewedBy;
    void licenses;
    void documents;
    void events;
    return {
      ...cols,
      registeredAt: d(row.registeredAt),
      proxyDate: d(row.proxyDate),
      signerBirthDate: d(row.signerBirthDate),
    };
  }

  private shape(row: {
    entityType: string | null;
    ownerSigns: boolean;
    vatRegistered: boolean | null;
  }): FormShape {
    return {
      entityType: row.entityType,
      ownerSigns: row.ownerSigns,
      vatRegistered: row.vatRegistered,
    };
  }

  /** حقل مطلوب فعلاً: حالته إلزامية **و** شرط ظهوره متحقق */
  private demanded(f: CatalogField, mode: EffectiveMode, shape: FormShape) {
    if (mode !== REQUIRED) return false;
    if (f.showIf && !f.showIf(shape)) return false;
    return true;
  }

  /** حفظ جزئي — الحقول الغائبة لا تُمسّ، والمرسلة تُتحقَّق شكلاً */
  async saveDraft(agencyId: string, values: Record<string, unknown>) {
    const row = await this.ensure(agencyId);
    if (!EDITABLE.includes(row.status)) {
      throw new ForbiddenException(
        row.status === OnboardingStatus.SUBMITTED
          ? 'الملف قيد المراجعة — لا يمكن تعديله حتى يردّ المراجع'
          : 'الملف معتمد — التعديل يتطلب فتحه من المنصة',
      );
    }

    const catalog = await this.catalog();
    const modes = new Map(catalog.fields.map((f) => [f.key, f.mode]));
    const data: Prisma.AgencyOnboardingUpdateInput = {};
    const errors: string[] = [];

    for (const [key, raw] of Object.entries(values)) {
      const field = FIELD_BY_KEY.get(key);
      if (!field) continue; // مفتاح لا نعرفه — تجاهل صامت، لا نكسر نموذجاً بحقل زائد
      if (modes.get(key) === HIDDEN) continue; // مخفيّ لا يُكتب حتى لو أُرسل

      if (raw === null || raw === '') {
        // `ownerSigns` عمود غير قابل للفراغ بقيمة افتراضية — تفريغه يرمي من
        // القاعدة. وهو سؤال تفرّع لا يُفرَّغ من الواجهة أصلاً، فنتجاهله.
        if (field.column === 'ownerSigns') continue;
        (data as Record<string, unknown>)[field.column] = null;
        continue;
      }
      const err = validateFieldValue(field, raw);
      if (err) {
        errors.push(err);
        continue;
      }
      if (field.kind === 'bool') {
        (data as Record<string, unknown>)[field.column] = raw as boolean;
      } else if (field.kind === 'date') {
        (data as Record<string, unknown>)[field.column] = new Date(raw as string);
      } else {
        (data as Record<string, unknown>)[field.column] = normalizeFieldValue(
          field,
          raw as string,
        );
      }
    }

    if (errors.length) throw new BadRequestException(errors);

    await this.prisma.agencyOnboarding.update({ where: { id: row.id }, data });
    return this.myFile(agencyId);
  }

  /** تراخيص: صفٌّ لكل مفتاح، والرفع من جديد يكتب فوقه */
  async saveLicense(
    agencyId: string,
    key: string,
    dto: { number?: string | null; issuedAt?: string | null; expiresAt?: string | null },
  ) {
    const row = await this.ensure(agencyId);
    if (!EDITABLE.includes(row.status)) {
      throw new ForbiddenException('الملف غير قابل للتعديل في حالته الحالية');
    }
    if (!LICENSE_BY_KEY.has(key)) throw new BadRequestException('ترخيص غير معروف');

    const date = (v?: string | null) => {
      if (!v) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw new BadRequestException('تاريخ غير صالح');
      }
      return new Date(v);
    };
    const issuedAt = date(dto.issuedAt);
    const expiresAt = date(dto.expiresAt);
    if (issuedAt && expiresAt && expiresAt <= issuedAt) {
      throw new BadRequestException('تاريخ الانتهاء يجب أن يكون بعد تاريخ الإصدار');
    }

    const payload = { number: dto.number?.trim() || null, issuedAt, expiresAt };
    await this.prisma.agencyOnboardingLicense.upsert({
      where: { onboardingId_key: { onboardingId: row.id, key } },
      create: { onboardingId: row.id, key, ...payload },
      update: payload,
    });
    return this.myFile(agencyId);
  }

  // ==================== الوثائق ====================

  private static readonly MAX_DOC_BYTES = 5 * 1024 * 1024;
  private static readonly ALLOWED_DOC_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/pdf',
  ];

  async uploadDocument(
    agencyId: string,
    key: string,
    file: { buffer: Buffer; mimetype: string; originalname?: string; size: number },
    actorId: string,
    ip?: string,
    userAgent?: string,
  ) {
    const row = await this.ensure(agencyId);
    if (!EDITABLE.includes(row.status)) {
      throw new ForbiddenException('الملف غير قابل للتعديل في حالته الحالية');
    }
    if (!DOCUMENT_BY_KEY.has(key)) throw new BadRequestException('نوع وثيقة غير معروف');
    if (!OnboardingService.ALLOWED_DOC_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('صيغة غير مدعومة — PNG أو JPEG أو WebP أو PDF');
    }
    if (file.size > OnboardingService.MAX_DOC_BYTES) {
      throw new BadRequestException('الملف أكبر من ٥ ميغابايت');
    }

    // القديم مفتاحُه، إن وُجد، لحذفه من التخزين بعد نجاح الرفع الجديد —
    // لا قبله: فشل الرفع يجب ألا يترك الوكالة بلا وثيقة أصلاً ولا جديدة.
    const previous = await this.prisma.agencyOnboardingDocument.findUnique({
      where: { onboardingId_key: { onboardingId: row.id, key } },
      select: { storageKey: true },
    });
    const stored = await this.storage.put(file.buffer, file.mimetype, 'onboarding-docs');

    const payload = {
      storageKey: stored.key,
      data: null, // الرفعات الجديدة لا تكتب بايتات في القاعدة بعد الآن
      mimeType: file.mimetype,
      fileName: file.originalname?.slice(0, 200) || null,
      sizeBytes: file.size,
      // الرفع من جديد بعد رفضٍ يعيد الوثيقة للطابور: إبقاؤها مرفوضة يجعل
      // الوكالة ترفع ولا يتغيّر شيء أمامها.
      status: 'PENDING' as const,
      rejectionReason: null,
      reviewedAt: null,
      reviewedById: null,
      uploadedAt: new Date(),
    };

    await this.prisma.agencyOnboardingDocument.upsert({
      where: { onboardingId_key: { onboardingId: row.id, key } },
      create: { onboardingId: row.id, key, ...payload },
      update: payload,
    });
    // تنظيف الكائن المستبدَل — بعد نجاح upsert لا قبله، وبلا انتظار: فشل
    // الحذف (مؤقت من الشبكة مثلاً) لا يجوز أن يفشل رفع وثيقة استُبدلت فعلاً.
    if (previous?.storageKey) {
      this.storage.delete(previous.storageKey).catch((e) =>
        this.logger.warn(`تعذّر حذف وثيقة onboarding قديمة ${previous.storageKey}: ${e}`),
      );
    }
    await this.event(row.id, 'DOC_UPLOADED', DOCUMENT_BY_KEY.get(key)?.labelAr, actorId, ip, userAgent);
    return this.myFile(agencyId);
  }

  /**
   * حذف وثيقة — التخزين لا يُلمَس إلا بعد تأكّد حذف الصفّ فعلاً.
   *
   * ثلاث نتائج ممكنة لحذف القاعدة، وثلاث معاملات مختلفة معها:
   *  - نجح الحذف (صفّ كان موجوداً) → نحذف كائن التخزين المرتبط به.
   *  - الصفّ غائبٌ أصلاً (P2025 — حُذف من قبل، أو استُدعيت الدالة مرتين
   *    بالتزامن) → لا خطأ، ولا حذف تخزين: لا كائن نملك مفتاحه لنحذفه بثقة
   *    (`doc` من القراءة الأولى قد يكون سبق حذفَ صفٍّ آخر تماماً).
   *  - خطأ غير متوقَّع (انقطاع اتصال، قيد خارجي، إلخ) → الصفّ ربما ما زال
   *    موجوداً ويشير إلى الكائن، فحذف الكائن الآن يُتيم مرجعاً حياً. نُبقي
   *    الكائن ونُصعّد الخطأ — لا نبتلعه كما كان يحدث سابقاً.
   */
  async deleteDocument(agencyId: string, key: string) {
    const row = await this.ensure(agencyId);
    if (!EDITABLE.includes(row.status)) {
      throw new ForbiddenException('الملف غير قابل للتعديل في حالته الحالية');
    }
    const doc = await this.prisma.agencyOnboardingDocument.findUnique({
      where: { onboardingId_key: { onboardingId: row.id, key } },
      select: { storageKey: true },
    });

    let rowDeleted = false;
    try {
      await this.prisma.agencyOnboardingDocument.delete({
        where: { onboardingId_key: { onboardingId: row.id, key } },
      });
      rowDeleted = true;
    } catch (e) {
      const alreadyGone =
        e instanceof PrismaRuntime.PrismaClientKnownRequestError && e.code === 'P2025';
      if (!alreadyGone) {
        // خطأ حقيقي — لا نحذف كائن التخزين، ونُصعّد بدل الابتلاع الصامت
        // الذي كان هنا: مستدعي الدالة يرى الفشل بدل ردٍّ ناجحٍ كاذب.
        this.logger.error(`فشل حذف وثيقة onboarding ${key} من القاعدة: ${e}`);
        throw e;
      }
      // "غائبة أصلاً" حالة مدعومة عمداً — لا خطأ، ولا حذف تخزين تالٍ.
    }

    if (rowDeleted && doc?.storageKey) {
      this.storage.delete(doc.storageKey).catch((e) =>
        this.logger.warn(`تعذّر حذف وثيقة onboarding ${doc.storageKey}: ${e}`),
      );
    }
    return this.myFile(agencyId);
  }

  /**
   * بايتات وثيقة — الاستدعاء الوحيد الذي يقرأ محتواها. المتصل مسؤول عن
   * التحقق من الحق: إمّا مراجعٌ يملك الصلاحية، أو الوكالة صاحبة الملف.
   *
   * `data` بالنتيجة محلولة دوماً — من storageKey إن وُجد وإلا من العمود
   * القديم — فالمستدعي (وحدَين بالمتحكم) لا يتغيّر رغم انتقال التخزين.
   */
  async documentBytes(onboardingId: string, key: string) {
    const doc = await this.prisma.agencyOnboardingDocument.findUnique({
      where: { onboardingId_key: { onboardingId, key } },
    });
    if (!doc) throw new NotFoundException('الوثيقة غير موجودة');
    const data = doc.storageKey ? await this.storage.get(doc.storageKey) : doc.data;
    if (!data) throw new NotFoundException('الوثيقة غير موجودة'); // صف فاسد نظرياً فقط
    return { ...doc, data };
  }

  async onboardingIdOfAgency(agencyId: string) {
    const row = await this.prisma.agencyOnboarding.findUnique({
      where: { agencyId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('لا يوجد ملف لهذه الوكالة');
    return row.id;
  }

  // ==================== ما ينقص، ونسبة الاكتمال ====================

  private async missing(
    row: Awaited<ReturnType<OnboardingService['ensure']>>,
    licenses: { key: string; number: string | null; expiresAt: Date | null }[],
    documents: { key: string }[],
    catalog: Awaited<ReturnType<OnboardingService['catalog']>>,
  ) {
    const shape = this.shape(row);
    const out: { key: string; labelAr: string; step: number }[] = [];

    for (const cf of catalog.fields) {
      const field = FIELD_BY_KEY.get(cf.key)!;
      if (!this.demanded(field, cf.mode, shape)) continue;
      const value = (row as Record<string, unknown>)[field.column];
      if (value === null || value === undefined || value === '') {
        out.push({ key: cf.key, labelAr: cf.labelAr, step: cf.step });
      }
    }

    const licByKey = new Map(licenses.map((l) => [l.key, l]));
    for (const cl of catalog.licenses) {
      if (cl.mode !== REQUIRED) continue;
      const have = licByKey.get(cl.key);
      if (!have?.number) {
        out.push({ key: `license:${cl.key}`, labelAr: `${cl.labelAr} — الرقم`, step: 4 });
      } else if (cl.expires && !have.expiresAt) {
        out.push({ key: `license:${cl.key}:exp`, labelAr: `${cl.labelAr} — تاريخ الانتهاء`, step: 4 });
      }
    }

    const docKeys = new Set(documents.map((d) => d.key));
    for (const cd of catalog.documents) {
      if (cd.mode !== REQUIRED) continue;
      const spec = DOCUMENT_BY_KEY.get(cd.key)!;
      if (spec.showIf && !spec.showIf(shape)) continue;
      if (!docKeys.has(cd.key)) {
        out.push({ key: `doc:${cd.key}`, labelAr: cd.labelAr, step: 6 });
      }
    }

    return out;
  }

  /**
   * نسبة الاكتمال محسوبة على المطلوب فعلاً لا على الكتالوج كله: أدمنٌ يخفي
   * نصف الحقول يجب أن يرى ملفاً مكتملاً عند تعبئة النصف الباقي، لا 50%.
   */
  private async completion(
    row: Awaited<ReturnType<OnboardingService['ensure']>>,
    licenses: { key: string; number: string | null; expiresAt: Date | null }[],
    documents: { key: string }[],
    catalog: Awaited<ReturnType<OnboardingService['catalog']>>,
  ) {
    const shape = this.shape(row);
    let total = 0;
    for (const cf of catalog.fields) {
      if (this.demanded(FIELD_BY_KEY.get(cf.key)!, cf.mode, shape)) total++;
    }
    for (const cl of catalog.licenses) if (cl.mode === REQUIRED) total += cl.expires ? 2 : 1;
    for (const cd of catalog.documents) {
      if (cd.mode !== REQUIRED) continue;
      const spec = DOCUMENT_BY_KEY.get(cd.key)!;
      if (spec.showIf && !spec.showIf(shape)) continue;
      total++;
    }
    if (total === 0) return 100;
    const missing = await this.missing(row, licenses, documents, catalog);
    return Math.round(((total - missing.length) / total) * 100);
  }

  // ==================== الإرسال والمراجعة ====================

  async submit(agencyId: string, actorId: string, ip?: string, userAgent?: string) {
    const row = await this.ensure(agencyId);
    if (!EDITABLE.includes(row.status)) {
      throw new ForbiddenException('الملف مُرسَل بالفعل');
    }
    const [catalog, licenses, documents] = await Promise.all([
      this.catalog(),
      this.prisma.agencyOnboardingLicense.findMany({ where: { onboardingId: row.id } }),
      this.prisma.agencyOnboardingDocument.findMany({
        where: { onboardingId: row.id },
        select: { key: true },
      }),
    ]);
    const missing = await this.missing(row, licenses, documents, catalog);
    if (missing.length) {
      throw new BadRequestException([
        'الملف ناقص — أكمل التالي قبل الإرسال:',
        ...missing.map((m) => m.labelAr),
      ]);
    }

    await this.prisma.agencyOnboarding.update({
      where: { id: row.id },
      data: {
        status: OnboardingStatus.SUBMITTED,
        submittedAt: new Date(),
        reviewNote: null,
      },
    });
    await this.event(row.id, 'SUBMITTED', null, actorId, ip, userAgent);
    return this.myFile(agencyId);
  }

  /** طابور المراجعة */
  async list(params: { status?: OnboardingStatus; q?: string }) {
    const where: Prisma.AgencyOnboardingWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.q?.trim()) {
      const q = params.q.trim();
      where.OR = [
        { legalNameAr: { contains: q, mode: 'insensitive' } },
        { commercialRegistryNo: { contains: q, mode: 'insensitive' } },
        { nationalEstablishmentNo: { contains: q, mode: 'insensitive' } },
        { taxNumber: { contains: q, mode: 'insensitive' } },
        { signerName: { contains: q, mode: 'insensitive' } },
        { agency: { nameAr: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, counts] = await Promise.all([
      this.prisma.agencyOnboarding.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { updatedAt: 'desc' }],
        take: 200,
        select: {
          id: true,
          status: true,
          entityType: true,
          legalNameAr: true,
          signerName: true,
          submittedAt: true,
          updatedAt: true,
          agency: { select: { id: true, nameAr: true, phone: true, status: true } },
          _count: { select: { documents: true } },
        },
      }),
      this.prisma.agencyOnboarding.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    return {
      rows,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  /** ملف واحد بكل تفاصيله — ما يفتحه المراجع */
  async detail(onboardingId: string) {
    const row = await this.prisma.agencyOnboarding.findUnique({
      where: { id: onboardingId },
      include: {
        agency: { select: { id: true, nameAr: true, phone: true, status: true } },
        reviewedBy: { select: { id: true, name: true } },
        licenses: true,
        documents: {
          select: {
            id: true,
            key: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            status: true,
            rejectionReason: true,
            uploadedAt: true,
            reviewedAt: true,
            reviewedBy: { select: { id: true, name: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { actor: { select: { id: true, name: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException('الملف غير موجود');

    const catalog = await this.catalog();
    const missing = await this.missing(row, row.licenses, row.documents, catalog);
    return {
      catalog,
      file: this.publicFile(row),
      agency: row.agency,
      licenses: row.licenses,
      documents: row.documents,
      events: row.events,
      missing,
      reviewedBy: row.reviewedBy,
    };
  }

  async review(
    onboardingId: string,
    action: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    note: string | undefined,
    actorId: string,
    ip?: string,
    userAgent?: string,
  ) {
    const row = await this.prisma.agencyOnboarding.findUnique({ where: { id: onboardingId } });
    if (!row) throw new NotFoundException('الملف غير موجود');
    if (row.status !== OnboardingStatus.SUBMITTED) {
      throw new BadRequestException('لا يُراجَع إلا ملفٌ مُرسَل');
    }
    // الرفض وطلب التعديل يوجبان سبباً: قرارٌ بلا سبب لا يمكن للوكالة
    // تصحيحه ولا لنا مراجعته لاحقاً.
    if (action !== 'APPROVE' && !note?.trim()) {
      throw new BadRequestException('اكتب السبب — الوكالة تحتاج أن تعرف ما تصحّحه');
    }

    const status =
      action === 'APPROVE'
        ? OnboardingStatus.APPROVED
        : action === 'REJECT'
          ? OnboardingStatus.REJECTED
          : OnboardingStatus.CHANGES_REQUESTED;

    await this.prisma.agencyOnboarding.update({
      where: { id: onboardingId },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedById: actorId,
        reviewNote: note?.trim() || null,
      },
    });
    await this.event(onboardingId, status, note?.trim(), actorId, ip, userAgent);
    return this.detail(onboardingId);
  }

  async reviewDocument(
    onboardingId: string,
    key: string,
    verified: boolean,
    reason: string | undefined,
    actorId: string,
    ip?: string,
    userAgent?: string,
  ) {
    if (!verified && !reason?.trim()) {
      throw new BadRequestException('اكتب سبب الرفض — بلا سبب لا تعرف الوكالة ماذا ترفع');
    }
    await this.prisma.agencyOnboardingDocument.update({
      where: { onboardingId_key: { onboardingId, key } },
      data: {
        status: verified ? 'VERIFIED' : 'REJECTED',
        rejectionReason: verified ? null : reason!.trim(),
        reviewedAt: new Date(),
        reviewedById: actorId,
      },
    });
    await this.event(
      onboardingId,
      verified ? 'DOC_VERIFIED' : 'DOC_REJECTED',
      `${DOCUMENT_BY_KEY.get(key)?.labelAr ?? key}${reason ? ` — ${reason.trim()}` : ''}`,
      actorId,
      ip,
      userAgent,
    );
    return this.detail(onboardingId);
  }

  /** إعادة فتح ملف معتمد أو مرفوض للتعديل — قرار المنصة وحدها */
  async reopen(onboardingId: string, note: string, actorId: string, ip?: string, userAgent?: string) {
    if (!note?.trim()) throw new BadRequestException('اكتب سبب إعادة الفتح');
    const row = await this.prisma.agencyOnboarding.findUnique({ where: { id: onboardingId } });
    if (!row) throw new NotFoundException('الملف غير موجود');
    if (EDITABLE.includes(row.status)) throw new BadRequestException('الملف مفتوح أصلاً');
    await this.prisma.agencyOnboarding.update({
      where: { id: onboardingId },
      data: { status: OnboardingStatus.CHANGES_REQUESTED, reviewNote: note.trim() },
    });
    await this.event(onboardingId, 'REOPENED', note.trim(), actorId, ip, userAgent);
    return this.detail(onboardingId);
  }

  /**
   * سجلّ الأحداث. `note` هنا وصفٌ لا قيمة حقل — لا يُكتب فيه رقم وطني ولا
   * رقم حساب أبداً: سجلٌّ يُقرأ في التدقيق لا يجوز أن يصير نسخة ثانية من
   * البيانات الشخصية بلا الحراسة نفسها.
   */
  private async event(
    onboardingId: string,
    type: string,
    note: string | null | undefined,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ) {
    await this.prisma.agencyOnboardingEvent.create({
      data: {
        onboardingId,
        type,
        note: note?.slice(0, 500) || null,
        actorId: actorId || null,
        ip: ip?.slice(0, 60) || null,
        userAgent: userAgent?.slice(0, 300) || null,
      },
    });
  }
}
