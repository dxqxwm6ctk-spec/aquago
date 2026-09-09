import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import {
  IsBoolean,
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
import type { User } from '@prisma-v2/client';
import { ContractAlertKind, ContractStatus } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ContractAlertsService } from './contract-alerts.service';
import { ContractsService } from './contracts.service';

class SignDto {
  @IsString() @IsNotEmpty() password!: string;
  @IsBoolean() consent!: boolean;
  /** data:image/png;base64,… — التوقيع المرسوم */
  @IsOptional() @IsString() @MaxLength(600_000) signaturePng?: string;
}

class GenerateDto {
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) subscriptionMonthly?: number;
  @IsOptional() @IsBoolean() exempt?: boolean;
  @IsOptional() @IsString() @MaxLength(400) serviceAreaAr?: string;
}

class NoteDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) note!: string;
}

class ReviewWetCopyDto {
  @IsBoolean() verified!: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class TemplateDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() @MaxLength(300) titleAr!: string;
  @IsString() @IsNotEmpty() bodyHtml!: string;
  @IsOptional() @IsString() @MaxLength(1000) notesAr?: string;
  @IsOptional() @IsBoolean() activate?: boolean;
}

class SettingsDto {
  @IsOptional() @IsString() @MaxLength(300) platformLegalNameAr?: string;
  @IsOptional() @IsString() @MaxLength(120) platformEntityTypeAr?: string;
  @IsOptional() @IsString() @MaxLength(60) platformNationalNo?: string;
  @IsOptional() @IsString() @MaxLength(60) platformRegistryNo?: string;
  @IsOptional() @IsString() @MaxLength(60) platformTaxNumber?: string;
  @IsOptional() @IsString() @MaxLength(400) platformAddressAr?: string;
  @IsOptional() @IsString() @MaxLength(200) platformSignerName?: string;
  @IsOptional() @IsString() @MaxLength(120) platformSignerRole?: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) @Type(() => Number) termMonths?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) @Type(() => Number) renewNoticeDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) @Type(() => Number) terminationNoticeDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) @Type(() => Number) commissionNoticeDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) @Type(() => Number) legacyGraceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) @Type(() => Number) wetCopyDueDays?: number;
  @IsOptional() @IsBoolean() wetCopyRequired?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) jurisdictionClauseAr?: string;
  @IsOptional() @IsBoolean() stampDutyEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) stampDutyNoteAr?: string;
  @IsOptional() @IsString() @MaxLength(20) numberPrefix?: string;
}

class AlertRuleDto {
  @IsOptional() @IsString() id?: string;
  @IsIn(['CONTRACT_EXPIRY', 'WET_COPY_DUE', 'LICENSE_EXPIRY', 'ONBOARDING_GRACE'])
  kind!: ContractAlertKind;
  /// موجب = قبل الاستحقاق، صفر = يومه، سالب = تذكير بالتأخّر
  @IsInt() @Min(-365) @Max(365) @Type(() => Number) offsetDays!: number;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() notifyAgency!: boolean;
  @IsBoolean() notifyPlatform!: boolean;
  @IsString() @IsNotEmpty() @MaxLength(200) titleAr!: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) bodyAr!: string;
}

const wetCopyUpload = FileInterceptor('file', {
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      cb(new BadRequestException('صيغة غير مدعومة — PNG أو JPEG أو WebP أو PDF'), false);
      return;
    }
    cb(null, true);
  },
});

/** الوثيقة تُعاد HTML لا JSON: الطباعة وحفظ PDF من المتصفح مباشرة */
function sendDoc(res: Response, html: string) {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.send(html);
}

/**
 * العقود — جانب الوكالة. كل المسارات تحمل `:agencyId` فيفحص الحارس
 * الصلاحية داخل تلك الوكالة وحدها.
 */
@Controller('v2/agencies/:agencyId/contracts')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class AgencyContractsController {
  constructor(private contracts: ContractsService) {}

  @Get()
  @RequirePermissions('agency.contracts.view')
  list(@Param('agencyId') agencyId: string) {
    return this.contracts.agencyView(agencyId);
  }

  @Get(':id/document')
  @RequirePermissions('agency.contracts.view')
  async document(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
    @Res() res: Response,
  ) {
    await this.contracts.assertBelongsTo(id, agencyId);
    sendDoc(res, await this.contracts.renderHtml(id, user.id, ip, ua));
  }

  /** التوقيع: إقرار + رسم توقيع + كلمة مرور الحساب (المادة 27-1) */
  @Post(':id/sign')
  @RequirePermissions('agency.contracts.sign')
  sign(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @Body() dto: SignDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.signAsAgency(agencyId, id, dto, user.id, ip, ua);
  }

  @Post(':id/wet-copy')
  @RequirePermissions('agency.contracts.sign')
  @UseInterceptors(wetCopyUpload)
  uploadWetCopy(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.contracts.uploadWetCopy(agencyId, id, file, user.id, ip, ua);
  }

  @Get(':id/wet-copy/file')
  @RequirePermissions('agency.contracts.view')
  async wetCopyFile(
    @Param('agencyId') agencyId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    await this.contracts.assertBelongsTo(id, agencyId);
    const doc = await this.contracts.documentBytes(id, 'WET_COPY');
    res.set({
      'Content-Type': doc.mimeType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline; filename="wet-copy"',
    });
    res.send(doc.data);
  }
}

/**
 * العقود — جانب المنصة: التوليد والإرسال والتوقيع المقابل والقوالب
 * والإعدادات.
 */
@Controller('v2/contracts')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class PlatformContractsController {
  constructor(
    private contracts: ContractsService,
    private alerts: ContractAlertsService,
  ) {}

  // ---- تنبيهات الاستحقاق ----

  @Get('alerts')
  @RequirePermissions('platform.contracts.manage')
  alertRules() {
    return this.alerts.listRules();
  }

  @Put('alerts/rules')
  @RequirePermissions('platform.contracts.settings')
  saveAlertRule(@Body() dto: AlertRuleDto, @CurrentUserV2() user: User) {
    return this.alerts.saveRule(dto, user.id);
  }

  @Delete('alerts/rules/:id')
  @RequirePermissions('platform.contracts.settings')
  deleteAlertRule(@Param('id') id: string) {
    return this.alerts.deleteRule(id);
  }

  /**
   * تشغيل الدورة الآن — بلا انتظار المؤقّت. ضبطُ قاعدةٍ ثم انتظار ست ساعات
   * لمعرفة أثرها ليس ضبطاً بل تخمين.
   */
  @Post('alerts/run')
  @RequirePermissions('platform.contracts.settings')
  runAlerts() {
    return this.alerts.run();
  }

  // ---- الإعدادات ----

  @Get('settings')
  @RequirePermissions('platform.contracts.manage')
  settings() {
    return this.contracts.settings();
  }

  @Patch('settings')
  @RequirePermissions('platform.contracts.settings')
  updateSettings(@Body() dto: SettingsDto) {
    return this.contracts.updateSettings(dto);
  }

  // ---- القوالب ----

  @Get('templates')
  @RequirePermissions('platform.contracts.settings')
  templates() {
    return this.contracts.listTemplates();
  }

  @Get('templates/variables')
  @RequirePermissions('platform.contracts.settings')
  variables() {
    return this.contracts.templateVariables();
  }

  @Get('templates/:id')
  @RequirePermissions('platform.contracts.settings')
  template(@Param('id') id: string) {
    return this.contracts.getTemplate(id);
  }

  @Put('templates')
  @RequirePermissions('platform.contracts.settings')
  saveTemplate(@Body() dto: TemplateDto, @CurrentUserV2() user: User) {
    return this.contracts.saveTemplate(dto, user.id);
  }

  @Post('templates/:id/activate')
  @RequirePermissions('platform.contracts.settings')
  activate(@Param('id') id: string) {
    return this.contracts.activateTemplate(id);
  }

  // ---- العقود ----

  @Get()
  @RequirePermissions('platform.contracts.manage')
  list(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('expiringInDays') expiringInDays?: string,
  ) {
    const known = Object.values(ContractStatus) as string[];
    if (status && !known.includes(status)) throw new BadRequestException('حالة غير معروفة');
    const days = expiringInDays ? Number(expiringInDays) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days < 0 || days > 365)) {
      throw new BadRequestException('مدى غير صالح');
    }
    return this.contracts.list({
      status: status as ContractStatus | undefined,
      q,
      expiringInDays: days,
    });
  }

  @Post('agencies/:agencyId/generate')
  @RequirePermissions('platform.contracts.manage')
  generate(
    @Param('agencyId') agencyId: string,
    @Body() dto: GenerateDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.generate(agencyId, dto, user.id, ip, ua);
  }

  @Get(':id')
  @RequirePermissions('platform.contracts.manage')
  detail(@Param('id') id: string) {
    return this.contracts.detail(id);
  }

  @Get(':id/document')
  @RequirePermissions('platform.contracts.manage')
  async document(@Param('id') id: string, @Res() res: Response) {
    sendDoc(res, await this.contracts.renderHtml(id));
  }

  @Post(':id/send')
  @RequirePermissions('platform.contracts.manage')
  send(
    @Param('id') id: string,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.send(id, user.id, ip, ua);
  }

  /** التوقيع المقابل — به يصير العقد سارياً وتبدأ المدة */
  @Post(':id/sign')
  @RequirePermissions('platform.contracts.sign')
  sign(
    @Param('id') id: string,
    @Body() dto: SignDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.signAsPlatform(id, dto, user.id, ip, ua);
  }

  @Post(':id/cancel')
  @RequirePermissions('platform.contracts.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: NoteDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.cancel(id, dto.note, user.id, ip, ua);
  }

  @Post(':id/terminate')
  @RequirePermissions('platform.contracts.sign')
  terminate(
    @Param('id') id: string,
    @Body() dto: NoteDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.terminate(id, dto.note, user.id, ip, ua);
  }

  @Get(':id/wet-copy/file')
  @RequirePermissions('platform.contracts.manage')
  async wetCopyFile(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.contracts.documentBytes(id, 'WET_COPY');
    res.set({
      'Content-Type': doc.mimeType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline; filename="wet-copy"',
    });
    res.send(doc.data);
  }

  @Post(':id/wet-copy/review')
  @RequirePermissions('platform.contracts.manage')
  reviewWetCopy(
    @Param('id') id: string,
    @Body() dto: ReviewWetCopyDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.contracts.reviewWetCopy(id, dto.verified, dto.reason, user.id, ip, ua);
  }

  @Post(':id/public-link')
  @RequirePermissions('platform.contracts.manage')
  publicLink(@Param('id') id: string) {
    return this.contracts.createPublicLink(id);
  }
}

/**
 * فتح العقد من متصفح خارجي بلا تسجيل دخول — بالرمز وحده.
 *
 * صفٌّ منفصل بلا حارس عمداً: ثقب حارسٍ على مستوى الصف لمسار واحد خطأ
 * يتكرّر. الحماية هنا أن الرمز عشوائي 256-bit ولا يُخزَّن خاماً، ويمكن
 * إبطاله فوراً.
 */
@Controller('v2/public/contracts')
export class PublicContractsController {
  constructor(private contracts: ContractsService) {}

  @Get(':token')
  async view(@Param('token') token: string, @Res() res: Response) {
    sendDoc(res, await this.contracts.byPublicToken(token));
  }
}
