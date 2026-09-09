import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RechargeStatus } from '@prisma-v2/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { PAYMENT_METHOD_AR } from '../finance/recharge.service';
import { StorageService } from '../storage/storage.service';
import {
  dateAr,
  InvoiceDoc,
  jod,
  renderInvoice,
} from './invoice.template';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface InvoiceViewer {
  id: string;
  isPlatform: boolean;
  agencyIds: string[];
}

const MONTH_AR = (d: Date) =>
  new Date(d).toLocaleDateString('ar-JO', { month: 'long', year: 'numeric' });

const RECHARGE_STATUS: Record<
  RechargeStatus,
  { label: string; tone: 'ok' | 'warn' | 'muted' }
> = {
  PENDING: { label: 'قيد المراجعة', tone: 'warn' },
  APPROVED: { label: 'معتمد', tone: 'ok' },
  REJECTED: { label: 'مرفوض', tone: 'muted' },
  CANCELLED: { label: 'ملغى', tone: 'muted' },
};

/**
 * الفواتير والإيصالات وإعداداتها.
 *
 * الفواتير معطّلة افتراضياً: المستند يحمل رقماً ضريبياً ورقم ترخيص باسم
 * الشركة، وإصداره قبل أن يضبط الأدمن هذه البيانات يُخرج ورقة رسمية ناقصة.
 * يفعّلها بعد أن يملأ ما يلزم.
 *
 * كل عنصر له مفتاح إظهار مستقل عن قيمته — إخفاء الرقم الضريبي ريثما يصدر
 * لا يفقده، ويعود بمفتاح واحد.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private prisma: PrismaV2Service,
    private jwt: JwtService,
    private storage: StorageService,
  ) {}

  /**
   * رمز فتح فاتورة واحدة في المتصفح. قصير الأجل ومقيّد بمستند بعينه وبمن
   * طلبه — تسريبه لا يفتح غيره، وينتهي قبل أن يفيد من التقطه.
   */
  signViewToken(kind: 'order', id: string, userId: string): string {
    return this.jwt.sign(
      { typ: 'invoice_view', kind, id, uid: userId },
      { expiresIn: '10m' },
    );
  }

  /** يتحقق من الرمز ويعيد ما يصفه — يرفض أي توكن آخر ولو كان صالحاً للدخول */
  verifyViewToken(token: string): { kind: 'order'; id: string; uid: string } {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new BadRequestException('انتهت صلاحية الرابط — افتح الفاتورة من جديد');
    }
    // توكن دخول عادي يمرّ من verify، فنشترط الغرض صراحةً
    if (payload.typ !== 'invoice_view' || typeof payload.id !== 'string') {
      throw new ForbiddenException('رابط غير صالح');
    }
    return {
      kind: payload.kind as 'order',
      id: payload.id,
      uid: payload.uid as string,
    };
  }

  // ============ الرابط العام الدائم ============
  //
  // الفرق عن signViewToken أعلاه: ذاك JWT ينتهي خلال دقائق ويحمل هويته في
  // الرابط نفسه — مناسب لفتحة واحدة فورية. هذا رمز عشوائي 256-بت يُخزَّن
  // بصمته (hash) فقط لا قيمته، فيبقى صالحاً إلى أن يُستبدَل أو يُبطَل
  // صراحةً — الزبون يحفظه على جهازه ويفتحه بعد أسابيع دون أن يمرّ بتسجيل
  // دخول من جديد.

  /**
   * يولّد رمزاً عاماً جديداً لفاتورة الطلب. صفّ واحد نشط لكل طلب: توليد
   * جديد يكتب فوق tokenHash القديم فيُبطله تلقائياً — لا حاجة لسجلّ روابط
   * سابقة ولا لإبطال صريح مسبق. الرمز الخام يُعاد هنا مرة واحدة فقط ولا
   * يُخزَّن، فحتى وصول كامل لقاعدة البيانات لا يكشفه.
   */
  async createInvoicePublicLink(orderId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.invoicePublicLink.upsert({
      where: { orderId },
      create: { orderId, tokenHash: sha256(raw) },
      update: { tokenHash: sha256(raw), revokedAt: null, lastAccessedAt: null },
    });
    return raw;
  }

  /**
   * يستبدل الرمز العام برمز فارغ الأثر: يبحث بالـhash فقط (مقارنة مساواة
   * عادية على عمود مفهرس فريد — لا حاجة لمقارنة زمن ثابت هنا، فالبحث
   * بالـhash نفسه لا يسرّب توقيتاً مفيداً لمهاجم لا يملك الرمز الخام
   * أصلاً). رسالة رفض واحدة للحالتين (غير موجود / مُبطَل) حتى لا تكشف
   * الفروق ما إذا كان الرمز صحيحاً يوماً أو مختلَقاً بالكامل.
   */
  async redeemInvoicePublicLink(
    rawToken: string,
  ): Promise<{ orderId: string; customerId: string }> {
    const link = await this.prisma.invoicePublicLink.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (!link || link.revokedAt) {
      throw new ForbiddenException('رابط غير صالح');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: link.orderId },
      select: { customerId: true },
    });
    if (!order) throw new ForbiddenException('رابط غير صالح');
    // إحصائي بحت — فشل الكتابة لا يمنع فتح الفاتورة
    await this.prisma.invoicePublicLink
      .update({
        where: { orderId: link.orderId },
        data: { lastAccessedAt: new Date() },
      })
      .catch(() => {});
    return { orderId: link.orderId, customerId: order.customerId };
  }

  /** يمنع فتح الرابط العام فوراً بلا حذف الصفّ — سجلّ تدقيق بسيط */
  async revokeInvoicePublicLink(orderId: string): Promise<void> {
    await this.prisma.invoicePublicLink.updateMany({
      where: { orderId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * يعرض فاتورة الطلب لصاحب ادّعاء (claim) تحقّقت هويته مسبقاً — تُستدعى
   * من مسارَي العرض معاً (رمز الرابط القديم وكوكي الجلسة الجديد) حتى لا
   * يتكرر بناء [InvoiceViewer] من الأدوار الحيّة في كل واحد على حدة.
   */
  async renderOrderInvoiceForClaim(claim: {
    id: string;
    uid: string;
  }) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: claim.uid },
      select: { agencyId: true, role: { select: { scope: true } } },
    });
    return this.orderInvoiceHtml(claim.id, {
      id: claim.uid,
      isPlatform: roles.some((r) => r.role.scope === 'PLATFORM'),
      agencyIds: roles
        .map((r) => r.agencyId)
        .filter((id): id is string => id !== null),
    });
  }

  /** السجل الواحد — يُنشأ بقيمه الافتراضية عند أول قراءة */
  settings() {
    return this.prisma.invoiceSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
  }

  async updateSettings(
    data: Prisma.InvoiceSettingsUpdateInput,
    actorId: string,
  ) {
    const before = await this.settings();
    const after = await this.prisma.invoiceSettings.update({
      where: { id: 1 },
      data,
    });
    // بيانات تظهر على مستند رسمي — من غيّرها ومتى يجب أن يبقى
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'invoice_settings.update',
        entityType: 'InvoiceSettings',
        entityId: '1',
        oldValue: before as unknown as Prisma.InputJsonValue,
        newValue: after as unknown as Prisma.InputJsonValue,
      },
    });
    return after;
  }

  // ============ فاتورة طلب (الزبون) ============

  /**
   * الفاتورة تحمل اسم الزبون وعنوانه — لا تُفتح بمعرّف الطلب وحده، بل لصاحبها
   * أو لموظف منصة.
   */
  async orderInvoiceHtml(orderId: string, viewer: InvoiceViewer) {
    const settings = await this.assertEnabled();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { bottleType: true } },
        customer: { select: { name: true, phone: true } },
        agency: { select: { nameAr: true } },
        driver: { select: { name: true } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    if (!viewer.isPlatform && order.customerId !== viewer.id) {
      throw new ForbiddenException('لا صلاحية لعرض هذه الفاتورة');
    }
    // الفاتورة مستند لما تمّ — طلب لم يُسلَّم بعد لا فاتورة له
    if (order.status !== 'COMPLETED') {
      throw new BadRequestException('تصدر الفاتورة بعد اكتمال التوصيل');
    }

    const discount = Number(order.discountAmount);
    const info = [
      { label: 'تاريخ الإصدار', value: dateAr(order.deliveredAt ?? order.createdAt) },
      settings.showCustomerName
        ? { label: 'الزبون', value: order.customer.name }
        : null,
      settings.showCustomerPhone && order.customer.phone
        ? { label: 'هاتف الزبون', value: order.customer.phone, ltr: true }
        : null,
      settings.showAgencyName && order.agency
        ? { label: 'الوكالة المنفّذة', value: order.agency.nameAr }
        : null,
      settings.showDriverName && order.driver
        ? { label: 'السائق', value: order.driver.name }
        : null,
      settings.showDeliveryAddress
        ? { label: 'عنوان التوصيل', value: order.addressText }
        : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);

    const totals = [
      { label: 'إجمالي القوارير', amount: Number(order.subtotal) },
      settings.showCommissionLine && Number(order.commissionAmount) > 0
        ? { label: 'عمولة خدمة المنصة', amount: Number(order.commissionAmount) }
        : null,
      settings.showDiscountLine && discount > 0
        ? {
            label: order.couponCode ? `خصم (${order.couponCode})` : 'خصم',
            amount: discount,
            negative: true,
          }
        : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);

    const doc: InvoiceDoc = {
      titleAr: 'فاتورة طلب',
      subtitleAr: 'وثيقة صادرة إلكترونياً من منصّة AquaGo',
      number: order.code,
      info,
      tableCaptionAr: 'تفاصيل الطلب',
      lines: order.items.map((i) => ({
        nameAr: i.bottleType.nameAr,
        descAr: `${Number(i.bottleType.sizeLiters)} لتر`,
        qty: i.qty,
        unitPrice: Number(i.unitPrice),
        lineTotal: Number(i.unitPrice) * i.qty,
      })),
      totals,
      grandLabel: 'الإجمالي المدفوع',
      grandAmount: Number(order.total),
      status: { label: 'مكتمل — تم التسليم', tone: 'ok' },
      noteAr: 'الدفع نقداً عند التسليم.',
    };
    return renderInvoice(settings, doc);
  }

  // ============ فاتورة اشتراك (الوكالة) ============

  async subscriptionInvoiceHtml(invoiceId: string, viewer: InvoiceViewer) {
    const settings = await this.assertEnabled();
    const invoice = await this.prisma.subscriptionInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        agency: { select: { id: true, nameAr: true, subscriptionEnabled: true } },
      },
    });
    if (!invoice) throw new NotFoundException('الفاتورة غير موجودة');
    this.assertAgencyAccess(viewer, invoice.agencyId);

    const amount = Number(invoice.amount);
    const paid = Number(invoice.paidAmount);
    const remaining = Math.max(0, Math.round((amount - paid) * 100) / 100);
    const status =
      remaining <= 0
        ? { label: 'مدفوعة بالكامل', tone: 'ok' as const }
        : paid > 0
          ? { label: 'مدفوعة جزئياً', tone: 'warn' as const }
          : { label: 'غير مدفوعة', tone: 'muted' as const };

    const doc: InvoiceDoc = {
      titleAr: 'فاتورة اشتراك شهري',
      subtitleAr: 'وثيقة صادرة إلكترونياً من منصّة AquaGo',
      number: `INV-${invoice.id.slice(0, 8).toUpperCase()}`,
      info: [
        { label: 'اسم الوكالة', value: invoice.agency.nameAr },
        {
          label: 'حالة الاشتراك',
          value: invoice.agency.subscriptionEnabled ? 'مفعّل' : 'معفى من الفوترة',
        },
        { label: 'الشهر المفوتر', value: MONTH_AR(invoice.periodStart) },
        { label: 'تاريخ إصدار الفاتورة', value: dateAr(invoice.createdAt) },
        {
          label: 'تاريخ آخر دفعة',
          value: invoice.paidAt ? dateAr(invoice.paidAt) : '—',
        },
      ],
      tableCaptionAr: 'تفاصيل الاشتراك',
      lines: [
        {
          nameAr: 'اشتراك منصّة AquaGo الشهري',
          descAr: 'رسوم استخدام المنصّة لإدارة الطلبات والسائقين',
          periodAr: MONTH_AR(invoice.periodStart),
          qty: 1,
          unitPrice: amount,
          lineTotal: amount,
        },
      ],
      totals: [
        { label: 'قيمة الاشتراك الشهري', amount },
        { label: 'المدفوع سابقاً على الفاتورة', amount: paid },
      ],
      grandLabel: 'المبلغ المتبقي المستحق',
      grandAmount: remaining,
      status,
      noteAr: 'الاشتراك مستقل عن التوزيع — لا يؤثر على استقبال الوكالة للطلبات.',
    };
    return renderInvoice(settings, doc);
  }

  // ============ إيصال دفع (شحن رصيد) ============

  async rechargeReceiptHtml(requestId: string, viewer: InvoiceViewer) {
    const settings = await this.assertEnabled();
    const req = await this.prisma.rechargeRequest.findUnique({
      where: { id: requestId },
      include: {
        agency: { select: { id: true, nameAr: true } },
        requestedBy: { select: { name: true } },
        reviewedBy: { select: { name: true } },
      },
    });
    if (!req) throw new NotFoundException('الطلب غير موجود');
    this.assertAgencyAccess(viewer, req.agencyId);

    const status = RECHARGE_STATUS[req.status];
    const details = [
      { label: 'طريقة الدفع', value: PAYMENT_METHOD_AR[req.method] },
      {
        label: 'الرقم المرجعي للحوالة',
        value: req.reference || '—',
        ltr: true,
      },
      { label: 'تاريخ تقديم الطلب', value: dateAr(req.createdAt) },
      {
        label: 'تاريخ الاعتماد',
        value: req.reviewedAt ? dateAr(req.reviewedAt) : '—',
      },
      { label: 'مقدّم الطلب', value: req.requestedBy.name },
      {
        label: 'الموظف المعتمد للعملية',
        value: req.reviewedBy?.name || '—',
      },
    ];
    const note = [req.noteAr, req.reviewNoteAr].filter(Boolean).join(' · ');

    const doc: InvoiceDoc = {
      titleAr: 'إيصال عملية دفع',
      titleDark: true,
      subtitleAr: 'شحن رصيد المحفظة',
      number: `RCP-${req.id.slice(0, 8).toUpperCase()}`,
      info: [
        { label: 'اسم الوكالة', value: req.agency.nameAr },
        { label: 'نوع العملية', value: 'شحن رصيد المحفظة' },
        { label: 'المبلغ', value: jod(Number(req.amount)), ltr: true },
        { label: 'تاريخ العملية', value: dateAr(req.createdAt) },
      ],
      tableCaptionAr: 'تفاصيل العملية',
      details,
      grandLabel: 'المبلغ',
      grandAmount: Number(req.amount),
      status,
      // الختم لا يُطبع إلا على عملية اعتُمدت فعلاً — ختمٌ على طلب معلّق يوثّق
      // ما لم يحدث
      stamp:
        req.status === 'APPROVED'
          ? { label: 'معتمد', subLabel: 'AquaGo · قسم المالية' }
          : null,
      noteAr:
        note ||
        'هذا الإيصال إثبات لعملية دفع تمّت عبر منصّة AquaGo. في حال رفض العملية أو إلغائها يُعاد المبلغ وفق سياسة المنصّة.',
    };
    return renderInvoice(settings, doc);
  }

  // ============ مساعدات ============

  private assertAgencyAccess(viewer: InvoiceViewer, agencyId: string) {
    if (!viewer.isPlatform && !viewer.agencyIds.includes(agencyId)) {
      throw new ForbiddenException('لا صلاحية لعرض هذه الوثيقة');
    }
  }

  private async assertEnabled() {
    const settings = await this.settings();
    if (!settings.enabled) {
      throw new BadRequestException('الفواتير غير مفعّلة حالياً');
    }
    return { ...settings, logoUrl: await this.inlineLogo(settings.logoUrl) };
  }

  /**
   * الشعار يُدمج في المستند كـ data URI بدل رابطٍ إليه.
   *
   * الرابط المخزَّن نسبي (`/api/v2/media/<id>`) وهو يعمل حيث للصفحة أصلٌ
   * تُنسب إليه — تطبيق الهاتف يسبقه بعنوان الخادم، والرابط العام للفاتورة
   * يُفتح من الخادم نفسه. لكن لوحة المنصة تجلب الفاتورة بترويسة هوية ثم
   * تفتحها من `blob:`، ولمستندِ blob أصلٌ مبهم: لا مضيف يُحلّ إليه مسارٌ
   * يبدأ بـ`/`، فيبقى الشعار وحده غائباً عن فاتورةٍ سليمة فيما عداه.
   *
   * والدمج أمتن من عنوان مطلق: الفاتورة تُطبع وتُحفظ PDF وتُرسل بالبريد،
   * وفي كل ذلك لا شبكة تُسأل ولا مضيفٌ قد يتغيّر.
   *
   * ما ليس من وسائطنا (عنوان خارجي كامل) يُترك كما هو — قد يكون مقصوداً.
   */
  private async inlineLogo(logoUrl: string | null): Promise<string | null> {
    const id = logoUrl?.match(/\/api\/v2\/media\/([0-9a-f-]{36})$/i)?.[1];
    if (!id) return logoUrl;
    const image = await this.prisma.uploadedImage.findUnique({
      where: { id },
      select: { data: true, storageKey: true, mimeType: true },
    });
    // الصورة حُذفت من القاعدة والرابط باقٍ: نُبقيه كما هو، والقالب يتدبّر
    // غيابه (لا صندوق فارغ متقطّع على مستند رسمي)
    if (!image) return logoUrl;
    const bytes = image.storageKey ? await this.storage.get(image.storageKey) : image.data;
    if (!bytes) return logoUrl; // صف فاسد نظرياً فقط
    return `data:${image.mimeType};base64,${bytes.toString('base64')}`;
  }
}
