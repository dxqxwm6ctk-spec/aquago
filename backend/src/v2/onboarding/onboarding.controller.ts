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
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { User } from '@prisma-v2/client';
import { OnboardingFieldMode, OnboardingStatus } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { OnboardingService } from './onboarding.service';

class SaveDraftDto {
  /** خريطة مفتاح→قيمة. القيم تُتحقَّق في الخدمة مقابل الكتالوج لا هنا:
   *  نوع كل حقل يعرفه الكتالوج، وتكرار ذلك في DTO يصنع مصدرين للحقيقة. */
  @IsObject() values!: Record<string, unknown>;
}

class LicenseDto {
  @IsOptional() @IsString() @MaxLength(60) number?: string | null;
  @IsOptional() @IsString() issuedAt?: string | null;
  @IsOptional() @IsString() expiresAt?: string | null;
}

class ReviewDto {
  @IsIn(['APPROVE', 'REJECT', 'REQUEST_CHANGES']) action!:
    | 'APPROVE'
    | 'REJECT'
    | 'REQUEST_CHANGES';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class ReviewDocDto {
  @IsBoolean() verified!: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class ReopenDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) note!: string;
}

class RequirementItemDto {
  @IsString() @IsNotEmpty() key!: string;
  @IsIn(['HIDDEN', 'OPTIONAL', 'REQUIRED']) mode!: OnboardingFieldMode;
  @IsOptional() @IsString() @MaxLength(200) labelAr?: string;
  @IsOptional() @IsString() @MaxLength(400) hintAr?: string;
}

class SetRequirementsDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => RequirementItemDto)
  items!: RequirementItemDto[];
}

const docUpload = FileInterceptor('file', {
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      cb(new BadRequestException('صيغة غير مدعومة — PNG أو JPEG أو WebP أو PDF'), false);
      return;
    }
    cb(null, true);
  },
});

/**
 * ملف المنشأة — جانب الوكالة.
 *
 * كل المسارات تحمل `:agencyId` عمداً: `PermissionsGuard` يفحص الصلاحية
 * **داخل تلك الوكالة**، فموظف وكالة لا يفتح ملف وكالة أخرى ولو حمل
 * الصلاحية في وكالته. ومن يملك صلاحية المراجعة على مستوى المنصة يمرّ عبر
 * الشرط نفسه، فيرى الأدمن ما تراه الوكالة بلا مسار ثانٍ.
 */
@Controller('v2/agencies/:agencyId/onboarding')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class AgencyOnboardingController {
  constructor(private onboarding: OnboardingService) {}

  @Get()
  @RequirePermissions('agency.onboarding.manage')
  get(@Param('agencyId') agencyId: string) {
    return this.onboarding.myFile(agencyId);
  }

  @Patch()
  @RequirePermissions('agency.onboarding.manage')
  save(@Param('agencyId') agencyId: string, @Body() dto: SaveDraftDto) {
    return this.onboarding.saveDraft(agencyId, dto.values);
  }

  @Put('licenses/:key')
  @RequirePermissions('agency.onboarding.manage')
  saveLicense(
    @Param('agencyId') agencyId: string,
    @Param('key') key: string,
    @Body() dto: LicenseDto,
  ) {
    return this.onboarding.saveLicense(agencyId, key, dto);
  }

  @Post('documents/:key')
  @RequirePermissions('agency.onboarding.manage')
  @UseInterceptors(docUpload)
  upload(
    @Param('agencyId') agencyId: string,
    @Param('key') key: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.onboarding.uploadDocument(agencyId, key, file, user.id, ip, ua);
  }

  @Delete('documents/:key')
  @RequirePermissions('agency.onboarding.manage')
  removeDocument(@Param('agencyId') agencyId: string, @Param('key') key: string) {
    return this.onboarding.deleteDocument(agencyId, key);
  }

  /**
   * معاينة وثيقة رفعتها الوكالة نفسها. البايتات لا تُقدَّم عبر
   * `MediaController` العام: صورة هوية شخصية ليست صورة قارورة، ومن خمّن
   * معرّفاً لا يجوز أن يفتحها.
   */
  @Get('documents/:key/file')
  @RequirePermissions('agency.onboarding.manage')
  async file(
    @Param('agencyId') agencyId: string,
    @Param('key') key: string,
    @Res() res: Response,
  ) {
    const onboardingId = await this.onboarding.onboardingIdOfAgency(agencyId);
    const doc = await this.onboarding.documentBytes(onboardingId, key);
    res.set({
      'Content-Type': doc.mimeType,
      // لا تخزين وسيط: وثيقة هوية في ذاكرة وكيلٍ مشترك تُقرأ بلا توكن
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${key}"`,
    });
    res.send(doc.data);
  }

  @Post('submit')
  @RequirePermissions('agency.onboarding.manage')
  submit(
    @Param('agencyId') agencyId: string,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.onboarding.submit(agencyId, user.id, ip, ua);
  }
}

/**
 * ملف المنشأة — جانب المنصة: الطابور والمراجعة وضبط ما يُطلب أصلاً.
 *
 * مسارٌ منفصل بلا `:agencyId` لأن المراجع يعمل عبر الوكالات كلها، ولا
 * ينبغي أن يمرّ بمسار مصمَّم لنطاق وكالة واحدة.
 */
@Controller('v2/onboarding')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class PlatformOnboardingController {
  constructor(private onboarding: OnboardingService) {}

  /** الكتالوج بحالته السارية — تقرؤه شاشة الإعدادات وشاشة المراجعة معاً */
  @Get('catalog')
  @RequirePermissions('platform.onboarding.review')
  catalog() {
    return this.onboarding.catalog();
  }

  @Put('requirements')
  @RequirePermissions('platform.onboarding.settings')
  setRequirements(@Body() dto: SetRequirementsDto, @CurrentUserV2() user: User) {
    return this.onboarding.setRequirements(dto.items, user.id);
  }

  @Get()
  @RequirePermissions('platform.onboarding.review')
  list(@Query('status') status?: string, @Query('q') q?: string) {
    const known = Object.values(OnboardingStatus) as string[];
    if (status && !known.includes(status)) {
      throw new BadRequestException('حالة غير معروفة');
    }
    return this.onboarding.list({ status: status as OnboardingStatus | undefined, q });
  }

  @Get(':id')
  @RequirePermissions('platform.onboarding.review')
  detail(@Param('id') id: string) {
    return this.onboarding.detail(id);
  }

  @Get(':id/documents/:key/file')
  @RequirePermissions('platform.onboarding.review')
  async file(@Param('id') id: string, @Param('key') key: string, @Res() res: Response) {
    const doc = await this.onboarding.documentBytes(id, key);
    res.set({
      'Content-Type': doc.mimeType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${key}"`,
    });
    res.send(doc.data);
  }

  @Post(':id/review')
  @RequirePermissions('platform.onboarding.review')
  review(
    @Param('id') id: string,
    @Body() dto: ReviewDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.onboarding.review(id, dto.action, dto.note, user.id, ip, ua);
  }

  @Post(':id/documents/:key/review')
  @RequirePermissions('platform.onboarding.review')
  reviewDoc(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: ReviewDocDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.onboarding.reviewDocument(id, key, dto.verified, dto.reason, user.id, ip, ua);
  }

  @Post(':id/reopen')
  @RequirePermissions('platform.onboarding.review')
  reopen(
    @Param('id') id: string,
    @Body() dto: ReopenDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ) {
    return this.onboarding.reopen(id, dto.note, user.id, ip, ua);
  }
}
