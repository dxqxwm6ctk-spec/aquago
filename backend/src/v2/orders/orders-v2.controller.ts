import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { DispatchQueue } from '../dispatch/dispatch.queue';
import { DispatchService } from '../dispatch/dispatch.service';
import { OrderChatService } from './order-chat.service';
import { OrdersV2Service } from './orders-v2.service';

class OrderItemDto {
  @IsString() @IsNotEmpty() bottleTypeId!: string;
  @IsInt() @Min(1) @Max(20) @Type(() => Number) qty!: number;
}

class CheckCouponDto {
  @IsString() @IsNotEmpty() code!: string;
  /// العنوان يحدّد المدينة، وبعض الكوبونات محصورة بمدن
  @IsString() @IsNotEmpty() addressId!: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

class CreateOrderDto {
  @IsString() @IsNotEmpty() addressId!: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => OrderItemDto)
  items!: OrderItemDto[];
  @IsOptional() @IsString() notes?: string;
  /** تأكيد صريح من الزبون: نعم، ألغِ طلبي النشط بهذا المعرّف واستبدله */
  @IsOptional() @IsString() cancelActiveOrderId?: string;
  /**
   * الإجمالي كما عُرض على الشاشة. اختياري عمداً: النسخ المثبَّتة على أجهزة
   * الزبائن لا ترسله، وإلزامه يكسر الطلب عندهم. لا يُحتسب منه شيء — الخادم
   * يحسب من أسعاره ثم يقارن، ويرفض إن اختلفا.
   */
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) expectedTotal?: number;
  /** رمز كوبون الخصم — يتحقق منه الخادم ويحسب الخصم بنفسه */
  @IsOptional() @IsString() couponCode?: string;
}

class RateDto {
  @IsInt() @Min(1) @Max(5) @Type(() => Number) stars!: number;
  /// كلام الزبون مع نجومه — اختياري: من لا يريد الكتابة يرسل نجومه وحدها
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string;
}

class RedispatchDto {
  /** true = ابحث لي عن سائق آخر، false = ألغِ الطلب */
  @IsBoolean() search!: boolean;
}

class OrderMessageDto {
  @IsString() @IsNotEmpty() bodyAr!: string;
}

/**
 * إحداثيات فحص التغطية. المدى يغطي الأردن بهامش واسع — لا يمنع تزويراً
 * (الطالب يكتب ما شاء داخله)، لكنه يردّ القيم المستحيلة مبكراً بدل تمريرها
 * إلى استعلام مكاني. و`@Type(() => Number)` لازم لأنها تصل من الـquery نصاً.
 */
class CoverageQueryDto {
  @IsNumber() @Min(29) @Max(34) @Type(() => Number) lat!: number;
  @IsNumber() @Min(34) @Max(40) @Type(() => Number) lng!: number;
}

class CreateAddressDto {
  @IsString() @IsNotEmpty() label!: string;
  @IsString() @IsNotEmpty() street!: string;
  @IsString() @IsNotEmpty() building!: string;
  @IsString() @IsNotEmpty() floor!: string;
  @IsOptional() @IsString() notes?: string;
  @IsNumber() @Type(() => Number) lat!: number;
  @IsNumber() @Type(() => Number) lng!: number;
}

@Controller('v2')
export class OrdersV2Controller {
  constructor(
    private orders: OrdersV2Service,
    private dispatch: DispatchService,
    private dispatchQueue: DispatchQueue,
    private chat: OrderChatService,
  ) {}

  /** كتالوج عام — لا يتطلب دخولاً */
  @Get('bottle-types')
  bottleTypes() {
    return this.orders.listWaterBottleTypes();
  }

  /**
   * بانرات ترويجية — عام، لا يتطلب دخولاً.
   *
   * `?app=DRIVER` لتطبيق المندوب، والافتراضي CUSTOMER: نسخ الزبون المنشورة
   * لا ترسل المعامل، وتغييرُ ما تراه بلا تحديث تطبيقها ليس مقبولاً.
   */
  @Get('promo-banners')
  promoBanners(@Query('app') app?: string) {
    return this.orders.listActivePromoBanners(
      app === 'DRIVER' ? 'DRIVER' : 'CUSTOMER',
    );
  }

  /**
   * «مطوّرو التطبيق» — عام بلا دخول: الصفحة تُفتح من شاشة الحساب، وقد يفتحها
   * من لم يسجّل دخوله بعد.
   */
  @Get('app-developers')
  appDevelopers() {
    return this.orders.listAppDevelopers();
  }

  /** عمولة المنصة المعروضة للزبون قبل التأكيد (بند الخدمة الوحيد) */
  @Get('service-fee')
  serviceFee() {
    return this.orders.serviceFee();
  }

  /**
   * فحص تغطية موقع — **عام بلا دخول** عمداً.
   *
   * الزائر يحدّد عنوانه قبل أن يكون له حساب (الحساب يُطلب عند «تأكيد
   * الطلب»)، فيحتاج أن يعرف الآن أن موقعه داخل نطاق وكالة — لا بعد أن
   * ينشئ حساباً لطلب لن يقوم.
   *
   * يرجع نعم/لا واسم المنطقة وحدهما: لا مواقع فروع ولا أنصاف أقطار.
   */
  @Get('coverage')
  coverage(@Query() q: CoverageQueryDto, @Ip() ip: string) {
    return this.orders.coverageAt(q.lat, q.lng, ip);
  }

  @Get('zones')
  zones() {
    return this.orders.listZones();
  }

  @Get('geo')
  geoTree() {
    return this.orders.listGeoTree();
  }

  /**
   * تحقق من كوبون قبل تأكيد الطلب — يعرض الخصم بلا استهلاك الكوبون.
   *
   * الحساب هنا لا يُعتمد عليه: `create` تُعيد التحقق وتحسب من جديد. غرضه أن
   * يعرف الزبون أن الرمز صالح وكم يوفّر قبل أن يضغط تأكيد، بدل أن يكتشف رفضه
   * بعد التأكيد.
   */
  @Post('coupons/check')
  @UseGuards(JwtV2Guard)
  checkCoupon(@Body() dto: CheckCouponDto, @CurrentUserV2() user: User) {
    return this.orders.checkCoupon(user.id, dto.code, dto.addressId, dto.items);
  }

  // ============ 4.1: الطلب يستدعي المحرك مباشرة ============

  @Post('orders')
  @UseGuards(JwtV2Guard)
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
  ) {
    const order = await this.orders.create({
      customerId: user.id,
      addressId: dto.addressId,
      items: dto.items,
      notes: dto.notes,
      cancelActiveOrderId: dto.cancelActiveOrderId,
      expectedTotal: dto.expectedTotal,
      couponCode: dto.couponCode,
      ip,
    });
    // **التوزيع في الطابور لا في مسار الطلب.** كان `await dispatchOrder`
    // يحجز الردّ حتى تنتهي دورة كاملة: ST_DWithin على الفروع، وتحميل
    // الوكالات بجداولها ومحافظها وسائقيها، وترشيح بستّة أوزان، وعروض
    // وإشعارات FCM. قياس staging: وسيط **٣٢ ثانية** لطلب ناجح تحت الحمل،
    // بينما CPU الحاويتين ٩٣–٩٩٪ والقاعدة عند اتصالين نشطين — فالانتظار
    // كان على حسابات في العملية لا على القاعدة.
    //
    // الزبون لا يفقد شيئاً: شاشة المتابعة تستمع لـ`order:status` عبر
    // Socket.IO، والتوزيع يبثّه عند كل تغيّر. الاستجابة ترجع الطلب
    // بحالته الأولى (CREATED) بدل انتظار AGENCY_ASSIGNED.
    await this.dispatchQueue.enqueueDispatch(order.id);
    return this.orders.getForUser(order.id, user.id);
  }

  @Get('orders')
  @UseGuards(JwtV2Guard)
  myOrders(@CurrentUserV2() user: User) {
    return this.orders.myOrders(user.id);
  }

  @Get('orders/:orderId')
  @UseGuards(JwtV2Guard)
  get(@Param('orderId') orderId: string, @CurrentUserV2() user: User) {
    return this.orders.getForUser(orderId, user.id);
  }

  // ============ محادثة الطلب (الزبون ↔ السائق) ============
  // مسار واحد يخدم التطبيقين: الخدمة تعرف مَن الطالب من هوية الجلسة،
  // فلا يحتاج كل تطبيق مساراً خاصاً به.

  @Get('orders/:orderId/chat')
  @UseGuards(JwtV2Guard)
  chatHistory(@Param('orderId') orderId: string, @CurrentUserV2() user: User) {
    return this.chat.history(orderId, user.id);
  }

  @Post('orders/:orderId/chat')
  @UseGuards(JwtV2Guard)
  sendChatMessage(
    @Param('orderId') orderId: string,
    @Body() dto: OrderMessageDto,
    @CurrentUserV2() user: User,
  ) {
    return this.chat.send(orderId, user.id, dto.bodyAr);
  }

  /** إلغاء الزبون أثناء الانتظار (قبل تعيين أي سائق) */
  @Post('orders/:orderId/cancel')
  @UseGuards(JwtV2Guard)
  cancel(
    @Param('orderId') orderId: string,
    @Body() dto: CancelDto,
    @CurrentUserV2() user: User,
  ) {
    return this.orders.cancelByCustomer(orderId, user.id, dto.reason);
  }

  /**
   * رد الزبون بعد انسحاب سائق لسبب يخصّه: نبحث له عن سائق آخر أم نُلغي.
   * الإلغاء هنا لا يمرّ بـcancel لأن الطلب عندئذ في AGENCY_ASSIGNED — حالة
   * لا يُسمح بالإلغاء منها عادةً (سائق في الطريق)، وهنا لا سائق أصلاً.
   */
  @Post('orders/:orderId/redispatch')
  @UseGuards(JwtV2Guard)
  redispatch(
    @Param('orderId') orderId: string,
    @Body() dto: RedispatchDto,
    @CurrentUserV2() user: User,
  ) {
    return this.orders.answerRedispatch(orderId, user.id, dto.search);
  }

  @Post('orders/:orderId/rate')
  @UseGuards(JwtV2Guard)
  rate(
    @Param('orderId') orderId: string,
    @Body() dto: RateDto,
    @CurrentUserV2() user: User,
  ) {
    return this.orders.rate(orderId, user.id, dto.stars, dto.comment);
  }

  // ============ العناوين ============

  @Get('addresses')
  @UseGuards(JwtV2Guard)
  addresses(@CurrentUserV2() user: User) {
    return this.orders.listAddresses(user.id);
  }

  @Post('addresses')
  @UseGuards(JwtV2Guard)
  createAddress(
    @Body() dto: CreateAddressDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
  ) {
    return this.orders.createAddress(user.id, dto, ip);
  }

  /** اختيار العنوان الافتراضي — المقترح أولاً عند الطلب */
  @Patch('addresses/:addressId/default')
  @UseGuards(JwtV2Guard)
  setDefaultAddress(
    @Param('addressId') addressId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.orders.setDefaultAddress(user.id, addressId);
  }

  @Delete('addresses/:addressId')
  @UseGuards(JwtV2Guard)
  deleteAddress(
    @Param('addressId') addressId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.orders.deleteAddress(user.id, addressId);
  }
}
