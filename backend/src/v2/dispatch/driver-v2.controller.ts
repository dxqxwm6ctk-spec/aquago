import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { User } from '@prisma-v2/client';
import { OrderStatus } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';
import {
  DRIVER_CANCEL_REASONS,
  OrdersV2Service,
  type DriverCancelReason,
} from '../orders/orders-v2.service';
import { DispatchService } from './dispatch.service';

class RejectDto {
  @IsOptional() @IsString() reason?: string;
}

class CancelOrderDto {
  @IsIn(Object.keys(DRIVER_CANCEL_REASONS)) reason!: DriverCancelReason;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class DriverStatusDto {
  @IsIn(['AVAILABLE', 'OFFLINE']) status!: 'AVAILABLE' | 'OFFLINE';
}

/** موقع السائق لحظة الضغط — أدقّ من آخر موقع بثّه، والخادم يقبل غيابه */
class ArrivedDto {
  @IsOptional() @IsLatitude() @Type(() => Number) lat?: number;
  @IsOptional() @IsLongitude() @Type(() => Number) lng?: number;
}

class OrderProgressDto {
  @IsIn([OrderStatus.PICKED_UP, OrderStatus.DELIVERING, OrderStatus.COMPLETED])
  status!: OrderStatus;
}

/** واجهات تطبيق السائق (4.2 + 4.3) — نموذج العرض بمؤقت بدل القائمة المفتوحة */
@Controller('v2/driver')
@UseGuards(JwtV2Guard)
export class DriverV2Controller {
  constructor(
    private prisma: PrismaV2Service,
    private dispatch: DispatchService,
    private orders: OrdersV2Service,
  ) {}

  private async requireDriver(userId: string) {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
    });
    if (!profile) throw new ForbiddenException('هذا الحساب ليس حساب سائق');
    return profile;
  }

  /** 4.2: العرض المعلق الحالي — تعيده الشاشة الرئيسية مع مؤقت تنازلي */
  @Get('offers/current')
  async currentOffer(@CurrentUserV2() user: User) {
    await this.requireDriver(user.id);
    const offer = await this.prisma.driverOffer.findFirst({
      where: { driverId: user.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      include: {
        order: {
          select: {
            id: true,
            code: true,
            addressText: true,
            deliveryLat: true,
            deliveryLng: true,
            branchId: true,
            total: true,
            notes: true,
            items: { include: { bottleType: { select: { nameAr: true, sizeLiters: true } } } },
            // العرض موجّه لهذا السائق وحده (driverId في where)، فله أن يعرف
            // لمن سيوصّل قبل أن يقبل — الاسم والرقم فقط.
            customer: { select: { name: true, phone: true } },
          },
        },
      },
    });
    if (!offer) return { offer: null };
    return {
      offer: {
        id: offer.id,
        expiresAt: offer.expiresAt,
        remainingSeconds: Math.max(
          0,
          Math.floor((offer.expiresAt.getTime() - Date.now()) / 1000),
        ),
        // نفس ما يحمله حدث offer:new — العرض الذي وصل بالـSocket والعرض
        // الذي يُقرأ بعد إعادة فتح التطبيق يجب أن يقولا الشيء نفسه
        zone: await this.dispatch.offerZoneFor(offer.order),
        order: offer.order,
      },
    };
  }

  /** 4.3: القبول — نفس الحماية الذرية المختبرة في المحاكي */
  @Post('offers/:offerId/accept')
  async accept(@Param('offerId') offerId: string, @CurrentUserV2() user: User) {
    await this.requireDriver(user.id);
    return this.dispatch.acceptOffer(offerId, user.id);
  }

  @Post('offers/:offerId/reject')
  async reject(
    @Param('offerId') offerId: string,
    @Body() dto: RejectDto,
    @CurrentUserV2() user: User,
  ) {
    await this.requireDriver(user.id);
    await this.dispatch.rejectOffer(offerId, user.id, dto.reason);
    return { ok: true };
  }

  /** متصل/غير متصل — BUSY تُدار من دورة الطلب وليس من هنا */
  @Patch('status')
  async setStatus(@Body() dto: DriverStatusDto, @CurrentUserV2() user: User) {
    const profile = await this.requireDriver(user.id);
    if (profile.status === 'BUSY') {
      throw new ForbiddenException('لديك طلب نشط — أكمله أولاً');
    }
    const updated = await this.prisma.driverProfile.update({
      where: { userId: user.id },
      data: { status: dto.status, lastSeenAt: new Date() },
    });
    // اتصال السائق قد يُخرج طلباً من طابور الانتظار فوراً
    if (dto.status === 'AVAILABLE') {
      await this.dispatch.onDriverAvailable(user.id);
    }
    return updated;
  }

  /** إحصائيات السائق: عدد التوصيلات والتقييم — لا شأن للمنصة بأجره (يحاسبه وكالته) */
  @Get('stats')
  async stats(@CurrentUserV2() user: User) {
    const profile = await this.requireDriver(user.id);
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countCompleted = (gte?: Date) =>
      this.prisma.order.count({
        where: {
          driverId: user.id,
          status: OrderStatus.COMPLETED,
          ...(gte ? { deliveredAt: { gte } } : {}),
        },
      });
    const [completedToday, completedTotal] = await Promise.all([
      countCompleted(startOfDay),
      countCompleted(),
    ]);
    return {
      completedToday,
      completedTotal,
      rating: profile.rating,
      ratingCount: profile.ratingCount,
      status: profile.status,
    };
  }

  /**
   * طلباتي الحالية والسابقة.
   *
   * الاسم وحده هنا بلا رقم: السجل يمتد لخمسين طلباً سابقاً، ولا حاجة تشغيلية
   * لأن يحمل السائق أرقام كل من وصّل لهم. الرقم يصل مع الطلب المفتوح فقط.
   */
  @Get('orders')
  async myOrders(@CurrentUserV2() user: User) {
    await this.requireDriver(user.id);
    return this.prisma.order.findMany({
      where: { driverId: user.id },
      include: {
        items: { include: { bottleType: true } },
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * الطلبات المعلّقة التي يجوز التقاطها — لم يأخذها سائق ولم تُلغَ.
   *
   * ضمن وكالة هذا السائق وحدها: لا يرى طلبات وكالة أخرى ولا يسحبها.
   */
  @Get('claimable-orders')
  async claimableOrders(@CurrentUserV2() user: User) {
    await this.requireDriver(user.id);
    return this.dispatch.claimableOrders(user.id);
  }

  /** يلتقط السائق طلباً معلّقاً — أول من يضغط يأخذه (انظر claimOrder) */
  @Post('claimable-orders/:orderId/claim')
  async claimOrder(
    @Param('orderId') orderId: string,
    @CurrentUserV2() user: User,
  ) {
    await this.requireDriver(user.id);
    return this.dispatch.claimOrder(orderId, user.id);
  }

  /** تقدم التوصيل: PICKED_UP → DELIVERING → COMPLETED */
  @Post('orders/:orderId/status')
  async progress(
    @Param('orderId') orderId: string,
    @Body() dto: OrderProgressDto,
    @CurrentUserV2() user: User,
  ) {
    await this.requireDriver(user.id);
    return this.orders.driverUpdateStatus(orderId, user.id, dto.status);
  }

  /**
   * وصل السائق إلى باب الزبون — يُنادى عند فتح شاشة تأكيد التسليم، أي قبل
   * تحصيل المبلغ. منفصلة عن /status لأنها لا تنقل الحالة: التوصيل ما زال
   * جارياً، والخبر وحده هو المطلوب.
   */
  @Post('orders/:orderId/arrived')
  async arrived(
    @Param('orderId') orderId: string,
    @Body() dto: ArrivedDto,
    @CurrentUserV2() user: User,
  ) {
    await this.requireDriver(user.id);
    return this.orders.driverArrived(orderId, user.id, dto);
  }

  /** أسباب الإلغاء المعروضة للسائق — الخادم مصدرها فلا تفترق عن تحققه */
  @Get('cancel-reasons')
  cancelReasons() {
    return Object.entries(DRIVER_CANCEL_REASONS).map(([code, labelAr]) => ({
      code,
      labelAr,
    }));
  }

  /** انسحاب السائق بعد القبول وقبل التسليم — سبب إلزامي، والطلب يُلغى */
  @Post('orders/:orderId/cancel')
  async cancelOrder(
    @Param('orderId') orderId: string,
    @Body() dto: CancelOrderDto,
    @CurrentUserV2() user: User,
  ) {
    await this.requireDriver(user.id);
    return this.orders.cancelByDriver(orderId, user.id, dto.reason, dto.note);
  }
}
