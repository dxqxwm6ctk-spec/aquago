import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AppTarget } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';

const APPS: AppTarget[] = ['CUSTOMER', 'DRIVER'];

class UpdateCtaDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(120) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(300) bodyAr?: string;
  @IsOptional() @IsString() @MaxLength(60) ctaAr?: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string | null;
}

@Injectable()
export class AgencyCtaService {
  constructor(private prisma: PrismaV2Service) {}

  private normalizeApp(raw: string): AppTarget {
    const app = String(raw || '').toUpperCase() as AppTarget;
    if (!APPS.includes(app)) throw new BadRequestException('تطبيق غير معروف');
    return app;
  }

  /**
   * ما يقرأه التطبيق. الصمت هو الافتراضي: صفٌّ غير موجود، أو مطفأ، أو بلا
   * رابط — كلها تعني «لا بطاقة»، ويردّ `enabled: false` بلا نصوص. التطبيق
   * لا يحتاج أن يعرف أيّ الأسباب الثلاثة، ولا نرسل نصوصاً لا تُعرض.
   */
  async publicConfig(rawApp: string) {
    const app = this.normalizeApp(rawApp);
    const row = await this.prisma.agencyCtaConfig.findUnique({ where: { app } });
    if (!row?.enabled || !row.url?.trim()) return { enabled: false };
    return {
      enabled: true,
      titleAr: row.titleAr,
      bodyAr: row.bodyAr,
      ctaAr: row.ctaAr,
      url: row.url,
    };
  }

  /** للوحة: الصفّان كما هما، وتُنشأ الناقصة بقيمها الافتراضية */
  async list() {
    for (const app of APPS) {
      await this.prisma.agencyCtaConfig.upsert({
        where: { app },
        create: { app },
        update: {},
      });
    }
    return this.prisma.agencyCtaConfig.findMany({ orderBy: { app: 'asc' } });
  }

  async update(rawApp: string, dto: UpdateCtaDto, actorId: string) {
    const app = this.normalizeApp(rawApp);
    const url = dto.url?.trim() || null;
    // رابط لا يُفتح من تطبيق جوال ليس رابطاً — https أو تحويلة معروفة فقط
    if (url && !/^(https?:\/\/|tel:|mailto:|whatsapp:)/i.test(url)) {
      throw new BadRequestException('الرابط يجب أن يبدأ بـ https:// أو tel: أو whatsapp:');
    }
    if (dto.enabled && !url) {
      const existing = await this.prisma.agencyCtaConfig.findUnique({ where: { app } });
      if (!existing?.url && dto.url === undefined) {
        throw new BadRequestException('لا يمكن التفعيل بلا رابط');
      }
    }

    const before = await this.prisma.agencyCtaConfig.findUnique({ where: { app } });
    const data = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.titleAr !== undefined ? { titleAr: dto.titleAr.trim() } : {}),
      ...(dto.bodyAr !== undefined ? { bodyAr: dto.bodyAr.trim() } : {}),
      ...(dto.ctaAr !== undefined ? { ctaAr: dto.ctaAr.trim() } : {}),
      ...(dto.url !== undefined ? { url } : {}),
    };
    const row = await this.prisma.agencyCtaConfig.upsert({
      where: { app },
      create: { app, ...data },
      update: data,
    });
    // بطاقة تظهر لكل مستخدمي تطبيق حيّ — من غيّرها ومتى سؤالٌ يُسأل
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'agency-cta.update',
        entityType: 'AgencyCtaConfig',
        entityId: app,
        oldValue: before ?? undefined,
        newValue: row,
      },
    });
    return row;
  }
}

/**
 * دعوة أصحاب الوكالات داخل التطبيقين.
 *
 * `GET config` عام بلا مصادقة رغم أن البطاقة تُعرض للداخلين وحدهم: إخفاؤها
 * خلف توكن لا يحمي شيئاً (نصّ دعوة ورابط عام)، ويجعل التطبيق ينتظر الدخول
 * ليقرأ إعداداً لا سرّ فيه. قرار «متى تُعرض» عند التطبيق.
 */
@Controller('v2/agency-cta')
export class AgencyCtaController {
  constructor(private cta: AgencyCtaService) {}

  @Get('config')
  config(@Query('app') app: string) {
    return this.cta.publicConfig(app);
  }
}

@Controller('v2/platform/agency-cta')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class AgencyCtaAdminController {
  constructor(private cta: AgencyCtaService) {}

  @Get()
  @RequirePermissions('platform.appversion.manage')
  list() {
    return this.cta.list();
  }

  @Put(':app')
  @RequirePermissions('platform.appversion.manage')
  update(
    @Param('app') app: string,
    @Body() dto: UpdateCtaDto,
    @CurrentUserV2() user: { id: string },
  ) {
    return this.cta.update(app, dto, user.id);
  }
}
