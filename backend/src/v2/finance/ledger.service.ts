import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma-v2/client';
import { agencyStaffIds } from '../common/agency-staff.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * القلب المالي (نموذج Prepaid — القرارات 1 و2 و6 من الاعتماد):
 * كل حركة تُكتب داخل معاملة تقفل صف المحفظة (SELECT ... FOR UPDATE)
 * فيبقى balanceAfter صحيحاً مهما تزامنت الإكمالات، والحقيقة الدائمة هي
 * الـ Ledger (append-only بمحفّز قاعدة البيانات) والرصيد مجرد كاش.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private prisma: PrismaV2Service,
    private gateway: TrackingV2Gateway,
    private notifications: NotificationsService,
  ) {}

  /** الحركة الذرية الموحدة — كل الأنواع تمر من هنا */
  private async applyEntry(
    agencyId: string,
    data: {
      type: 'TOPUP' | 'COMMISSION' | 'ADJUSTMENT' | 'REFUND';
      amount: number; // موجب إيداع، سالب خصم
      orderId?: string;
      reference?: string;
      noteAr?: string;
      actorUserId?: string;
    },
  ): Promise<{ before: number; after: number; entryId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { agencyId },
        create: { agencyId },
        update: {},
      });
      const rows = await tx.$queryRaw<{ balance: string }[]>`
        SELECT balance::text FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE
      `;
      const before = Number(rows[0].balance);
      const after = round2(before + data.amount);
      const entry = await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          orderId: data.orderId,
          type: data.type,
          amount: data.amount,
          balanceAfter: after,
          reference: data.reference,
          noteAr: data.noteAr,
          actorUserId: data.actorUserId,
        },
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: after },
      });
      return { before, after, entryId: entry.id };
    });
  }

  /**
   * عمولة المنصة عند اكتمال الطلب — المبلغ snapshot ثُبّت لحظة قبول السائق.
   * تُخصم حتى لو أوصلت الرصيد للسالب: الطلب قُبل والخدمة قُدمت،
   * والحماية المستقبلية أن الوكالة تخرج من التوزيع (فلتر المحرك).
   */
  async chargeCommission(order: {
    id: string;
    code: string;
    agencyId: string | null;
    commissionAmount: Prisma.Decimal | number;
    discountAmount?: Prisma.Decimal | number | null;
  }): Promise<void> {
    // خصم الكوبون تموّله المنصة من عمولتها: تُخصم من الوكالة العمولة ناقصَه،
    // فتخرج بثمن المياه كاملاً كأن لا كوبون. الخصم مقيَّد بالعمولة عند إنشاء
    // الطلب، فالطرح لا ينزل تحت الصفر — والحدّ هنا احتياط لطلبٍ قديم أُنشئ
    // قبل هذا القيد.
    const gross = Number(order.commissionAmount);
    const discount = Number(order.discountAmount ?? 0);
    const commission = round2(Math.max(0, gross - discount));
    if (!order.agencyId || commission <= 0) return;

    const { before, after } = await this.applyEntry(order.agencyId, {
      type: 'COMMISSION',
      amount: -commission,
      orderId: order.id,
      noteAr:
        discount > 0
          ? `عمولة المنصة عن الطلب ${order.code} (مخفّضة بكوبون خصم ${discount.toFixed(2)} د.أ)`
          : `عمولة المنصة عن الطلب ${order.code}`,
    });
    this.logger.log(`عمولة ${commission} عن ${order.code}: ${before} → ${after}`);
    this.gateway.emitToAgency(order.agencyId, 'wallet:updated', {
      balance: after,
    });

    // إشعار عند عبور الحد نزولاً فقط — لا إزعاج مع كل طلب
    const settings = await this.prisma.dispatchSettings.findUnique({ where: { id: 1 } });
    const threshold = Number(settings?.lowBalanceThreshold ?? 10);
    const crossedThreshold = before >= threshold && after < threshold;
    const crossedZero = before > 0 && after <= 0;
    if (crossedThreshold || crossedZero) {
      // بلا السائقين: الرصيد شأن مالي للوكالة، والشحن ليس بيد السائق
      const staff = await agencyStaffIds(this.prisma, order.agencyId);
      const bodyAr = crossedZero
        ? `رصيدك ${after.toFixed(2)} د.أ — وكالتك خارج التوزيع حتى شحن الرصيد`
        : `رصيدك ${after.toFixed(2)} د.أ دون حد التنبيه (${threshold} د.أ) — اشحن قريباً لتجنب توقف الطلبات`;
      await this.notifications.sendMany(
        staff,
        'LOW_BALANCE',
        crossedZero ? 'رصيد المحفظة نفد' : 'انخفاض رصيد المحفظة',
        bodyAr,
        { agencyId: order.agencyId, balance: after },
      );
    }
  }

  /**
   * قيد الشحن — لا يُستدعى إلا من RechargeService (اعتماد طلب، أو شحن
   * مباشر من المالية). لا مسار HTTP يصل إليه مباشرة: كل زيادة رصيد يقابلها
   * سجل RechargeRequest يحمل من أدخلها ومرجعها.
   */
  async topup(
    agencyId: string,
    amount: number,
    reference: string | undefined,
    actorUserId: string,
    noteAr = 'شحن رصيد',
  ) {
    if (amount <= 0) throw new BadRequestException('مبلغ الشحن يجب أن يكون موجباً');
    const { after, entryId } = await this.applyEntry(agencyId, {
      type: 'TOPUP',
      amount: round2(amount),
      reference,
      noteAr,
      actorUserId,
    });
    this.gateway.emitToAgency(agencyId, 'wallet:updated', { balance: after });
    return { balance: after, entryId };
  }

  /** الفاتورة الشهرية = تجميع حركات الشهر — لا جداول فوترة في V1 */
  async monthlyInvoice(agencyId: string, month: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new BadRequestException('صيغة الشهر: YYYY-MM');
    const start = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    const end = new Date(Number(m[1]), Number(m[2]), 1);

    const wallet = await this.prisma.wallet.findUnique({ where: { agencyId } });
    if (!wallet) throw new NotFoundException('لا محفظة لهذه الوكالة');

    const inPeriod = { walletId: wallet.id, createdAt: { gte: start, lt: end } };
    const [commission, topup, completedOrders] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { ...inPeriod, type: 'COMMISSION' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { ...inPeriod, type: 'TOPUP' },
        _sum: { amount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          agencyId,
          status: 'COMPLETED',
          deliveredAt: { gte: start, lt: end },
        },
        _sum: { total: true },
      }),
    ]);
    return {
      period: month,
      ordersCount: commission._count,
      cashCollected: Number(completedOrders._sum.total ?? 0),
      commissionTotal: round2(Math.abs(Number(commission._sum.amount ?? 0))),
      topupTotal: Number(topup._sum.amount ?? 0),
      currentBalance: Number(wallet.balance),
    };
  }
}
