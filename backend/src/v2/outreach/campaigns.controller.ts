import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import type { Request } from 'express';
import { CampaignsService } from './campaigns.service';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import { WhatsAppEventsService } from './whatsapp-events.service';

const AUDIENCE_TYPES = [
  'ALL_LEADS',
  'PENDING_REVIEW_ONLY',
  'APPROVED_ONLY',
  'BY_AREA',
  'MANUAL_SELECTION',
  'CUSTOMERS',
  'DRIVERS',
  'AGENCY_STAFF',
  'PLATFORM_STAFF',
  'ALL_USERS',
  'CUSTOM_LIST',
] as const;

const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;

class CreateCampaignDto {
  @IsString() @IsNotEmpty() @MaxLength(150) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsString() @IsNotEmpty() @MaxLength(100) templateName!: string;
  @IsString() @IsNotEmpty() @MaxLength(4000) templateBody!: string;
  @IsOptional() @IsString() @MaxLength(10) templateLanguage?: string;
  @IsOptional() @IsIn(AUDIENCE_TYPES) audienceType?: (typeof AUDIENCE_TYPES)[number];
  @IsOptional() @IsString() areaId?: string;
  @IsOptional() @IsString() listId?: string;
  @IsOptional() @IsString() @MaxLength(120) metaTemplateName?: string;
  @IsOptional() @IsString() @MaxLength(10) metaTemplateLang?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) metaTemplateParams?: string[];
  @IsOptional() @IsDateString() scheduledAt?: string;
}

class UpdateCampaignDto extends CreateCampaignDto {
  @IsOptional() @IsString() @MaxLength(150) declare name: string;
  @IsOptional() @IsString() @MaxLength(100) declare templateName: string;
  @IsOptional() @IsString() @MaxLength(4000) declare templateBody: string;
}

class AudienceDto {
  @IsOptional() @IsArray() @IsString({ each: true }) leadIds?: string[];
  @IsOptional() @IsBoolean() skipPreviouslyContacted?: boolean;
}

class TestMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(30) phone!: string;
  @IsOptional() @IsString() @MaxLength(500) text?: string;
}

class RecipientsQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

/**
 * حالة بوابة OpenWA وأدوات فحصها — ما كان يُقرأ من سجلّات الخادم وحدها.
 *
 * مسار مستقل عن الحملات لأن `v2/whatsapp/campaigns/:id` كان سيبتلع أي مسار
 * فرعي جديد تحته.
 */
@Controller('v2/whatsapp/gateway')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class WhatsAppGatewayController {
  constructor(private admin: WhatsAppAdminService) {}

  @Get('status')
  @RequirePermissions('platform.campaigns.manage')
  status(@Req() req: Request) {
    // العنوان العام يُشتقّ من الطلب نفسه: رابط الأحداث يجب أن يشير إلى هذا
    // الخادم بعينه، وكتابته في متغيّر بيئة ثالث بابُ خطأ صامت
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
    return this.admin.status(host ? `${proto}://${host}` : undefined);
  }

  /** رسالة فحص — تُثبت أن السلسلة تعمل قبل إطلاق حملة على مئات الناس */
  @Post('test-message')
  @RequirePermissions('platform.campaigns.send')
  test(@Body() dto: TestMessageDto, @CurrentUserV2() user: User) {
    return this.admin.sendTest(dto.phone, dto.text, user.id);
  }
}

/**
 * حملات التواصل عبر واتساب.
 *
 * `platform.campaigns.manage` للإنشاء والقراءة، و`platform.campaigns.send`
 * للبدء والاستئناف — فصلٌ مقصود: كتابة نص حملة تجريبية شيء، وإطلاق آلاف
 * الرسائل إلى أناس حقيقيين شيء آخر.
 */
@Controller('v2/whatsapp/campaigns')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class CampaignsController {
  constructor(private campaigns: CampaignsService) {}

  @Get()
  @RequirePermissions('platform.campaigns.manage')
  list(@Query('status') status?: (typeof CAMPAIGN_STATUSES)[number]) {
    return this.campaigns.list(status);
  }

  @Post()
  @RequirePermissions('platform.campaigns.manage')
  create(@Body() dto: CreateCampaignDto, @CurrentUserV2() user: User) {
    return this.campaigns.create(dto, user.id);
  }

  @Get(':id')
  @RequirePermissions('platform.campaigns.manage')
  get(@Param('id') id: string) {
    return this.campaigns.get(id);
  }

  @Patch(':id')
  @RequirePermissions('platform.campaigns.manage')
  update(@Param('id') id: string, @Body() dto: UpdateCampaignDto, @CurrentUserV2() user: User) {
    return this.campaigns.update(id, { ...dto }, user.id);
  }

  /**
   * معاينة. **لا ترسل شيئاً ولا تنشئ مستلماً** — تحسب من سيصله ومن
   * سيُستبعَد ولماذا، بنفس قواعد البدء بالضبط.
   */
  @Post(':id/preview')
  @RequirePermissions('platform.campaigns.manage')
  preview(@Param('id') id: string, @Body() dto: AudienceDto) {
    return this.campaigns.preview(id, dto);
  }

  @Post(':id/start')
  @RequirePermissions('platform.campaigns.send')
  start(@Param('id') id: string, @Body() dto: AudienceDto, @CurrentUserV2() user: User) {
    return this.campaigns.start(id, dto, user.id);
  }

  @Post(':id/pause')
  @RequirePermissions('platform.campaigns.send')
  pause(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.campaigns.pause(id, user.id);
  }

  @Post(':id/resume')
  @RequirePermissions('platform.campaigns.send')
  resume(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.campaigns.resume(id, user.id);
  }

  @Post(':id/cancel')
  @RequirePermissions('platform.campaigns.send')
  cancel(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.campaigns.cancel(id, user.id);
  }

  /** تصفير حملة لم تخرج منها رسالة — بعد إصلاح إعداد البوابة */
  @Post(':id/reset')
  @RequirePermissions('platform.campaigns.send')
  reset(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.campaigns.resetUnsent(id, user.id);
  }

  @Get(':id/recipients')
  @RequirePermissions('platform.campaigns.manage')
  recipients(@Param('id') id: string, @Query() q: RecipientsQueryDto) {
    return this.campaigns.recipients(id, q.status, q.page, q.pageSize);
  }

  @Get(':id/messages')
  @RequirePermissions('platform.campaigns.manage')
  messages(@Param('id') id: string) {
    return this.campaigns.messages(id);
  }

  @Get(':id/stats')
  @RequirePermissions('platform.campaigns.manage')
  stats(@Param('id') id: string) {
    return this.campaigns.stats(id);
  }
}

/**
 * مستقبِل أحداث بوابة OpenWA — حالات التسليم والرسائل الواردة.
 *
 * **لا نظام webhook منافس**: بوابة OpenWA لا ترسل أحداثاً إلى النظام اليوم
 * (الاستعمال القائم إرسالٌ فقط)، وهذا المسار هو الطرف الذي تُوجَّه إليه حين
 * تُفعَّل الأحداث في البوابة. حتى ذلك الحين يبقى خاملاً ولا يكسر شيئاً.
 *
 * الحماية بنفس نمط webhook تيليجرام الموجود: السرّ في المسار، ومن لا يعرفه
 * يحصل على 404 كأن المسار غير موجود. ولا توكن مستخدم هنا لأن المنادي بوابة
 * لا إنسان.
 */
@Controller('v2/whatsapp/events')
export class WhatsAppEventsController {
  private readonly logger = new Logger(WhatsAppEventsController.name);

  constructor(private events: WhatsAppEventsService) {}

  @Post(':secret')
  async receive(@Param('secret') secret: string, @Body() payload: Record<string, any>) {
    const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
    if (!expected || secret !== expected) throw new NotFoundException();

    try {
      // شكل الحمولة يختلف بين نسخ البوابة — نقبل الشائع منها ولا نفترض واحداً
      const type = String(payload?.event ?? payload?.type ?? '').toLowerCase();
      const data = (payload?.data ?? payload) as Record<string, any>;

      if (type.includes('ack') || type.includes('status') || data?.ack !== undefined) {
        await this.events.handleStatusEvent({
          externalMessageId: String(data?.id ?? data?.messageId ?? data?.key?.id ?? ''),
          status: String(data?.status ?? data?.ack ?? ''),
          timestamp: data?.timestamp ? String(data.timestamp) : undefined,
          errorCode: data?.errorCode ? String(data.errorCode) : undefined,
          errorMessage: data?.errorMessage ? String(data.errorMessage) : undefined,
        });
      } else if (type.includes('message') || data?.from) {
        await this.events.handleInboundMessage({
          from: String(data?.from ?? ''),
          body: data?.body ?? data?.text ?? undefined,
          externalMessageId: data?.id ? String(data.id) : undefined,
          timestamp: data?.timestamp ? String(data.timestamp) : undefined,
        });
      }
    } catch (err) {
      // 200 دائماً بعد اجتياز فحص السرّ: البوابات تعيد المحاولة على أي خطأ،
      // فخطأ منطقي واحد كان سيتحوّل إلى تكرار لا ينتهي لنفس الحدث.
      this.logger.error(`فشل معالجة حدث واتساب: ${(err as Error).message}`);
    }
    return { ok: true };
  }
}
