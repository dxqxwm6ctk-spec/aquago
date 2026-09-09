import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { CouponType, PaymentMethod, RechargeStatus, User } from '@prisma-v2/client';
import { TicketStatus, UserStatus } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { CouponsService } from '../coupons/coupons.service';
import { PaymentAccountsService } from '../finance/payment-accounts.service';
import { RechargeService } from '../finance/recharge.service';
import { SupportService } from '../support/support.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { OrderChatService } from '../orders/order-chat.service';
import { SubscriptionService } from '../finance/subscription.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { OrdersV2Service } from '../orders/orders-v2.service';
import { GRANTABLE_PLATFORM_ROLES, PlatformService } from './platform.service';

class ApproveRechargeDto {
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() noteAr?: string;
}

class RejectRechargeDto {
  @IsString() @IsNotEmpty() reasonAr!: string;
}

const PAYMENT_METHODS = ['BANK_TRANSFER', 'CLIQ', 'EFAWATEERCOM', 'CASH'] as const;

/** بطاقة مطوّر — الاسم وحده إلزامي، وما عداه زينة تُضاف متى شئت */
class CreateAppDeveloperDto {
  @IsString() @IsNotEmpty() @MaxLength(60) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(60) roleAr?: string;
  @IsOptional() @IsString() @MaxLength(300) url?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsInt() @Min(0) @Max(999) @Type(() => Number) sort?: number;
}

class UpdateAppDeveloperDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) nameAr?: string;
  /// نص فارغ = إزالة الحقل، لذلك لا @IsNotEmpty هنا
  @IsOptional() @IsString() @MaxLength(60) roleAr?: string;
  @IsOptional() @IsString() @MaxLength(300) url?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsInt() @Min(0) @Max(999) @Type(() => Number) sort?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** إلغاء إداري — السبب إلزامي لأنه يُعرض على الزبون */
class CancelOrderDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reasonAr!: string;
}

/** تصفير ترقيم الطلبات — الأرقام القديمة تبقى، والعدّ يبدأ من جديد */
class ResetOrderCounterDto {
  @IsOptional() @IsInt() @Min(1) @Max(9999999) @Type(() => Number) startFrom?: number;
  @IsOptional() @IsString() prefix?: string;
}

/** شحن مباشر تختار فيه المالية الوكالة — الحدود نفسها يفرضها RechargeService */
/** حذف الطلبات القديمة — الحد الأدنى للعمر يفرضه PlatformService أيضاً */
class PurgeOrdersDto {
  @IsInt() @Min(30) @Max(3650) @Type(() => Number) olderThanDays!: number;
}

class DirectTopupDto {
  @IsNumber() @Type(() => Number) amount!: number;
  @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() @MaxLength(200) noteAr?: string;
}

class CreatePaymentAccountDto {
  @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  @IsString() @IsNotEmpty() holderNameAr!: string;
  @IsString() @IsNotEmpty() accountNumber!: string;
  /// رابط دفع اختياري يُرمَّز في الـQR بدل رقم الحساب
  @IsOptional() @IsString() paymentLink?: string;
  @IsOptional() @IsString() bankNameAr?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Type(() => Number) sortOrder?: number;
}

class UpdatePaymentAccountDto {
  @IsOptional() @IsIn(PAYMENT_METHODS) method?: PaymentMethod;
  @IsOptional() @IsString() @IsNotEmpty() holderNameAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() accountNumber?: string;
  /// نص فارغ يعني إزالة الرابط — لذلك لا @IsNotEmpty هنا
  @IsOptional() @IsString() paymentLink?: string;
  @IsOptional() @IsString() bankNameAr?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Type(() => Number) sortOrder?: number;
}

class QrPreviewDto {
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsString() paymentLink?: string;
}

class CreateCouponDto {
  @IsString() @IsNotEmpty() code!: string;
  @IsOptional() @IsString() descAr?: string;
  @IsIn(['PERCENT', 'FIXED']) type!: CouponType;
  @IsNumber() @Min(0.01) @Type(() => Number) value!: number;
  @IsOptional() @IsNumber() @Min(0.01) @Type(() => Number) maxDiscount?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minOrderTotal?: number | null;
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() endsAt?: string | null;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) usageLimit?: number | null;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) perUserLimit?: number | null;
  /// قائمة نهائية لا إضافة — فارغة تعني كل المدن
  @IsOptional() @IsArray() @IsString({ each: true }) cityIds?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

class UpdateCouponDto {
  @IsOptional() @IsString() @IsNotEmpty() code?: string;
  @IsOptional() @IsString() descAr?: string;
  @IsOptional() @IsIn(['PERCENT', 'FIXED']) type?: CouponType;
  @IsOptional() @IsNumber() @Min(0.01) @Type(() => Number) value?: number;
  @IsOptional() @IsNumber() @Min(0.01) @Type(() => Number) maxDiscount?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minOrderTotal?: number | null;
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() endsAt?: string | null;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) usageLimit?: number | null;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) perUserLimit?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) cityIds?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

class TicketStatusDto {
  @IsIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']) status!: TicketStatus;
}

class TicketReplyDto {
  @IsString() @IsNotEmpty() bodyAr!: string;
}

class RescueAssignDto {
  @IsString() @IsNotEmpty() agencyId!: string;
  /// بلا سائق: الوكالة تعيّن من لوحتها. بسائق: عرض مباشر له
  @IsOptional() @IsString() driverId?: string;
}

class NotifyAgencyDto {
  @IsString() @IsNotEmpty() agencyId!: string;
}

const BROADCAST_AUDIENCES = ['ALL', 'CUSTOMERS', 'DRIVERS', 'AGENCIES', 'AGENCY'] as const;

class BroadcastNotificationDto {
  @IsIn(BROADCAST_AUDIENCES) audience!: (typeof BROADCAST_AUDIENCES)[number];
  /// مطلوب فقط حين audience = AGENCY
  @IsOptional() @IsString() agencyId?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) titleAr!: string;
  @IsString() @IsNotEmpty() @MaxLength(500) bodyAr!: string;
  /// true = إشعار خارجي (Push للجهاز أيضاً)، false = داخلي فقط (سجل التطبيق)
  @IsBoolean() push!: boolean;
}

class SubPaymentReviewDto {
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() noteAr?: string;
}

class SubEnabledDto {
  @IsBoolean() enabled!: boolean;
}

/** يُتحقق من الرقم يدوياً بالخدمة (null صالح ويمسح التخصيص) — راجع SubscriptionService.setPriceOverride */
class SubPriceDto {
  @IsOptional() price?: number | null;
}

class SubPaymentRejectDto {
  @IsString() @IsNotEmpty() reasonAr!: string;
}

class SupportBlockDto {
  @IsBoolean() blocked!: boolean;
  /// يُعرض للمستخدم نفسه حين يحاول المراسلة، فيعرف لماذا توقف
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

class CreateCityDto {
  @IsString() @IsNotEmpty() nameAr!: string;
}

class CityActiveDto {
  @IsBoolean() active!: boolean;
}

class CreateDistrictDto {
  @IsString() @IsNotEmpty() cityId!: string;
  @IsString() @IsNotEmpty() nameAr!: string;
}

class UpdateDistrictDto {
  @IsOptional() @IsString() @IsNotEmpty() nameAr?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CreateNeighborhoodDto {
  @IsString() @IsNotEmpty() districtId!: string;
  @IsString() @IsNotEmpty() nameAr!: string;
}

class UpdateNeighborhoodDto {
  @IsOptional() @IsString() @IsNotEmpty() nameAr?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CreateZoneDto {
  @IsString() @IsNotEmpty() cityId!: string;
  @IsOptional() @IsString() @IsNotEmpty() neighborhoodId?: string;
  @IsString() @IsNotEmpty() nameAr!: string;
  @IsNumber() @Type(() => Number) lat!: number;
  @IsNumber() @Type(() => Number) lng!: number;
  @IsInt() @Min(200) @Max(20000) @Type(() => Number) radiusM!: number;
}

class UpdateZoneDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() neighborhoodId?: string | null;
}

class UserStatusDto {
  @IsIn(['ACTIVE', 'DISABLED']) status!: UserStatus;
}

class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() @IsNotEmpty() phone?: string;
  @IsOptional() @IsEmail() email?: string;
}

class UpdatePlatformEmployeeDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() @IsNotEmpty() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  // من القائمة نفسها التي تفحصها الخدمة — نسختان تفترقان عند أول دور جديد
  @IsOptional() @IsIn(GRANTABLE_PLATFORM_ROLES as readonly string[]) role?: string;
}

// كلمة المرور غير مقبولة هنا عمداً — النظام وحده يولّدها
class CreateEmployeeDto {
  @IsString() @IsNotEmpty() username!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsIn(GRANTABLE_PLATFORM_ROLES as readonly string[]) role!: string;
}

class CreateBottleDto {
  @IsString() @IsNotEmpty() nameAr!: string;
  /// الحدّ الأدنى 1.5 لتر: أصغر عبوة في الكتالوج، وما دونها خطأ إدخال
  /// (لتر واحد أو أقل ليس منتجًا يُوصَّل).
  @IsNumber() @Min(1.5) @Type(() => Number) sizeLiters!: number;
  @IsNumber() @Min(0.1) @Type(() => Number) price!: number;
  @IsOptional() @IsInt() @Type(() => Number) sort?: number;
  @IsOptional() @IsString() imageUrl?: string;
}

class UpdateBottleDto {
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsNumber() @Min(0.1) @Type(() => Number) price?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Type(() => Number) sort?: number;
  /// نص فارغ يعني إزالة الصورة — يُطبَّع إلى null قبل وصوله هنا
  @IsOptional() @IsString() imageUrl?: string | null;
}

class CreatePromoBannerDto {
  @IsString() @IsNotEmpty() imageUrl!: string;
  /// لأي تطبيق يظهر — الافتراضي الزبون كما كانت البانرات قبل الفصل
  @IsOptional() @IsIn(['CUSTOMER', 'DRIVER']) audience?: 'CUSTOMER' | 'DRIVER';
  /// فارغ يعني بلا رابط — لمسة الزبون لا تفعل شيئاً
  @IsOptional() @IsString() linkUrl?: string | null;
  @IsOptional() @IsInt() @Type(() => Number) sort?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class UpdatePromoBannerDto {
  @IsOptional() @IsIn(['CUSTOMER', 'DRIVER']) audience?: 'CUSTOMER' | 'DRIVER';
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() linkUrl?: string | null;
  @IsOptional() @IsInt() @Type(() => Number) sort?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** قنوات إيصال رمز التحقق — تطابق enum OtpChannel في المخطط */
const OTP_CHANNELS = ['OPENWA', 'META_WHATSAPP', 'EMAIL'] as const;
type OtpChannelValue = (typeof OTP_CHANNELS)[number];

class OtpChannelDto {
  @IsIn(OTP_CHANNELS) channel!: OtpChannelValue;
}

/** رقم بوابة واتساب — فارغ أو null يعني تعطيل مسار المصافحة */
class WaGatewayNumberDto {
  @IsOptional() @IsString() number?: string | null;
}

class OtpOverrideDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsIn(OTP_CHANNELS) channel!: OtpChannelValue;
  /** يُستعمل حين تكون القناة EMAIL ولا بريد على الحساب (أو لا حساب بعد) */
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() note?: string;
}

class DispatchSettingsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) distanceWeight?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) availabilityWeight?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) driverAvailabilityWeight?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) loadWeight?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) ratingWeight?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) @Type(() => Number) responseRateWeight?: number;
  @IsOptional() @IsInt() @Min(5) @Max(120) @Type(() => Number) offerTimeoutSeconds?: number;
  @IsOptional() @IsInt() @Min(30) @Max(3600) @Type(() => Number) manualAssignTimeoutSeconds?: number;
  // سقف انتظار السائق قبل الإلغاء التلقائي، وفاصل إعادة الفحص أثناء الانتظار
  @IsOptional() @IsInt() @Min(60) @Max(3600) @Type(() => Number) maxWaitForDriverSeconds?: number;
  @IsOptional() @IsInt() @Min(10) @Max(300) @Type(() => Number) waitRetryIntervalSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) @Type(() => Number) maxDriversPerAgency?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) @Type(() => Number) maxAgenciesPerOrder?: number;
  // كم جولة يُعاد فيها العرض على من لم يردّ (1 = بلا إعادة)
  @IsOptional() @IsInt() @Min(1) @Max(5) @Type(() => Number) maxDispatchRounds?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) lowBalanceThreshold?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minBalanceForDispatch?: number;
  // مبلغ ثابت بالدينار عن كل طلب (مثال 0.25 = ربع دينار)
  @IsOptional() @IsNumber() @Min(0) @Max(10) @Type(() => Number) commissionPerOrder?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(50) @Type(() => Number) maxDeliveryRadiusKm?: number;
  /// قيمة اشتراك الوكالة الشهري (د.أ) — صفر يوقف الفوترة تماماً
  @IsOptional() @IsNumber() @Min(0) @Max(10000) @Type(() => Number) subscriptionMonthlyPrice?: number;
  /// هل يرى المستخدم اسم موظف الدعم الذي ردّ عليه؟
  @IsOptional() @IsBoolean() showSupportAgentName?: boolean;
  /// سياج «وصلتُ»: تشغيله ونصف قطره بالأمتار
  @IsOptional() @IsBoolean() arrivalGeofenceEnabled?: boolean;
  @IsOptional() @IsBoolean() respectWorkingHours?: boolean;
  @IsOptional() @IsInt() @Min(20) @Max(5000) @Type(() => Number) arrivalRadiusMeters?: number;
}

@Controller('v2/platform')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class PlatformController {
  constructor(
    private platform: PlatformService,
    private recharge: RechargeService,
    private paymentAccounts: PaymentAccountsService,
    private coupons: CouponsService,
    private support: SupportService,
    private dispatch: DispatchService,
    private orderChat: OrderChatService,
    private subscriptions_: SubscriptionService,
    private ordersService: OrdersV2Service,
  ) {}

  @Get('stats')
  @RequirePermissions('platform.reports.view')
  stats() {
    return this.platform.stats();
  }

  @Get('profits')
  @RequirePermissions('platform.reports.view')
  profits(
    @Query('range') range: 'today' | 'week' | 'month' | 'custom' = 'today',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.platform.profits(range, from, to);
  }

  @Get('orders')
  @RequirePermissions('orders.view')
  orders(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('group') group?: string,
    @Query('days') days?: string,
  ) {
    return this.platform.listOrders(status, q, group, Number(days) || undefined);
  }

  /**
   * محادثة الطلب بين الزبون والسائق — **قراءة فقط**.
   *
   * تُقرأ لفضّ نزاع: «قال له انتظر ولم يأتِ»، «طلب منه يترك القارورة عند
   * الباب». ولا مدخل للكتابة: المحادثة تبقى بين طرفيها، ورسالةٌ تظهر فجأة
   * من طرف ثالث تربك من يقرأها.
   */
  @Get('orders/:orderId/chat')
  @RequirePermissions('orders.view')
  orderChatHistory(@Param('orderId') orderId: string) {
    return this.orderChat.supervisorHistory(orderId);
  }

  /** أعداد مجموعات الطلبات ضمن نفس النافذة — أرقام التبويبات */
  @Get('orders-counts')
  @RequirePermissions('orders.view')
  orderGroupCounts(@Query('days') days?: string, @Query('q') q?: string) {
    return this.platform.orderGroupCounts(Number(days) || undefined, q);
  }

  /** تحليلات الطلبات: التوزيع، والسلسلة اليومية، والمال، والمدد */
  @Get('orders-analytics')
  @RequirePermissions('platform.reports.view')
  orderAnalytics(@Query('days') days?: string) {
    return this.platform.orderAnalytics(Number(days) || 30);
  }

  /** تقييمات الزبائن كما كُتبت — نجومها وكلامها منسوبةً لطلبها ووكالتها */
  @Get('ratings')
  @RequirePermissions('orders.view')
  ratings(@Query('stars') stars?: string) {
    return this.platform.listRatings(stars ? Number(stars) : undefined);
  }

  /**
   * خيارات إنقاذ طلب عالق: الوكالات بالأقرب وأسباب استبعاد كلٍّ منها،
   * وسائقوها بحالتهم وبُعدهم. تشمل من هو خارج نطاقه — القرار بشري.
   */
  @Get('orders/:orderId/rescue-options')
  @RequirePermissions('orders.assign')
  rescueOptions(@Param('orderId') orderId: string) {
    return this.dispatch.rescueOptions(orderId);
  }

  /** إسناد يدوي يتجاوز شروط الأهلية — للطلبات العالقة وحدها */
  @Post('orders/:orderId/rescue-assign')
  @RequirePermissions('orders.assign')
  rescueAssign(
    @Param('orderId') orderId: string,
    @Body() dto: RescueAssignDto,
    @CurrentUserV2() user: User,
  ) {
    return this.dispatch.rescueAssign(
      orderId,
      dto.agencyId,
      dto.driverId,
      user.id,
    );
  }

  /**
   * إلغاء إداري لطلب عالق — حين لا يوجد من يخدمه أصلاً، أو بقي معلّقاً بلا
   * حل. السبب يظهر للزبون وفي سجل الطلب.
   */
  @Post('orders/:orderId/cancel')
  @RequirePermissions('orders.cancel')
  cancelOrder(
    @Param('orderId') orderId: string,
    @Body() dto: CancelOrderDto,
    @CurrentUserV2() user: User,
  ) {
    return this.ordersService.cancelByPlatform(orderId, user.id, dto.reasonAr);
  }

  /** إبلاغ وكالة بطلب بلا إسناده إليها */
  @Post('orders/:orderId/notify-agency')
  @RequirePermissions('orders.assign')
  notifyAgency(
    @Param('orderId') orderId: string,
    @Body() dto: NotifyAgencyDto,
  ) {
    return this.dispatch.notifyAgencyOfOrder(orderId, dto.agencyId);
  }

  /** إشعار مخصص من الأدمن — بث لفئة مستخدمين (الكل/زبائن/سائقين/وكالة معينة) */
  @Post('notifications/broadcast')
  @RequirePermissions('platform.notifications.send')
  broadcastNotification(
    @Body() dto: BroadcastNotificationDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.broadcastNotification(
      user.id,
      dto.audience,
      dto.agencyId,
      dto.titleAr,
      dto.bodyAr,
      dto.push,
    );
  }

  @Get('orders/:orderId/timeline')
  @RequirePermissions('orders.view')
  timeline(@Param('orderId') orderId: string) {
    return this.platform.orderTimeline(orderId);
  }

  @Get('tickets')
  @RequirePermissions('platform.tickets.manage')
  tickets(@Query('status') status?: string) {
    return this.platform.listTickets(status);
  }

  @Patch('tickets/:ticketId')
  @RequirePermissions('platform.tickets.manage')
  updateTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: TicketStatusDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateTicket(ticketId, dto, user.id);
  }

  /** تفريغ شامل: حذف كل التذاكر وكل الرسائل نهائياً — لا رجعة فيه */
  @Delete('tickets')
  @RequirePermissions('platform.tickets.manage')
  wipeAllTickets(@CurrentUserV2() user: User) {
    return this.support.wipeAll(user.id);
  }

  @Get('tickets/:ticketId/messages')
  @RequirePermissions('platform.tickets.manage')
  ticketMessages(@Param('ticketId') ticketId: string) {
    return this.platform.ticketMessages(ticketId);
  }

  @Post('tickets/:ticketId/reply')
  @RequirePermissions('platform.tickets.manage')
  replyToTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: TicketReplyDto,
    @CurrentUserV2() user: User,
  ) {
    return this.support.replyFromDashboard(ticketId, user.id, dto.bodyAr);
  }

  /** قبول طلب التواصل — يفتح الدردشة بلا سقف رسائل */
  @Post('tickets/:ticketId/accept')
  @RequirePermissions('platform.tickets.manage')
  acceptTicket(
    @Param('ticketId') ticketId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.support.acceptRequest(ticketId, user.id);
  }

  /** حظر مراسلة الدعم — لا يمنع الدخول ولا الطلب (لذلك setUserStatus) */
  @Post('users/:userId/support-block')
  @RequirePermissions('platform.tickets.manage')
  setSupportBlock(
    @Param('userId') userId: string,
    @Body() dto: SupportBlockDto,
    @CurrentUserV2() user: User,
  ) {
    return this.support.setSupportBlock(
      userId,
      dto.blocked,
      dto.reason,
      user.id,
    );
  }

  @Get('cities')
  @RequirePermissions('platform.cities.manage')
  cities() {
    return this.platform.listCities();
  }

  @Post('cities')
  @RequirePermissions('platform.cities.manage')
  createCity(@Body() dto: CreateCityDto, @CurrentUserV2() user: User) {
    return this.platform.createCity(dto.nameAr, user.id);
  }

  @Patch('cities/:cityId')
  @RequirePermissions('platform.cities.manage')
  setCityActive(
    @Param('cityId') cityId: string,
    @Body() dto: CityActiveDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.setCityActive(cityId, dto.active, user.id);
  }

  // القراءة تحت zones.manage ليتمكن فريق العمليات من ربط مناطق التغطية بالأحياء؛
  // الإنشاء والتعديل تحت cities.manage (المدير الأعلى)
  @Get('districts')
  @RequirePermissions('platform.zones.manage')
  districts(@Query('cityId') cityId?: string) {
    return this.platform.listDistricts(cityId);
  }

  @Post('districts')
  @RequirePermissions('platform.cities.manage')
  createDistrict(@Body() dto: CreateDistrictDto, @CurrentUserV2() user: User) {
    return this.platform.createDistrict(dto.cityId, dto.nameAr, user.id);
  }

  @Patch('districts/:districtId')
  @RequirePermissions('platform.cities.manage')
  updateDistrict(
    @Param('districtId') districtId: string,
    @Body() dto: UpdateDistrictDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateDistrict(districtId, dto, user.id);
  }

  @Get('neighborhoods')
  @RequirePermissions('platform.zones.manage')
  neighborhoods(@Query('districtId') districtId?: string, @Query('cityId') cityId?: string) {
    return this.platform.listNeighborhoods(districtId, cityId);
  }

  @Post('neighborhoods')
  @RequirePermissions('platform.cities.manage')
  createNeighborhood(@Body() dto: CreateNeighborhoodDto, @CurrentUserV2() user: User) {
    return this.platform.createNeighborhood(dto.districtId, dto.nameAr, user.id);
  }

  @Patch('neighborhoods/:neighborhoodId')
  @RequirePermissions('platform.cities.manage')
  updateNeighborhood(
    @Param('neighborhoodId') neighborhoodId: string,
    @Body() dto: UpdateNeighborhoodDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateNeighborhood(neighborhoodId, dto, user.id);
  }

  @Get('geo/boundaries')
  @RequirePermissions('platform.zones.manage')
  geoBoundaries() {
    return this.platform.geoBoundaries();
  }

  /** خريطة الوكالات والتغطية — نقاط + دوائر نطاق + حالة تشغيلية */
  @Get('coverage/map')
  @RequirePermissions('platform.agencies.manage')
  coverageMap(@Query('cityId') cityId?: string) {
    return this.platform.coverageMap(cityId || undefined);
  }

  /** فجوات التغطية — نسبة تغطية كل منطقة إدارية (أين تحتاج وكالة جديدة) */
  @Get('coverage/gaps')
  @RequirePermissions('platform.agencies.manage')
  coverageGaps(@Query('cityId') cityId?: string) {
    return this.platform.coverageGaps(cityId || undefined);
  }

  @Get('geo/resolve')
  @RequirePermissions('platform.zones.manage')
  resolvePoint(@Query('lat') lat: string, @Query('lng') lng: string) {
    return this.platform.resolvePoint(parseFloat(lat), parseFloat(lng));
  }

  @Get('zones')
  @RequirePermissions('platform.zones.manage')
  zones() {
    return this.platform.listZones();
  }

  @Post('zones')
  @RequirePermissions('platform.zones.manage')
  createZone(@Body() dto: CreateZoneDto, @CurrentUserV2() user: User) {
    return this.platform.createZone(dto, user.id);
  }

  @Patch('zones/:zoneId')
  @RequirePermissions('platform.zones.manage')
  updateZone(
    @Param('zoneId') zoneId: string,
    @Body() dto: UpdateZoneDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateZone(zoneId, dto, user.id);
  }

  /** من يتجاوز حدود المعدّل كثيراً (24 ساعة) — مُجمَّع حسب IP وحسب المستخدم */
  @Get('security/violations')
  @RequirePermissions('platform.audit.view')
  securityOverview() {
    return this.platform.securityOverview();
  }

  @Get('users')
  @RequirePermissions('platform.users.manage')
  users(@Query('q') q?: string, @Query('kind') kind?: string) {
    return this.platform.searchUsers(q, kind);
  }

  /** أعداد التصنيفات — تُعرض على تبويبات صفحة المستخدمين */
  @Get('users-counts')
  @RequirePermissions('platform.users.manage')
  userKindCounts() {
    return this.platform.userKindCounts();
  }

  @Patch('users/:userId/status')
  @RequirePermissions('platform.users.manage')
  setUserStatus(
    @Param('userId') userId: string,
    @Body() dto: UserStatusDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.setUserStatus(userId, dto.status, user.id);
  }

  /** الأجهزة المسجَّل منها دخول هذا المستخدم الآن */
  @Get('users/:userId/sessions')
  @RequirePermissions('platform.users.manage')
  userSessions(@Param('userId') userId: string) {
    return this.platform.userSessions(userId);
  }

  @Delete('users/:userId/sessions/:sessionId')
  @RequirePermissions('platform.users.manage')
  revokeSession(
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.revokeUserSession(userId, sessionId, user.id);
  }

  @Delete('users/:userId/sessions')
  @RequirePermissions('platform.users.manage')
  revokeAllSessions(
    @Param('userId') userId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.revokeAllUserSessions(userId, user.id);
  }

  /** يفتح حدّ OTP عبر واتساب لهاتف مستخدم تخطّى المحاولات المسموحة */
  @Post('users/:userId/reset-otp-limit')
  @RequirePermissions('platform.users.manage')
  resetOtpLimit(@Param('userId') userId: string, @CurrentUserV2() user: User) {
    return this.platform.resetOtpLimit(userId, user.id);
  }

  @Patch('users/:userId')
  @RequirePermissions('platform.users.manage')
  updateUser(
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateUser(userId, dto, user.id);
  }

  /** حذف مستخدم — أي حساب. يُحذف فعلياً فقط إن لم يترك أثراً حقيقياً */
  @Delete('users/:userId')
  @RequirePermissions('platform.users.manage')
  deleteUser(@Param('userId') userId: string, @CurrentUserV2() user: User) {
    return this.platform.deleteUser(userId, user.id);
  }

  /**
   * حذف جذري — يمحو المستخدم وطلباته وكل أثره الشخصي بلا رجعة.
   *
   * مسار منفصل عن DELETE أعلاه لا راية عليه: فعلٌ لا يُردّ لا يجوز أن
   * يُبلغ بمعامل استعلام قد يُضاف سهواً. والخدمة تشترط دور المدير الأعلى
   * فوق هذه الصلاحية — انظر purgeUser.
   */
  @Delete('users/:userId/purge')
  @RequirePermissions('platform.users.manage')
  purgeUser(@Param('userId') userId: string, @CurrentUserV2() user: User) {
    return this.platform.purgeUser(userId, user.id);
  }

  @Get('employees')
  @RequirePermissions('platform.users.manage')
  employees() {
    return this.platform.listEmployees();
  }

  @Post('employees')
  @RequirePermissions('platform.users.manage')
  createEmployee(@Body() dto: CreateEmployeeDto, @CurrentUserV2() user: User) {
    return this.platform.createEmployee(dto, user.id);
  }

  @Patch('employees/:userId')
  @RequirePermissions('platform.users.manage')
  updateEmployee(
    @Param('userId') userId: string,
    @Body() dto: UpdatePlatformEmployeeDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updatePlatformEmployee(userId, dto, user.id);
  }

  /** حذف موظف منصة — يُحذف حسابه فعلياً فقط إن لم يترك أثراً حقيقياً */
  @Delete('employees/:userId')
  @RequirePermissions('platform.users.manage')
  removeEmployee(@Param('userId') userId: string, @CurrentUserV2() user: User) {
    return this.platform.removePlatformEmployee(userId, user.id);
  }

  // ============ ترقيم الطلبات ============

  @Get('order-counter')
  @RequirePermissions('platform.orders.numbering')
  orderCounter() {
    return this.platform.orderCounter();
  }

  /** يبدأ العدّ من جديد — رموز الطلبات القديمة لا تتغير */
  @Post('order-counter/reset')
  @RequirePermissions('platform.orders.numbering')
  resetOrderCounter(
    @Body() dto: ResetOrderCounterDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.resetOrderCounter(dto, user.id);
  }

  // ============ حذف الطلبات القديمة ============

  /** كم طلباً سيُحذف — يُقرأ قبل الحذف، فالتأكيد على عدد لا على مجهول */
  @Get('orders-purge/preview')
  @RequirePermissions('platform.orders.numbering')
  previewOrderPurge(@Query('olderThanDays') olderThanDays: string) {
    return this.platform.previewOrderPurge(Number(olderThanDays));
  }

  /**
   * حذف نهائي لدفعة من الطلبات المنتهية القديمة. لا تراجع — ولذلك صلاحيةٌ
   * محجوزة، وحدٌّ أدنى للعمر، ودفعة محدودة تُعاد حتى يصفر العدد.
   */
  @Post('orders-purge')
  @RequirePermissions('platform.orders.numbering')
  purgeOldOrders(
    @Body() dto: PurgeOrdersDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.purgeOldOrders(dto.olderThanDays, user.id);
  }

  // ============ طلبات شحن الرصيد ============

  @Get('recharge-requests')
  @RequirePermissions('wallet.topup')
  rechargeRequests(@Query('status') status?: RechargeStatus) {
    return this.recharge.list(status);
  }

  /** الاعتماد بعد تأكد وصول المبلغ — يزيد الرصيد ويقيّد الدفتر معاً */
  @Post('recharge-requests/:id/approve')
  @RequirePermissions('wallet.topup')
  approveRecharge(
    @Param('id') id: string,
    @Body() dto: ApproveRechargeDto,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.approve(id, dto, user.id);
  }

  /**
   * شحن مباشر بلا طلب من الوكالة — يُسجَّل طلباً معتمداً باسم من نفّذه،
   * فيظهر في الجدول نفسه ويحمل الأثر نفسه.
   */
  @Post('agencies/:agencyId/topup')
  @RequirePermissions('wallet.topup')
  directTopup(
    @Param('agencyId') agencyId: string,
    @Body() dto: DirectTopupDto,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.directTopup(agencyId, dto, user.id);
  }

  @Post('recharge-requests/:id/reject')
  @RequirePermissions('wallet.topup')
  rejectRecharge(
    @Param('id') id: string,
    @Body() dto: RejectRechargeDto,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.reject(id, dto.reasonAr, user.id);
  }

  // ============ حسابات استقبال التحويلات ============
  // تحت platform.finance.manage: المحاسب والمدير الأعلى فقط. مَن يعتمد طلبات
  // الشحن (wallet.topup) ليس بالضرورة مَن يحدد لأي حساب تصل الأموال.

  @Get('payment-accounts')
  @RequirePermissions('platform.finance.manage')
  paymentAccountsList() {
    return this.paymentAccounts.listAll();
  }

  // ============ كوبونات الخصم ============
  // الخصم تتحمّله الوكالة لا المنصة — انظر CouponsService

  @Get('coupons')
  @RequirePermissions('platform.coupons.manage')
  couponsList() {
    return this.coupons.list();
  }

  @Get('coupons/:id/redemptions')
  @RequirePermissions('platform.coupons.manage')
  couponRedemptions(@Param('id') id: string) {
    return this.coupons.redemptions(id);
  }

  @Post('coupons')
  @RequirePermissions('platform.coupons.manage')
  createCoupon(@Body() dto: CreateCouponDto, @CurrentUserV2() user: User) {
    return this.coupons.create(dto, user.id);
  }

  @Patch('coupons/:id')
  @RequirePermissions('platform.coupons.manage')
  updateCoupon(
    @Param('id') id: string,
    @Body() dto: UpdateCouponDto,
    @CurrentUserV2() user: User,
  ) {
    return this.coupons.update(id, dto, user.id);
  }

  @Delete('coupons/:id')
  @RequirePermissions('platform.coupons.manage')
  deleteCoupon(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.coupons.remove(id, user.id);
  }

  /** معاينة الـQR قبل الحفظ — لا يلمس قاعدة البيانات */
  @Post('payment-accounts/qr-preview')
  @RequirePermissions('platform.finance.manage')
  previewPaymentAccountQr(@Body() dto: QrPreviewDto) {
    return this.paymentAccounts.previewQr(dto);
  }

  @Post('payment-accounts')
  @RequirePermissions('platform.finance.manage')
  createPaymentAccount(
    @Body() dto: CreatePaymentAccountDto,
    @CurrentUserV2() user: User,
  ) {
    return this.paymentAccounts.create(dto, user.id);
  }

  @Patch('payment-accounts/:id')
  @RequirePermissions('platform.finance.manage')
  updatePaymentAccount(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentAccountDto,
    @CurrentUserV2() user: User,
  ) {
    return this.paymentAccounts.update(id, dto, user.id);
  }

  @Delete('payment-accounts/:id')
  @RequirePermissions('platform.finance.manage')
  deletePaymentAccount(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.paymentAccounts.remove(id, user.id);
  }

  /** كلمة مرور مؤقتة لأي حساب لوحة نسي كلمته — تُسلَّم على هاتفه المسجّل */
  @Post('users/:userId/password')
  @RequirePermissions('platform.users.manage')
  resetPassword(@Param('userId') userId: string, @CurrentUserV2() user: User) {
    return this.platform.resetUserPassword(userId, user.id);
  }

  @Get('bottle-types')
  @RequirePermissions('platform.bottles.manage')
  bottles() {
    return this.platform.listWaterBottleTypes();
  }

  /** الصور الجاهزة يختار الأدمن منها بدل كتابة رابط يدوياً */
  @Get('bottle-image-presets')
  @RequirePermissions('platform.bottles.manage')
  bottleImagePresets() {
    return this.platform.listBottleImagePresets();
  }

  /**
   * رفع صورة من جهاز الأدمن مباشرة — تُخزَّن في القاعدة (لا قرص الحاوية،
   * يضيع عند كل نشر) وتُقدَّم عبر MediaController العام بلا حراسة دخول.
   */
  @Post('bottle-images')
  @RequirePermissions('platform.bottles.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('صيغة صورة غير مدعومة — PNG أو JPEG أو WebP أو SVG'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadBottleImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.platform.saveUploadedImage(file.buffer, file.mimetype);
  }

  @Post('bottle-types')
  @RequirePermissions('platform.bottles.manage')
  createBottle(@Body() dto: CreateBottleDto, @CurrentUserV2() user: User) {
    return this.platform.createWaterBottleType(dto, user.id);
  }

  @Patch('bottle-types/:id')
  @RequirePermissions('platform.bottles.manage')
  updateBottle(
    @Param('id') id: string,
    @Body() dto: UpdateBottleDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateWaterBottleType(id, dto, user.id);
  }

  /** حذف صنف — فعلي إن لم يظهر بطلب سابق، وإلا يُعطَّل بدلاً من ذلك */
  @Delete('bottle-types/:id')
  @RequirePermissions('platform.bottles.manage')
  deleteBottle(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.platform.deleteWaterBottleType(id, user.id);
  }

  // ============ البانرات الترويجية ============

  @Get('promo-banners')
  @RequirePermissions('platform.banners.manage')
  promoBanners() {
    return this.platform.listPromoBanners();
  }

  /** رفع صورة بانر من جهاز الأدمن — نفس آلية رفع صور القوارير */
  @Post('promo-banner-images')
  @RequirePermissions('platform.banners.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('صيغة صورة غير مدعومة — PNG أو JPEG أو WebP أو SVG'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadPromoBannerImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.platform.saveUploadedImage(file.buffer, file.mimetype);
  }

  @Post('promo-banners')
  @RequirePermissions('platform.banners.manage')
  createPromoBanner(@Body() dto: CreatePromoBannerDto, @CurrentUserV2() user: User) {
    return this.platform.createPromoBanner(dto, user.id);
  }

  @Patch('promo-banners/:id')
  @RequirePermissions('platform.banners.manage')
  updatePromoBanner(
    @Param('id') id: string,
    @Body() dto: UpdatePromoBannerDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updatePromoBanner(id, dto, user.id);
  }

  @Delete('promo-banners/:id')
  @RequirePermissions('platform.banners.manage')
  deletePromoBanner(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.platform.deletePromoBanner(id, user.id);
  }

  // ============ مطوّرو التطبيق ============
  // تُدار بصلاحية البانرات نفسها: كلاهما محتوى عرض يظهر داخل التطبيقين،
  // ولا يمسّ مالاً ولا طلباً ولا صلاحية.

  @Get('app-developers')
  @RequirePermissions('platform.banners.manage')
  appDevelopers() {
    return this.platform.listAppDevelopers();
  }

  /** صورة رمزية من جهاز الأدمن — نفس مخزن صور البانرات */
  @Post('app-developer-avatars')
  @RequirePermissions('platform.banners.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
        if (!allowed.includes(file.mimetype)) {
          cb(new BadRequestException('صيغة صورة غير مدعومة — PNG أو JPEG أو WebP أو SVG'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadAppDeveloperAvatar(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.platform.saveUploadedImage(file.buffer, file.mimetype);
  }

  @Post('app-developers')
  @RequirePermissions('platform.banners.manage')
  createAppDeveloper(@Body() dto: CreateAppDeveloperDto, @CurrentUserV2() user: User) {
    return this.platform.createAppDeveloper(dto, user.id);
  }

  @Patch('app-developers/:id')
  @RequirePermissions('platform.banners.manage')
  updateAppDeveloper(
    @Param('id') id: string,
    @Body() dto: UpdateAppDeveloperDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateAppDeveloper(id, dto, user.id);
  }

  @Delete('app-developers/:id')
  @RequirePermissions('platform.banners.manage')
  deleteAppDeveloper(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.platform.deleteAppDeveloper(id, user.id);
  }

  // ============ اشتراكات الوكالات ============
  // معزولة عن التوزيع تماماً: ما عليها من مستحقات لا يمنعها من استقبال طلب.

  /** نظرة شاملة: كل وكالة وما فُوتِر عليها وما دفعته وما تبقّى */
  @Get('subscriptions')
  @RequirePermissions('platform.finance.manage')
  subscriptions() {
    return this.subscriptions_.overview();
  }

  /** حالة وكالة بعينها: فواتيرها ودفعاتها ومدى تغطيتها */
  @Get('subscriptions/:agencyId')
  @RequirePermissions('platform.finance.manage')
  subscriptionOf(@Param('agencyId') agencyId: string) {
    return this.subscriptions_.statusFor(agencyId);
  }

  /** إصدار فواتير الشهر يدوياً — idempotent، لا يضاعف فاتورة صدرت */
  @Post('subscriptions/issue')
  @RequirePermissions('platform.finance.manage')
  issueInvoices() {
    return this.subscriptions_.issueMonthlyInvoices();
  }

  /** كسابقتها، وتُذكِّر إضافةً كل وكالة عليها متأخرات من شهور سابقة */
  @Post('subscriptions/issue-notify')
  @RequirePermissions('platform.finance.manage')
  issueInvoicesWithReminder() {
    return this.subscriptions_.issueMonthlyInvoices(new Date(), true);
  }

  /** تذكير المتأخرين وحدهم — بلا إصدار أي فاتورة */
  @Post('subscriptions/remind')
  @RequirePermissions('platform.finance.manage')
  remindUnpaid() {
    return this.subscriptions_.remindUnpaidAgencies();
  }

  @Get('subscriptions/payments/list')
  @RequirePermissions('platform.finance.manage')
  subPayments(@Query('status') status?: string) {
    return this.subscriptions_.listPayments(status);
  }

  @Post('subscriptions/payments/:id/approve')
  @RequirePermissions('platform.finance.manage')
  approveSubPayment(
    @Param('id') id: string,
    @Body() dto: SubPaymentReviewDto,
    @CurrentUserV2() user: User,
  ) {
    return this.subscriptions_.approvePayment(id, user.id, dto.reference, dto.noteAr);
  }

  @Post('subscriptions/payments/:id/reject')
  @RequirePermissions('platform.finance.manage')
  rejectSubPayment(
    @Param('id') id: string,
    @Body() dto: SubPaymentRejectDto,
    @CurrentUserV2() user: User,
  ) {
    return this.subscriptions_.rejectPayment(id, dto.reasonAr, user.id);
  }

  /** تفعيل/إعفاء وكالة من الفوترة — لا يمسّ توزيعها ولا فواتيرها الصادرة */
  @Patch('subscriptions/:agencyId/enabled')
  @RequirePermissions('platform.finance.manage')
  setSubEnabled(
    @Param('agencyId') agencyId: string,
    @Body() dto: SubEnabledDto,
  ) {
    return this.subscriptions_.setEnabled(agencyId, dto.enabled);
  }

  /** السعر العام الذي تدفعه كل وكالة شهرياً ما لم يُخصَّص لها غيره */
  @Patch('subscriptions/default-price')
  @RequirePermissions('platform.finance.manage')
  setSubDefaultPrice(@Body() dto: SubPriceDto) {
    return this.subscriptions_.setDefaultPrice(Number(dto.price ?? 0));
  }

  /** سعر اشتراك مخصص لوكالة — price: null يعيدها للسعر العام */
  @Patch('subscriptions/:agencyId/price')
  @RequirePermissions('platform.finance.manage')
  setSubPrice(
    @Param('agencyId') agencyId: string,
    @Body() dto: SubPriceDto,
  ) {
    return this.subscriptions_.setPriceOverride(agencyId, dto.price ?? null);
  }

  // ============ قناة رمز التحقق ============
  // التبديل يسري في اللحظة: القناة تُقرأ من القاعدة عند كل إرسال، فلا إعادة
  // نشر ولا انتظار — وهي الدقائق التي تكون فيها البوابة معطّلة ولا أحد يدخل.

  @Get('otp-channel')
  @RequirePermissions('platform.otp.channel')
  otpChannel() {
    return this.platform.getOtpChannel();
  }

  @Patch('otp-channel')
  @RequirePermissions('platform.otp.channel')
  updateOtpChannel(@Body() dto: OtpChannelDto, @CurrentUserV2() user: User) {
    return this.platform.setOtpChannel(dto.channel, user.id);
  }

  /**
   * رقم واتساب الذي يراسله الزبون في مصافحة التحقق.
   *
   * في اللوحة لا في متغيّر بيئة: تعديله كان يحتاج نشراً وإعادة تشغيل، ولا
   * شيء يكشف قيمته — فضُبط مرة ناقصاً («+962» بلا رقم) وبقي الخطأ ظاهراً
   * للزبون وحده. الخدمة ترفض الرقم الناقص عند الحفظ.
   */
  @Patch('otp-channel/wa-gateway')
  @RequirePermissions('platform.otp.channel')
  setWaGatewayNumber(
    @Body() dto: WaGatewayNumberDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.setWaGatewayNumber(dto.number ?? null, user.id);
  }

  /** استثناء لرقم بعينه — يسبق القناة العامة */
  @Put('otp-channel/overrides')
  @RequirePermissions('platform.otp.channel')
  setOtpOverride(@Body() dto: OtpOverrideDto, @CurrentUserV2() user: User) {
    return this.platform.setOtpOverride(
      dto.phone,
      dto.channel,
      dto.email,
      dto.note,
      user.id,
    );
  }

  @Delete('otp-channel/overrides/:phone')
  @RequirePermissions('platform.otp.channel')
  deleteOtpOverride(@Param('phone') phone: string, @CurrentUserV2() user: User) {
    return this.platform.deleteOtpOverride(phone, user.id);
  }

  @Get('dispatch-settings')
  @RequirePermissions('platform.dispatch.settings')
  dispatchSettings() {
    return this.platform.getDispatchSettings();
  }

  @Patch('dispatch-settings')
  @RequirePermissions('platform.dispatch.settings')
  updateDispatchSettings(
    @Body() dto: DispatchSettingsDto,
    @CurrentUserV2() user: User,
  ) {
    return this.platform.updateDispatchSettings(dto, user.id);
  }

  @Get('reports/dispatch')
  @RequirePermissions('platform.reports.view')
  dispatchReport(@Query('days') days?: string) {
    const d = Math.min(Math.max(parseInt(days ?? '7', 10) || 7, 1), 90);
    return this.platform.dispatchReport(d);
  }
}
