import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { PaymentMethod, User } from '@prisma-v2/client';
import { AgencyStatus } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { DispatchService } from '../dispatch/dispatch.service';
import { LedgerService } from '../finance/ledger.service';
import { PaymentAccountsService } from '../finance/payment-accounts.service';
import { RechargeService } from '../finance/recharge.service';
import { SubscriptionService } from '../finance/subscription.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AgenciesService } from './agencies.service';
import { OrderChatService } from '../orders/order-chat.service';
import { PrismaV2Service } from '../database/prisma-v2.service';

class BranchDto {
  @IsString() @IsNotEmpty() nameAr!: string;
  @IsNumber() @Type(() => Number) lat!: number;
  @IsNumber() @Type(() => Number) lng!: number;
  @IsOptional() @IsNumber() @Min(0.5) @Type(() => Number) deliveryRadiusKm?: number;
  @IsOptional() @IsString() address?: string;
}

/**
 * موقع الفرع ونطاقه — يتطلب كلمة مرور الحساب.
 *
 * هذان الحقلان يحدّدان ما يصل الوكالة من طلبات: نطاقٌ يُوسَّع بضغطة يغرقها
 * بطلبات بعيدة، وموقعٌ يُزاح يقطع عنها حيّها كله. تغييرهما ليس إعداداً
 * يومياً بل قرار، وكلمة المرور تجعل الجهاز المتروك مفتوحاً على المكتب لا
 * يكفي لاتخاذه.
 */
class BranchLocationDto {
  @IsNumber() @Min(-90) @Max(90) @Type(() => Number) lat!: number;
  @IsNumber() @Min(-180) @Max(180) @Type(() => Number) lng!: number;
  @IsNumber() @Min(0.5) @Type(() => Number) deliveryRadiusKm!: number;
  @IsOptional() @IsString() address?: string;
  @IsString() @IsNotEmpty() password!: string;
}

class CreateAgencyDto {
  @IsString() @IsNotEmpty() nameAr!: string;
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @IsNotEmpty() cityId!: string;
  // هاتف المالك إلزامي للتواصل، ودخوله للوحة باسم المستخدم وكلمة المرور
  @IsString() @IsNotEmpty() ownerPhone!: string;
  @IsString() @IsNotEmpty() ownerName!: string;
  // اسم المستخدم يكتبه السوبر أدمن؛ كلمة المرور يولّدها النظام ولا تُقبل هنا
  @IsString() @IsNotEmpty() username!: string;
  @IsOptional() @IsEmail() ownerEmail?: string;
  @IsOptional() @ValidateNested() @Type(() => BranchDto) mainBranch?: BranchDto;
}

class SetStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'SUSPENDED', 'PENDING_APPROVAL'])
  status!: AgencyStatus;
}

class SetCoverageDto {
  @IsOptional() @IsArray() @IsString({ each: true }) zoneIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) neighborhoodIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) districtIds?: string[];
}

class SubPaymentDto {
  @IsNumber() @Type(() => Number) @Min(1) amount!: number;
  @IsIn(['BANK_TRANSFER', 'CLIQ', 'EFAWATEERCOM', 'CASH']) method!: PaymentMethod;
  @IsOptional() @IsString() noteAr?: string;
}

class CreateDriverDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) @Type(() => Number) vehicleCount?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) vehiclePlates?: string[];
  @IsOptional() @IsString() branchId?: string;
}

class UpdateDriverDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() @IsNotEmpty() phone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) @Type(() => Number) vehicleCount?: number;
  /// قائمة فارغة = امسح كل اللوحات. الغياب = لا تغيير. الفرق مقصود:
  /// النموذج القديم لم يكن يملك طريقة لمسح لوحة سُجّلت خطأً.
  @IsOptional() @IsArray() @IsString({ each: true }) vehiclePlates?: string[];
  @IsOptional() @IsString() branchId?: string;
}

class CreateEmployeeDto {
  @IsString() @IsNotEmpty() username!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

class UpdateEmployeeDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() @IsNotEmpty() phone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

class AvailabilityItemDto {
  @IsString() @IsNotEmpty() bottleTypeId!: string;
  @IsBoolean() available!: boolean;
}

class WorkingHourDto {
  @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @IsString() @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/) opensAt!: string;
  @IsString() @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/) closesAt!: string;
}

class SetWorkingHoursDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => WorkingHourDto)
  hours!: WorkingHourDto[];
}

class SetAvailabilityDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true })
  @Type(() => AvailabilityItemDto)
  items!: AvailabilityItemDto[];
}

class UpdateSettingsDto {
  @IsOptional() @IsBoolean() autoDispatch?: boolean;
  @IsOptional() @IsBoolean() paused?: boolean;
}

class AssignDriverDto {
  @IsString() @IsNotEmpty() driverId!: string;
}

class RechargeRequestDto {
  @IsNumber() @Type(() => Number) @Min(1) amount!: number;
  @IsIn(['BANK_TRANSFER', 'CLIQ', 'EFAWATEERCOM', 'CASH']) method!: PaymentMethod;
  @IsOptional() @IsString() noteAr?: string;
}

/// تصحيح طلب معلّق خلال مهلة قصيرة — كل الحقول اختيارية (تعديل جزئي)
/** اعتذار الوكالة — السبب من قائمة الخادم المغلقة */
class DeclineOrderDto {
  @IsString() @IsNotEmpty() reason!: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class UpdateRechargeRequestDto {
  @IsOptional() @IsNumber() @Type(() => Number) @Min(1) amount?: number;
  @IsOptional() @IsIn(['BANK_TRANSFER', 'CLIQ', 'EFAWATEERCOM', 'CASH']) method?: PaymentMethod;
  @IsOptional() @IsString() noteAr?: string;
}

@Controller('v2/agencies')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class AgenciesController {
  constructor(
    private agencies: AgenciesService,
    private dispatch: DispatchService,
    private subscriptions: SubscriptionService,
    private ledger: LedgerService,
    private recharge: RechargeService,
    private accounts: PaymentAccountsService,
    private orderChat: OrderChatService,
    private prisma: PrismaV2Service,
  ) {}

  // ============ مستوى المنصة ============

  @Get()
  @RequirePermissions('platform.agencies.manage')
  list() {
    return this.agencies.list();
  }

  @Post()
  @RequirePermissions('platform.agencies.manage')
  create(@Body() dto: CreateAgencyDto, @CurrentUserV2() user: User) {
    return this.agencies.create(dto, user.id);
  }

  @Patch(':agencyId/status')
  @RequirePermissions('platform.agencies.approve')
  setStatus(
    @Param('agencyId') agencyId: string,
    @Body() dto: SetStatusDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.setStatus(agencyId, dto.status, user.id);
  }

  /** حذف — فقط لوكالة فارغة تماماً؛ وإلا استخدم إيقافها بالأعلى */
  @Delete(':agencyId')
  @RequirePermissions('platform.agencies.manage')
  deleteAgency(@Param('agencyId') agencyId: string, @CurrentUserV2() user: User) {
    return this.agencies.deleteAgency(agencyId, user.id);
  }

  // ============ داخل نطاق الوكالة (Tenant-scoped) ============

  /** حدود تفرضها المنصة وتحتاجها واجهة الوكالة (سقف نطاق التوصيل) */
  @Get('limits')
  limits() {
    return this.agencies.limits();
  }

  @Get(':agencyId')
  @RequirePermissions('agency.settings')
  get(@Param('agencyId') agencyId: string) {
    return this.agencies.get(agencyId);
  }

  @Post(':agencyId/branches')
  @RequirePermissions('agency.settings')
  createBranch(
    @Param('agencyId') agencyId: string,
    @Body() dto: BranchDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.createBranch(agencyId, dto, user.id);
  }

  /** موقع الفرع ونطاق توصيله — تعريف التغطية في النظام */
  @Put(':agencyId/branches/:branchId/location')
  @RequirePermissions('coverage.manage')
  setBranchLocation(
    @Param('agencyId') agencyId: string,
    @Param('branchId') branchId: string,
    @Body() dto: BranchLocationDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.setBranchLocation(agencyId, branchId, dto, user.id);
  }

  /** (مؤجَّل للاستثناءات) تغطية بالحدود الإدارية — لا يستخدمها التوزيع */
  @Put(':agencyId/branches/:branchId/coverage')
  @RequirePermissions('coverage.manage')
  setCoverage(
    @Param('agencyId') agencyId: string,
    @Param('branchId') branchId: string,
    @Body() dto: SetCoverageDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.setCoverage(agencyId, branchId, dto, user.id);
  }

  @Get(':agencyId/stats')
  @RequirePermissions('reports.view')
  stats(@Param('agencyId') agencyId: string) {
    return this.agencies.stats(agencyId);
  }

  /** أرباح مدة: إجماليات + تفصيل يومي وبالسائق وبنوع القارورة */
  @Get(':agencyId/earnings')
  @RequirePermissions('reports.view')
  earnings(
    @Param('agencyId') agencyId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.agencies.earnings(agencyId, from, to);
  }

  @Get(':agencyId/orders')
  @RequirePermissions('orders.view')
  listOrders(
    @Param('agencyId') agencyId: string,
    @Query('status') status?: string,
  ) {
    return this.agencies.listOrders(agencyId, status);
  }

  /** تقييمات زبائن هذه الوكالة وحدها — نجومها وكلامها منسوبةً لسائقها */
  @Get(':agencyId/ratings')
  @RequirePermissions('orders.view')
  listRatings(@Param('agencyId') agencyId: string) {
    return this.agencies.listRatings(agencyId);
  }

  /** أسباب الاعتذار كما يعرضها الخادم — لا تفترقان عن تحققه */
  @Get('decline-reasons')
  @RequirePermissions('orders.view')
  declineReasons() {
    return Object.entries(DispatchService.DECLINE_REASONS).map(([code, labelAr]) => ({
      code,
      labelAr,
    }));
  }

  /**
   * اعتذار الوكالة عن طلب أُسند إليها — ينتقل فوراً لوكالة أخرى بدل انتظار
   * انقضاء مهلة التعيين اليدوي.
   */
  @Post(':agencyId/orders/:orderId/decline')
  @RequirePermissions('orders.assign')
  declineOrder(
    @Param('agencyId') agencyId: string,
    @Param('orderId') orderId: string,
    @Body() dto: DeclineOrderDto,
    @CurrentUserV2() user: User,
  ) {
    return this.dispatch.agencyDecline(orderId, agencyId, dto.reason, user.id, dto.note);
  }

  /** التعيين اليدوي (القرار 4) — يرسل عرضاً للسائق المختار والسائق يقبل */
  @Post(':agencyId/orders/:orderId/assign')
  @RequirePermissions('orders.assign')
  assignDriver(
    @Param('agencyId') agencyId: string,
    @Param('orderId') orderId: string,
    @Body() dto: AssignDriverDto,
    @CurrentUserV2() user: User,
  ) {
    return this.dispatch.manualOffer(orderId, agencyId, dto.driverId, user.id);
  }

  /**
   * محادثة طلب الوكالة بين الزبون والسائق — **قراءة فقط، ولصاحب الوكالة**.
   *
   * تُقرأ لفضّ نزاع بين زبونٍ وسائقٍ من طاقمها. ومقصورة على المالك: موظف
   * الاستقبال لا يحتاج قراءة ما دار بين زبون وسائق، وتوسيعها لاحقاً أهون
   * من تضييقها بعد أن تُقرأ محادثات لم يكن يجوز أن تُقرأ.
   *
   * والحارس يفرض الوكالة من مسارها (tenantScope)، والخدمة تتحقق أن الطلب
   * لهذه الوكالة — فلا تُقرأ محادثة طلبٍ لوكالة أخرى.
   */
  @Get(':agencyId/orders/:orderId/chat')
  @RequirePermissions('orders.view')
  async orderChatHistory(
    @Param('agencyId') agencyId: string,
    @Param('orderId') orderId: string,
    @CurrentUserV2() user: User,
  ) {
    const owner = await this.prisma.userRole.findFirst({
      where: { userId: user.id, agencyId, role: { name: 'AGENCY_OWNER' } },
    });
    if (!owner) {
      throw new ForbiddenException('قراءة المحادثات لصاحب الوكالة وحده');
    }
    return this.orderChat.supervisorHistory(orderId, { agencyId });
  }

  @Get(':agencyId/wallet')
  @RequirePermissions('wallet.view')
  wallet(@Param('agencyId') agencyId: string) {
    return this.agencies.wallet(agencyId);
  }

  /**
   * الوكالة تطلب شحن رصيدها؛ المالية تعتمد بعد وصول المبلغ. وللمالية وحدها
   * شحن مباشر من لوحة المنصة — وهو أيضاً يُسجَّل طلباً معتمداً، فكل زيادة
   * رصيد لها طلب موثّق مهما كان مصدرها.
   */
  /**
   * حالة الاشتراك: ما عليها، وحتى متى هي مغطّاة، وسجل الفواتير والدفعات.
   * **لا علاقة له بالتوزيع** — وكالة لم تدفع تبقى توزّع كما هي.
   */
  @Get(':agencyId/subscription')
  @RequirePermissions('wallet.view')
  subscription(@Param('agencyId') agencyId: string) {
    return this.subscriptions.statusFor(agencyId);
  }

  /** طلب دفع فاتورة الاشتراك — نفس مسار شحن الرصيد: تطلب والمالية تعتمد */
  @Post(':agencyId/subscription/payments')
  @RequirePermissions('wallet.recharge')
  requestSubPayment(
    @Param('agencyId') agencyId: string,
    @Body() dto: SubPaymentDto,
    @CurrentUserV2() user: User,
  ) {
    return this.subscriptions.requestPayment(agencyId, dto, user.id);
  }

  @Post(':agencyId/subscription/payments/:id/cancel')
  @RequirePermissions('wallet.recharge')
  cancelSubPayment(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @CurrentUserV2() user: User,
  ) {
    return this.subscriptions.cancelPayment(agencyId, id, user.id);
  }

  @Get(':agencyId/wallet/recharge-requests')
  @RequirePermissions('wallet.view')
  rechargeRequests(@Param('agencyId') agencyId: string) {
    return this.recharge.listForAgency(agencyId);
  }

  /**
   * حسابات المنصة التي تُحوَّل إليها مبالغ الشحن — المفعّلة فقط.
   * بلا هذا المسار تختار الوكالة "كليك" ولا تعرف لوين تحوّل.
   */
  @Get(':agencyId/wallet/payment-accounts')
  @RequirePermissions('wallet.view')
  paymentAccounts() {
    return this.accounts.listActive();
  }

  @Post(':agencyId/wallet/recharge-requests')
  @RequirePermissions('wallet.recharge')
  requestRecharge(
    @Param('agencyId') agencyId: string,
    @Body() dto: RechargeRequestDto,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.create(agencyId, dto, user.id);
  }

  /** تصحيح مبلغ أو طريقة طلب معلّق — الخادم يفرض المهلة، لا اللوحة */
  @Patch(':agencyId/wallet/recharge-requests/:id')
  @RequirePermissions('wallet.recharge')
  updateRecharge(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRechargeRequestDto,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.update(agencyId, id, dto, user.id);
  }

  @Post(':agencyId/wallet/recharge-requests/:id/cancel')
  @RequirePermissions('wallet.recharge')
  cancelRecharge(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @CurrentUserV2() user: User,
  ) {
    return this.recharge.cancel(agencyId, id, user.id);
  }

  /** الفاتورة الشهرية = تجميع حركات الـ Ledger (لا جداول فوترة في V1) */
  @Get(':agencyId/finance/invoice')
  @RequirePermissions('wallet.view')
  invoice(
    @Param('agencyId') agencyId: string,
    @Query('month') month: string,
  ) {
    return this.ledger.monthlyInvoice(agencyId, month);
  }

  @Get(':agencyId/working-hours')
  @RequirePermissions('hours.manage')
  getWorkingHours(@Param('agencyId') agencyId: string) {
    return this.agencies.workingHours(agencyId);
  }

  /** استبدال الجدول كاملاً — ما تراه الشاشة هو ما يُحفظ */
  @Put(':agencyId/working-hours')
  @RequirePermissions('hours.manage')
  setWorkingHours(
    @Param('agencyId') agencyId: string,
    @Body() dto: SetWorkingHoursDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.setWorkingHours(agencyId, dto.hours, user.id);
  }

  @Put(':agencyId/availability')
  @RequirePermissions('availability.manage')
  setAvailability(
    @Param('agencyId') agencyId: string,
    @Body() dto: SetAvailabilityDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.setAvailability(agencyId, dto.items, user.id);
  }

  @Patch(':agencyId/settings')
  @RequirePermissions('agency.settings')
  updateSettings(
    @Param('agencyId') agencyId: string,
    @Body() dto: UpdateSettingsDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.updateSettings(agencyId, dto, user.id);
  }

  @Get(':agencyId/drivers')
  @RequirePermissions('drivers.view')
  listDrivers(@Param('agencyId') agencyId: string) {
    return this.agencies.listDrivers(agencyId);
  }

  @Post(':agencyId/drivers')
  @RequirePermissions('drivers.create')
  createDriver(
    @Param('agencyId') agencyId: string,
    @Body() dto: CreateDriverDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.createDriver(agencyId, dto, user.id);
  }

  @Patch(':agencyId/drivers/:userId')
  @RequirePermissions('drivers.update')
  updateDriver(
    @Param('agencyId') agencyId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateDriverDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.updateDriver(agencyId, userId, dto, user.id);
  }

  /** حذف سائق من الوكالة — يُحذف حسابه فعلياً فقط إن لم تكن له طلبات سابقة */
  @Delete(':agencyId/drivers/:userId')
  @RequirePermissions('drivers.suspend')
  removeDriver(
    @Param('agencyId') agencyId: string,
    @Param('userId') userId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.removeDriver(agencyId, userId, user.id);
  }

  @Get(':agencyId/employees')
  @RequirePermissions('employees.create')
  listEmployees(@Param('agencyId') agencyId: string) {
    return this.agencies.listEmployees(agencyId);
  }

  @Post(':agencyId/employees')
  @RequirePermissions('employees.create')
  createEmployee(
    @Param('agencyId') agencyId: string,
    @Body() dto: CreateEmployeeDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.createEmployee(agencyId, dto, user.id);
  }

  @Patch(':agencyId/employees/:userId')
  @RequirePermissions('employees.update')
  updateEmployee(
    @Param('agencyId') agencyId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.updateEmployee(agencyId, userId, dto, user.id);
  }

  /** حذف موظف من الوكالة — يُحذف حسابه فعلياً فقط إن لم يكن له أي أثر سابق */
  @Delete(':agencyId/employees/:userId')
  @RequirePermissions('employees.disable')
  removeEmployee(
    @Param('agencyId') agencyId: string,
    @Param('userId') userId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.removeEmployee(agencyId, userId, user.id);
  }

  /** كلمة مرور مؤقتة جديدة لموظف — يسلّمها المالك ويغيّرها الموظف أول دخول */
  @Post(':agencyId/employees/:userId/password')
  @RequirePermissions('employees.create')
  resetEmployeePassword(
    @Param('agencyId') agencyId: string,
    @Param('userId') userId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.agencies.resetEmployeePassword(agencyId, userId, user.id);
  }
}
