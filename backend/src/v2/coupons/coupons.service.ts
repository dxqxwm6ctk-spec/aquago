import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CouponType, Prisma } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CouponInput {
  code: string;
  descAr?: string | null;
  type: CouponType;
  value: number;
  maxDiscount?: number | null;
  minOrderTotal?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  usageLimit?: number | null;
  perUserLimit?: number | null;
  cityIds?: string[];
  active?: boolean;
}

/** ما يُعاد للزبون عند التحقق قبل التأكيد */
export interface CouponQuote {
  couponId: string;
  code: string;
  descAr: string | null;
  discount: number;
}

/**
 * كوبونات الخصم.
 *
 * **من يتحمّل الخصم: المنصة، من عمولتها هي.**
 *
 * الزبون يدفع نقداً أقل بمقدار الخصم، وتُخصم من الوكالة عمولةٌ أقل بالمقدار
 * نفسه — فتخرج الوكالة من الطلب بثمن المياه كاملاً كأن لا كوبون. الحملة
 * الترويجية قرار المنصة، فتكلفتها على المنصة لا على وكيلٍ لم يخترها.
 *
 * ولذلك **يُقيَّد الخصم بسقف العمولة**: أكثر من ذلك يعني أن تدفع المنصة من
 * جيبها للوكالة، وهو ما لا يفعله هذا النموذج. الحساب:
 *
 *   الزبون يدفع = المياه + العمولة − الخصم
 *   يُخصم من محفظة الوكالة = العمولة − الخصم
 *   صافي الوكالة = المياه (ثابت مهما كان الخصم)
 *
 * الخصم يبقى مخزَّناً على الطلب ويُعرض للوكالة والسائق: نقصٌ في الكاش بلا
 * سبب ظاهر يبدو خطأ تحصيل ويولّد شكوى.
 *
 * **لماذا لا نطاق بالوكالات:** الوكالة تُسنَد بعد إنشاء الطلب، والخصم يُحسب
 * لحظة الإنشاء ليراه الزبون قبل أن يؤكد. شرطٌ على وكالة لم تُعرف بعدُ لا
 * سبيل للتحقق منه إلا بتغيير الإجمالي بعد التأكيد — وهذا ما نرفضه أصلاً في
 * `expectedTotal`.
 */
@Injectable()
export class CouponsService {
  constructor(private prisma: PrismaV2Service) {}

  // ============ إدارة المنصة ============

  async list() {
    const coupons = await this.prisma.coupon.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      include: { cities: { include: { city: { select: { nameAr: true } } } } },
    });
    return coupons.map((c) => ({
      ...c,
      cityNames: c.cities.map((x) => x.city.nameAr),
      cityIds: c.cities.map((x) => x.cityId),
      state: this.state(c),
    }));
  }

  async create(data: CouponInput, actorId: string) {
    // `clean` يتحقق ويطبّع؛ الحقول الإلزامية مضمونة بـ CouponInput والـ DTO
    const clean = this.clean(data) as Prisma.CouponUncheckedCreateInput;
    const coupon = await this.prisma.coupon.create({
      data: {
        ...clean,
        cities: data.cityIds?.length
          ? { create: data.cityIds.map((cityId) => ({ cityId })) }
          : undefined,
      },
    });
    await this.audit(actorId, 'create', coupon.id, undefined, coupon);
    return coupon;
  }

  async update(id: string, data: Partial<CouponInput>, actorId: string) {
    const current = await this.get(id);
    const clean = this.clean(data, current.type);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.cityIds !== undefined) {
        // استبدال كامل لا دمج: اللوحة ترسل القائمة النهائية دائماً
        await tx.couponCity.deleteMany({ where: { couponId: id } });
        if (data.cityIds.length) {
          await tx.couponCity.createMany({
            data: data.cityIds.map((cityId) => ({ couponId: id, cityId })),
          });
        }
      }
      return tx.coupon.update({ where: { id }, data: clean });
    });
    await this.audit(actorId, 'update', id, current, updated);
    return updated;
  }

  /**
   * الحذف مسموح ما لم يُستعمل الكوبون. المستعمَل يُعطَّل فقط — حذفه يقطع
   * أثر خصمٍ حُسب على فاتورة وكالة، وهذا سجل مالي لا يُمحى.
   */
  async remove(id: string, actorId: string) {
    const coupon = await this.get(id);
    const used = await this.prisma.couponRedemption.count({
      where: { couponId: id },
    });
    if (used > 0) {
      throw new BadRequestException(
        `استُخدم هذا الكوبون ${used} مرة — عطّله بدل حذفه حتى يبقى أثر الخصومات`,
      );
    }
    await this.prisma.coupon.delete({ where: { id } });
    await this.audit(actorId, 'delete', id, coupon, undefined);
    return { id, deleted: true };
  }

  async get(id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('الكوبون غير موجود');
    return coupon;
  }

  /** استخدامات كوبون بعينه — لمن يريد أن يعرف أين ذهب الخصم */
  async redemptions(id: string) {
    await this.get(id);
    return this.prisma.couponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        customer: { select: { name: true, phone: true } },
        order: {
          select: {
            code: true,
            total: true,
            status: true,
            agency: { select: { nameAr: true } },
          },
        },
      },
    });
  }

  // ============ التطبيق على الطلب ============

  /**
   * يتحقق من الكوبون ويحسب الخصم — بلا تسجيل استخدام.
   * يُستعمل لمعاينة الزبون قبل التأكيد، ومن داخل إنشاء الطلب.
   *
   * [subtotalPlusCommission] هو الإجمالي قبل الخصم: الخصم يُحسب عليه كاملاً
   * لأن الوكالة تتحمّله، فلا معنى لاستثناء العمولة منه.
   */
  async quote(input: {
    code: string;
    customerId: string;
    cityId: string | null;
    orderTotal: number;
    /// عمولة المنصة على هذا الطلب — سقف الخصم، فالمنصة تموّله منها
    commission: number;
  }): Promise<CouponQuote> {
    const code = this.normalizeCode(input.code);
    const coupon = await this.prisma.coupon.findUnique({
      where: { code },
      include: { cities: { select: { cityId: true } } },
    });
    if (!coupon) throw new BadRequestException('رمز الكوبون غير صحيح');
    if (!coupon.active) throw new BadRequestException('هذا الكوبون غير مفعّل');

    const now = new Date();
    if (coupon.startsAt && now < coupon.startsAt) {
      throw new BadRequestException('لم يبدأ سريان هذا الكوبون بعد');
    }
    if (coupon.endsAt && now > coupon.endsAt) {
      throw new BadRequestException('انتهت صلاحية هذا الكوبون');
    }
    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('استُنفد هذا الكوبون');
    }
    if (coupon.cities.length) {
      // موقع لم يُحلّ إلى مدينة لا يمكن إثبات أنه ضمن النطاق — نرفض بدل أن
      // نمنح خصماً قد يكون خارج الحملة
      if (!input.cityId || !coupon.cities.some((c) => c.cityId === input.cityId)) {
        throw new BadRequestException('هذا الكوبون لا يشمل منطقتك');
      }
    }
    const minOrder = coupon.minOrderTotal ? Number(coupon.minOrderTotal) : null;
    if (minOrder !== null && input.orderTotal < minOrder) {
      throw new BadRequestException(
        `الكوبون يبدأ من ${minOrder.toFixed(2)} د.أ — أضف المزيد للاستفادة منه`,
      );
    }
    if (coupon.perUserLimit !== null) {
      const mine = await this.prisma.couponRedemption.count({
        where: { couponId: coupon.id, customerId: input.customerId },
      });
      if (mine >= coupon.perUserLimit) {
        throw new BadRequestException('استخدمت هذا الكوبون بالحد المسموح لك');
      }
    }

    const discount = this.discountFor(coupon, input.orderTotal, input.commission);
    if (discount <= 0) {
      throw new BadRequestException('لا خصم متاح على هذا الطلب');
    }
    return {
      couponId: coupon.id,
      code: coupon.code,
      descAr: coupon.descAr,
      discount,
    };
  }

  /**
   * قيمة الخصم، مقيّدة بسقفها وبالإجمالي نفسه: خصمٌ يتجاوز الإجمالي كان
   * سيجعل المطلوب سالباً — أي أن يدفع السائقُ الزبونَ.
   */
  discountFor(
    coupon: { type: CouponType; value: Prisma.Decimal; maxDiscount: Prisma.Decimal | null },
    orderTotal: number,
    commission: number,
  ): number {
    const value = Number(coupon.value);
    let discount =
      coupon.type === 'PERCENT' ? (orderTotal * value) / 100 : value;
    if (coupon.maxDiscount) {
      discount = Math.min(discount, Number(coupon.maxDiscount));
    }
    // سقف العمولة أولاً: الخصم يُموَّل منها، وتجاوزه يجعل المنصة تدفع للوكالة.
    // وسقف الإجمالي بعده: خصمٌ يتجاوزه كان سيجعل المطلوب من الزبون سالباً.
    return round2(
      Math.max(0, Math.min(discount, Math.max(0, commission), orderTotal)),
    );
  }

  /**
   * يحجز استخدام الكوبون داخل معاملة إنشاء الطلب.
   *
   * السقف الكلي يُفرض بزيادة مشروطة (`updateMany` بشرط العدّاد) لا بقراءة ثم
   * كتابة: طلبان متزامنان كانا يقرآن العدد نفسه ويمرّان معاً. وسقف كل زبون
   * يُفرض بفهرس فريد على (الكوبون، الزبون، الترتيب) — المتزامنان يحسبان
   * الترتيب نفسه فيسقط أحدهما على القيد.
   */
  async redeemInTx(
    tx: Prisma.TransactionClient,
    input: {
      couponId: string;
      customerId: string;
      orderId: string;
      amount: number;
    },
  ) {
    const coupon = await tx.coupon.findUnique({
      where: { id: input.couponId },
      select: { usageLimit: true, perUserLimit: true },
    });
    if (!coupon) throw new BadRequestException('رمز الكوبون غير صحيح');

    const claimed = await tx.coupon.updateMany({
      where: {
        id: input.couponId,
        active: true,
        ...(coupon.usageLimit !== null
          ? { usedCount: { lt: coupon.usageLimit } }
          : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count === 0) throw new BadRequestException('استُنفد هذا الكوبون');

    const mine = await tx.couponRedemption.count({
      where: { couponId: input.couponId, customerId: input.customerId },
    });
    if (coupon.perUserLimit !== null && mine >= coupon.perUserLimit) {
      throw new BadRequestException('استخدمت هذا الكوبون بالحد المسموح لك');
    }
    await tx.couponRedemption.create({
      data: {
        couponId: input.couponId,
        customerId: input.customerId,
        orderId: input.orderId,
        amount: input.amount,
        userSeq: mine + 1,
      },
    });
  }

  /**
   * يعيد الاستخدام إلى الكوبون عند إلغاء الطلب — الزبون الذي ألغى لم ينتفع
   * بالخصم، وحرقُ كوبونه على طلب لم يصل شكوى مؤكدة.
   *
   * لا يرمي أبداً: يُنادى من مسار الإلغاء، وفشل الإرجاع لا يصح أن يمنع إلغاء
   * طلب — أسوأ ما يقع أن يبقى استخدام محجوزاً.
   */
  async releaseForOrder(orderId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const redemption = await tx.couponRedemption.findUnique({
          where: { orderId },
        });
        if (!redemption) return;
        await tx.couponRedemption.delete({ where: { orderId } });
        await tx.coupon.updateMany({
          where: { id: redemption.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        });
      });
    } catch {
      // متروك عمداً — انظر شرح الدالة
    }
  }

  // ============ مساعدات ============

  private normalizeCode(code: string) {
    return code.trim().toUpperCase().replace(/\s+/g, '');
  }

  private state(c: {
    active: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
    usageLimit: number | null;
    usedCount: number;
  }) {
    if (!c.active) return 'DISABLED';
    const now = new Date();
    if (c.startsAt && now < c.startsAt) return 'SCHEDULED';
    if (c.endsAt && now > c.endsAt) return 'EXPIRED';
    if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  private clean(data: Partial<CouponInput>, currentType?: CouponType) {
    const out: Record<string, unknown> = {};
    if (data.code !== undefined) {
      const code = this.normalizeCode(data.code);
      if (!code) throw new BadRequestException('رمز الكوبون مطلوب');
      out.code = code;
    }
    if (data.descAr !== undefined) out.descAr = data.descAr?.trim() || null;
    if (data.type !== undefined) out.type = data.type;
    if (data.active !== undefined) out.active = data.active;

    const type = data.type ?? currentType;
    if (data.value !== undefined) {
      if (type === 'PERCENT' && !(data.value > 0 && data.value <= 100)) {
        throw new BadRequestException('نسبة الخصم بين 1 و100');
      }
      if (type === 'FIXED' && !(data.value > 0)) {
        throw new BadRequestException('قيمة الخصم يجب أن تكون أكبر من صفر');
      }
      out.value = data.value;
    }
    // سقف الخصم لا معنى له لمبلغ ثابت — يُمسح بدل أن يُخزَّن مضلّلاً
    if (data.maxDiscount !== undefined) {
      out.maxDiscount = type === 'PERCENT' ? (data.maxDiscount ?? null) : null;
    }
    if (data.minOrderTotal !== undefined) out.minOrderTotal = data.minOrderTotal ?? null;
    if (data.usageLimit !== undefined) out.usageLimit = data.usageLimit ?? null;
    if (data.perUserLimit !== undefined) out.perUserLimit = data.perUserLimit ?? null;

    const startsAt = data.startsAt === undefined ? undefined : this.date(data.startsAt);
    const endsAt = data.endsAt === undefined ? undefined : this.date(data.endsAt);
    if (startsAt !== undefined) out.startsAt = startsAt;
    if (endsAt !== undefined) out.endsAt = endsAt;
    if (startsAt && endsAt && startsAt > endsAt) {
      throw new BadRequestException('تاريخ البداية بعد تاريخ النهاية');
    }
    return out;
  }

  private date(v: string | null) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('تاريخ غير صالح');
    return d;
  }

  private audit(
    actorUserId: string,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    oldValue?: unknown,
    newValue?: unknown,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: `coupon.${action}`,
        entityType: 'Coupon',
        entityId,
        oldValue: oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
        newValue: newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
      },
    });
  }
}
