import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { toJordanE164 } from '../common/phone.util';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { normalizePhoneForMatch } from './duplicate-detection.util';

class CreateListDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

class AddMembersDto {
  /** نصّ حرّ فيه أرقام — يُلصق كما هو من جدول أو رسالة */
  @IsOptional() @IsString() @MaxLength(200_000) numbers?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) leadIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}

class OptOutDto {
  @IsString() @IsNotEmpty() @MaxLength(30) phone!: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Injectable()
export class RecipientListsService {
  constructor(private prisma: PrismaV2Service) {}

  list() {
    return this.prisma.recipientList.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });
  }

  async get(id: string) {
    const row = await this.prisma.recipientList.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true } },
        members: { orderBy: { createdAt: 'asc' }, take: 1000 },
        _count: { select: { members: true } },
      },
    });
    if (!row) throw new NotFoundException('القائمة غير موجودة');
    return row;
  }

  async create(dto: CreateListDto, actorId: string) {
    return this.prisma.recipientList.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        createdById: actorId,
      },
    });
  }

  async remove(id: string, actorId: string) {
    const used = await this.prisma.whatsAppCampaign.count({ where: { listId: id } });
    if (used > 0) {
      // حملة تشير إلى قائمة محذوفة تفقد تفسير من أُرسل إليه ولماذا
      throw new BadRequestException(`القائمة مستعملة في ${used} حملة — لا تُحذف`);
    }
    await this.prisma.recipientList.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'recipient-list.delete',
        entityType: 'RecipientList',
        entityId: id,
      },
    });
    return { ok: true };
  }

  /**
   * إضافة أعضاء من ثلاثة مصادر معاً: نصّ أرقام ملصوق، ووكالات مختارة،
   * ومستخدمون مختارون.
   *
   * الأرقام تُستخرج من النصّ بلا اشتراط تنسيق: الأدمن يلصق عموداً من إكسل أو
   * رسالة واتساب فيها فواصل وأسماء، ومطالبته بتنظيفها يدوياً تعني أنه لن
   * يستعمل الميزة. ما لا يُطبَّع يُبلَّغ عنه ولا يُخمَّن.
   */
  async addMembers(listId: string, dto: AddMembersDto, actorId: string) {
    await this.get(listId);

    const entries: { phoneNumber: string; name?: string | null; leadId?: string; userId?: string }[] = [];
    const invalid: string[] = [];

    if (dto.numbers?.trim()) {
      // أي تتابع أرقام طوله معقول — الفواصل والأسماء بينها تُتجاهَل
      const tokens = dto.numbers.match(/[+\d][\d\s-]{6,}/g) ?? [];
      for (const raw of tokens) {
        const phone = normalizePhoneForMatch(raw);
        if (toJordanE164(phone)) entries.push({ phoneNumber: phone });
        else invalid.push(raw.trim());
      }
    }

    if (dto.leadIds?.length) {
      const leads = await this.prisma.agencyLead.findMany({
        where: { id: { in: dto.leadIds }, deletedAt: null },
        select: { id: true, name: true, whatsappNumber: true, phoneNumber: true },
      });
      for (const l of leads) {
        const phone = l.whatsappNumber || l.phoneNumber;
        if (phone && toJordanE164(phone)) {
          entries.push({ phoneNumber: phone, name: l.name, leadId: l.id });
        } else invalid.push(l.name);
      }
    }

    if (dto.userIds?.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: dto.userIds }, phone: { not: null } },
        select: { id: true, name: true, phone: true },
      });
      for (const u of users) {
        if (toJordanE164(u.phone!)) {
          entries.push({ phoneNumber: u.phone!, name: u.name, userId: u.id });
        } else invalid.push(u.name);
      }
    }

    if (!entries.length) {
      throw new BadRequestException(
        invalid.length ? 'لا رقم صالح بين ما أدخلته' : 'لا شيء لإضافته',
      );
    }

    // القيد الفريد (listId, phoneNumber) يتكفّل بالتكرار — داخل الدفعة وعبرها
    const { count } = await this.prisma.recipientListMember.createMany({
      data: entries.map((e) => ({ listId, ...e })),
      skipDuplicates: true,
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'recipient-list.add-members',
        entityType: 'RecipientList',
        entityId: listId,
        newValue: { added: count, submitted: entries.length, invalid: invalid.length },
      },
    });
    return {
      added: count,
      duplicates: entries.length - count,
      invalid: invalid.slice(0, 50),
      invalidCount: invalid.length,
    };
  }

  async removeMember(listId: string, memberId: string) {
    await this.prisma.recipientListMember.deleteMany({ where: { id: memberId, listId } });
    return { ok: true };
  }

  // ============ قائمة المنع العامة ============

  optOuts() {
    return this.prisma.whatsAppOptOut.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async addOptOut(dto: OptOutDto, actorId: string) {
    const phone = normalizePhoneForMatch(dto.phone);
    if (!toJordanE164(phone)) throw new BadRequestException('رقم غير صالح');
    const row = await this.prisma.whatsAppOptOut.upsert({
      where: { phoneNumber: phone },
      create: { phoneNumber: phone, source: 'إدخال إداري', reason: dto.reason?.trim() || null },
      update: {},
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'whatsapp.opt-out.add',
        entityType: 'WhatsAppOptOut',
        entityId: phone,
        newValue: { reason: dto.reason ?? null },
      },
    });
    return row;
  }

  /**
   * إخراج رقم من قائمة المنع — فعلٌ بشري صريح ويُكتب في سجلّ التدقيق.
   *
   * الدخول إلى القائمة تلقائي وفوري، والخروج منها ليس كذلك عمداً: إعادة
   * مراسلة من طلب ألا تُراسله قرارٌ يتحمّله إنسان باسمه.
   */
  async removeOptOut(phone: string, actorId: string) {
    const normalized = normalizePhoneForMatch(phone);
    await this.prisma.whatsAppOptOut.deleteMany({ where: { phoneNumber: normalized } });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'whatsapp.opt-out.remove',
        entityType: 'WhatsAppOptOut',
        entityId: normalized,
      },
    });
    return { ok: true };
  }
}

/**
 * قوائم المستلمين وقائمة المنع العامة.
 *
 * تحت `v2/whatsapp/` مع بقية أدوات التواصل، وبمسار مستقل عن `campaigns/:id`
 * حتى لا يبتلعها.
 */
@Controller('v2/whatsapp')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class RecipientListsController {
  constructor(private lists: RecipientListsService) {}

  @Get('lists')
  @RequirePermissions('platform.campaigns.manage')
  list() {
    return this.lists.list();
  }

  @Post('lists')
  @RequirePermissions('platform.campaigns.manage')
  create(@Body() dto: CreateListDto, @CurrentUserV2() user: User) {
    return this.lists.create(dto, user.id);
  }

  @Get('lists/:id')
  @RequirePermissions('platform.campaigns.manage')
  get(@Param('id') id: string) {
    return this.lists.get(id);
  }

  @Delete('lists/:id')
  @RequirePermissions('platform.campaigns.manage')
  remove(@Param('id') id: string, @CurrentUserV2() user: User) {
    return this.lists.remove(id, user.id);
  }

  @Post('lists/:id/members')
  @RequirePermissions('platform.campaigns.manage')
  addMembers(@Param('id') id: string, @Body() dto: AddMembersDto, @CurrentUserV2() user: User) {
    return this.lists.addMembers(id, dto, user.id);
  }

  @Delete('lists/:id/members/:memberId')
  @RequirePermissions('platform.campaigns.manage')
  removeMember(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.lists.removeMember(id, memberId);
  }

  @Get('opt-outs')
  @RequirePermissions('platform.campaigns.manage')
  optOuts() {
    return this.lists.optOuts();
  }

  @Post('opt-outs')
  @RequirePermissions('platform.campaigns.manage')
  addOptOut(@Body() dto: OptOutDto, @CurrentUserV2() user: User) {
    return this.lists.addOptOut(dto, user.id);
  }

  @Delete('opt-outs/:phone')
  @RequirePermissions('platform.campaigns.send')
  removeOptOut(@Param('phone') phone: string, @CurrentUserV2() user: User) {
    return this.lists.removeOptOut(phone, user.id);
  }
}
