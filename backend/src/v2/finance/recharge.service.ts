import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, Prisma, RechargeStatus } from '@prisma-v2/client';
import { agencyStaffIds } from '../common/agency-staff.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../notifications/telegram.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';
import { LedgerService } from './ledger.service';

const round2 = (n: number) => Math.round(n * 100) / 100;
const MIN_AMOUNT = 5;
const MAX_AMOUNT = 5000;
/**
 * نافذة تصحيح الطلب بعد إرساله. قصيرة عمداً: المالية تبدأ المطابقة فور
 * وصول الإشعار، وتعديل مبلغ طلب هي تنظر إليه الآن يخلق لبساً أسوأ من الخطأ.
 * بعد انتهائها يبقى الإلغاء وإعادة الإرسال — أثره في السجل واضح.
 */
const EDIT_WINDOW_MINUTES = 15;

export const PAYMENT_METHOD_AR: Record<PaymentMethod, string> = {
  BANK_TRANSFER: 'تحويل بنكي',
  CLIQ: 'كليك (CliQ)',
  EFAWATEERCOM: 'إي فواتيركم',
  CASH: 'نقداً',
};

/**
 * طلبات شحن الرصيد (نموذج Prepaid): الوكالة تطلب، والمالية تعتمد بعد تأكد
 * وصول المبلغ خارج النظام. وللمالية أيضاً شحن مباشر تختار فيه الوكالة بلا
 * انتظار طلب منها — حين يصل المبلغ نقداً أو حوالةً قبل أن تفتح الوكالة
 * لوحتها، أو حين تُمنح رصيداً ترويجياً.
 *
 * المباشر ليس ثقباً في السجل: يُكتب طلباً معتمداً (requestedBy = المحاسب
 * نفسه) بقيد دفتر ومرجع، فيبقى كل دينار يدخل المحفظة حاملاً من أدخله، متى،
 * بأي مبلغ، وبأي مرجع — ويظهر في الشاشة نفسها ويُطبع منه الإيصال نفسه.
 *
 * حين تُربط بوابة دفع لاحقاً تحل محل خطوة الاعتماد اليدوي وحدها
 * (PENDING → بوابة → APPROVED) ويبقى باقي المسار والسجل كما هو.
 */
@Injectable()
export class RechargeService {
  private readonly logger = new Logger(RechargeService.name);

  constructor(
    private prisma: PrismaV2Service,
    private ledger: LedgerService,
    private gateway: TrackingV2Gateway,
    private notifications: NotificationsService,
    private telegram: TelegramService,
  ) {}

  // ============ جانب الوكالة ============

  /** طلب واحد معلّق لكل وكالة — يمنع تكرار الطلب ولبس المبالغ على المالية */
  async create(
    agencyId: string,
    data: { amount: number; method: PaymentMethod; noteAr?: string },
    requestedById: string,
  ) {
    const amount = round2(data.amount);
    if (!(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT)) {
      throw new BadRequestException(
        `مبلغ الشحن بين ${MIN_AMOUNT} و${MAX_AMOUNT} ديناراً`,
      );
    }
    const pending = await this.prisma.rechargeRequest.findFirst({
      where: { agencyId, status: 'PENDING' },
    });
    if (pending) {
      throw new BadRequestException(
        'لديك طلب شحن قيد المراجعة — انتظر اعتماده أو ألغِه قبل إرسال طلب جديد',
      );
    }
    const request = await this.prisma.rechargeRequest.create({
      data: {
        agencyId,
        amount,
        method: data.method,
        noteAr: data.noteAr?.trim() || null,
        requestedById,
      },
      include: { agency: { select: { nameAr: true } } },
    });
    // إشعار المالية: طلب لا يراه أحد يبقى معلقاً بلا سبب
    await this.notifyPlatformFinance(request.id, {
      titleAr: 'طلب شحن رصيد جديد',
      bodyAr: `${request.agency.nameAr} تطلب شحن ${amount.toFixed(2)} د.أ (${PAYMENT_METHOD_AR[request.method]})`,
      agencyId,
      amount,
    });
    void this.telegram.send(
      `💰 مالية — طلب شحن رصيد\n` +
        `الوكالة: ${request.agency.nameAr}\n` +
        `المبلغ: ${amount.toFixed(2)} دينار\n` +
        `الحالة: بانتظار الموافقة`,
    );
    return request;
  }

  async listForAgency(agencyId: string) {
    const requests = await this.prisma.rechargeRequest.findMany({
      where: { agencyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        requestedBy: { select: { name: true } },
        reviewedBy: { select: { name: true } },
      },
    });
    // اللوحة تحتاج تعرف متى تُظهر زر التعديل — تُحسب هنا بساعة الخادم لا
    // بساعة المتصفح، فساعة جهاز متأخرة كانت ستُظهر زراً يرفضه الخادم
    return requests.map((r) => ({
      ...r,
      editableUntil: this.editDeadline(r.createdAt),
      canEdit: r.status === 'PENDING' && Date.now() < +this.editDeadline(r.createdAt),
    }));
  }

  /**
   * تصحيح طلب معلّق خلال نافذة قصيرة — الوكالة تكتب مبلغاً أو طريقة خطأ،
   * والإلغاء وإعادة الإرسال يتركان طلباً ملغى مضلّلاً في سجل المالية.
   */
  async update(
    agencyId: string,
    id: string,
    data: { amount?: number; method?: PaymentMethod; noteAr?: string },
    actorId: string,
  ) {
    const request = await this.prisma.rechargeRequest.findFirst({
      where: { id, agencyId },
    });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') {
      throw new BadRequestException('لا يُعدَّل إلا طلب قيد المراجعة');
    }
    const deadline = this.editDeadline(request.createdAt);
    if (Date.now() >= +deadline) {
      throw new BadRequestException(
        `انتهت مهلة تعديل الطلب (${EDIT_WINDOW_MINUTES} دقيقة) — ألغِ الطلب وأرسل غيره`,
      );
    }
    const amount = data.amount === undefined ? undefined : round2(data.amount);
    if (amount !== undefined && !(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT)) {
      throw new BadRequestException(
        `مبلغ الشحن بين ${MIN_AMOUNT} و${MAX_AMOUNT} ديناراً`,
      );
    }
    const updated = await this.prisma.rechargeRequest.update({
      where: { id },
      data: {
        amount,
        method: data.method,
        noteAr: data.noteAr === undefined ? undefined : data.noteAr.trim() || null,
      },
      include: { agency: { select: { nameAr: true } } },
    });
    // المالية رأت الطلب الأصلي بإشعارها — تعديله بلا إخبارها يعني مطابقة
    // مبلغ لم يعد صحيحاً
    await this.notifyPlatformFinance(updated.id, {
      titleAr: 'عُدّل طلب شحن رصيد',
      bodyAr:
        `${updated.agency.nameAr} عدّلت طلبها إلى ` +
        `${Number(updated.amount).toFixed(2)} د.أ (${PAYMENT_METHOD_AR[updated.method]})`,
      agencyId,
      amount: Number(updated.amount),
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'recharge.edit',
        entityType: 'RechargeRequest',
        entityId: id,
        oldValue: {
          amount: Number(request.amount),
          method: request.method,
          noteAr: request.noteAr,
        },
        newValue: {
          amount: Number(updated.amount),
          method: updated.method,
          noteAr: updated.noteAr,
        },
      },
    });
    return {
      ...updated,
      editableUntil: deadline,
      canEdit: true,
    };
  }

  private editDeadline(createdAt: Date) {
    return new Date(+createdAt + EDIT_WINDOW_MINUTES * 60_000);
  }

  /** الوكالة تسحب طلبها ما دام معلقاً (غيّرت رأيها أو أخطأت في المبلغ) */
  async cancel(agencyId: string, id: string, actorId: string) {
    const request = await this.prisma.rechargeRequest.findFirst({
      where: { id, agencyId },
    });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') {
      throw new BadRequestException('لا يُلغى إلا طلب قيد المراجعة');
    }
    return this.prisma.rechargeRequest.update({
      where: { id },
      data: { status: 'CANCELLED', reviewedById: actorId, reviewedAt: new Date() },
    });
  }

  // ============ جانب المنصة ============

  list(status?: RechargeStatus) {
    return this.prisma.rechargeRequest.findMany({
      where: status ? { status } : {},
      // المعلّقة أولاً ثم الأحدث — شاشة المالية تبدأ بما ينتظر إجراء
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        agency: {
          select: {
            id: true, nameAr: true, phone: true,
            wallet: { select: { balance: true } },
          },
        },
        requestedBy: { select: { name: true, phone: true, username: true } },
        reviewedBy: { select: { name: true } },
      },
    });
  }

  /**
   * الاعتماد: تغيير الحالة وقيد الدفتر في معاملة واحدة — لا يزيد رصيد بلا
   * طلب معتمد، ولا يبقى طلب معتمداً بلا حركة. الشرط status=PENDING داخل
   * updateMany يجعل اعتمادين متزامنين ينجح أحدهما فقط.
   */
  async approve(
    id: string,
    data: { reference?: string; noteAr?: string },
    actorId: string,
  ) {
    const request = await this.prisma.rechargeRequest.findUnique({
      where: { id },
      include: { agency: { select: { id: true, nameAr: true } } },
    });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(
        `لا يُعتمد هذا الطلب — حالته ${this.statusAr(request.status)}`,
      );
    }
    const claimed = await this.prisma.rechargeRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        reviewedById: actorId,
        reviewedAt: new Date(),
        reference: data.reference?.trim() || null,
        reviewNoteAr: data.noteAr?.trim() || null,
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('عولج الطلب للتو من مستخدم آخر');
    }

    const amount = Number(request.amount);
    try {
      const { entryId, balance } = await this.ledger.topup(
        request.agencyId,
        amount,
        data.reference,
        actorId,
        `شحن رصيد باعتماد الطلب ${id.slice(0, 8)}`,
      );
      await this.prisma.rechargeRequest.update({
        where: { id },
        data: { ledgerEntryId: entryId },
      });
      await this.notifyAgency(request.agencyId, {
        type: 'WALLET_TOPUP',
        titleAr: 'تم شحن رصيدك',
        bodyAr: `تم شحن رصيدك بمبلغ ${amount.toFixed(2)} د.أ — الرصيد الحالي ${balance.toFixed(2)} د.أ`,
        data: { amount, balance, requestId: id },
      });
      this.logger.log(`اعتُمد شحن ${amount} لوكالة ${request.agency.nameAr} → ${balance}`);
      return { id, status: 'APPROVED', balance };
    } catch (e) {
      // فشل القيد بعد تغيير الحالة يترك طلباً معتمداً بلا رصيد — نتراجع
      await this.prisma.rechargeRequest.update({
        where: { id },
        data: {
          status: 'PENDING',
          reviewedById: null,
          reviewedAt: null,
          reference: null,
          reviewNoteAr: null,
        },
      });
      throw e;
    }
  }

  async reject(id: string, reasonAr: string, actorId: string) {
    const request = await this.prisma.rechargeRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('الطلب غير موجود');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`الطلب ${this.statusAr(request.status)} مسبقاً`);
    }
    const updated = await this.prisma.rechargeRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: actorId,
        reviewedAt: new Date(),
        reviewNoteAr: reasonAr.trim(),
      },
    });
    await this.notifyAgency(request.agencyId, {
      type: 'WALLET_TOPUP_REJECTED',
      titleAr: 'رُفض طلب شحن الرصيد',
      bodyAr: `طلب شحن ${Number(request.amount).toFixed(2)} د.أ لم يُعتمد: ${reasonAr.trim()}`,
      data: { requestId: id },
    });
    return updated;
  }

  /**
   * شحن مباشر من المنصة: المالية تختار الوكالة وتشحنها بلا طلب مسبق.
   *
   * يُسجَّل طلباً معتمَداً لا قيدَ دفترٍ عارياً، ليمر في الشاشة والتقارير
   * والإيصال كأي شحن آخر. ولأن لا وكالة طلبته، مقدّم الطلب هو المحاسب
   * نفسه — والملاحظة تُوضّح للوكالة سبب دخول الرصيد.
   *
   * طلب الوكالة المعلّق (إن وُجد) لا يُمس: قد يكون مبلغاً آخر في طريقه،
   * وإغلاقه نيابةً عنها يخفي حوالة لم تصل بعد. تراه المالية في الشاشة
   * وتقرر اعتماده أو رفضه.
   */
  async directTopup(
    agencyId: string,
    data: {
      amount: number;
      method: PaymentMethod;
      reference?: string;
      noteAr?: string;
    },
    actorId: string,
  ) {
    const amount = round2(data.amount);
    if (!(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT)) {
      throw new BadRequestException(
        `مبلغ الشحن بين ${MIN_AMOUNT} و${MAX_AMOUNT} ديناراً`,
      );
    }
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, nameAr: true },
    });
    if (!agency) throw new NotFoundException('الوكالة غير موجودة');

    const now = new Date();
    const noteAr = data.noteAr?.trim() || null;
    const request = await this.prisma.rechargeRequest.create({
      data: {
        agencyId,
        amount,
        method: data.method,
        noteAr,
        status: 'APPROVED',
        requestedById: actorId,
        reviewedById: actorId,
        reviewedAt: now,
        reference: data.reference?.trim() || null,
        reviewNoteAr: 'شحن مباشر من المنصة',
      },
    });

    try {
      const { entryId, balance } = await this.ledger.topup(
        agencyId,
        amount,
        data.reference,
        actorId,
        noteAr
          ? `شحن مباشر من المنصة — ${noteAr}`
          : 'شحن مباشر من المنصة',
      );
      await this.prisma.rechargeRequest.update({
        where: { id: request.id },
        data: { ledgerEntryId: entryId },
      });
      await this.prisma.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'recharge.direct',
          entityType: 'RechargeRequest',
          entityId: request.id,
          newValue: {
            agencyId,
            amount,
            method: data.method,
            reference: request.reference,
            noteAr,
            balance,
          },
        },
      });
      await this.notifyAgency(agencyId, {
        type: 'WALLET_TOPUP',
        titleAr: 'تم شحن رصيدك',
        bodyAr:
          `تم شحن رصيدك بمبلغ ${amount.toFixed(2)} د.أ` +
          (noteAr ? ` (${noteAr})` : '') +
          ` — الرصيد الحالي ${balance.toFixed(2)} د.أ`,
        data: { amount, balance, requestId: request.id },
      });
      void this.telegram.send(
        `💰 مالية — شحن مباشر
` +
          `الوكالة: ${agency.nameAr}
` +
          `المبلغ: ${amount.toFixed(2)} دينار
` +
          `الرصيد بعده: ${balance.toFixed(2)} دينار`,
      );
      this.logger.log(`شحن مباشر ${amount} لوكالة ${agency.nameAr} → ${balance}`);
      return { id: request.id, status: 'APPROVED', balance };
    } catch (e) {
      // فشل القيد يترك طلباً معتمداً بلا رصيد — نحذف السجل الذي لم يقابله
      // دينار واحد بدل أن يضلّل المطابقة
      await this.prisma.rechargeRequest.delete({ where: { id: request.id } });
      throw e;
    }
  }

  // ============ مساعدات ============

  private statusAr(status: RechargeStatus) {
    return { PENDING: 'قيد المراجعة', APPROVED: 'معتمد', REJECTED: 'مرفوض', CANCELLED: 'ملغى' }[status];
  }

  private async notifyAgency(
    agencyId: string,
    n: { type: string; titleAr: string; bodyAr: string; data: Prisma.InputJsonValue },
  ) {
    const staff = await agencyStaffIds(this.prisma, agencyId);
    await this.notifications.sendMany(staff, n.type, n.titleAr, n.bodyAr, n.data);
    this.gateway.emitToAgency(agencyId, 'wallet:recharge', {
      titleAr: n.titleAr,
      bodyAr: n.bodyAr,
    });
  }

  private async notifyPlatformFinance(
    requestId: string,
    n: { titleAr: string; bodyAr: string; agencyId: string; amount: number },
  ) {
    const finance = await this.prisma.userRole.findMany({
      // ADMIN مع SUPER_ADMIN: دورٌ بصلاحياته نفسها، ولو غاب عن هذه القائمة
      // لصار «مثل المدير الأعلى» في الصلاحيات وحدها دون ما يصله من عمل
      where: {
        role: {
          scope: 'PLATFORM',
          name: { in: ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT'] },
        },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    await this.notifications.sendMany(
      finance.map((f) => f.userId),
      'RECHARGE_REQUESTED',
      n.titleAr,
      n.bodyAr,
      { requestId, agencyId: n.agencyId, amount: n.amount },
    );
  }
}
