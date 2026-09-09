import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AgencyLeadsService } from './agency-leads.service';
import { LeadImportService } from './lead-import.service';

const LICENSE_STATUSES = ['UNKNOWN', 'LICENSED', 'UNLICENSED', 'PENDING_VERIFICATION'] as const;
const APPROVAL_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DELETED'] as const;
const SOURCE_TYPES = [
  'GOOGLE_MAPS',
  'OFFICIAL_WEBSITE',
  'FACEBOOK',
  'INSTAGRAM',
  'PUBLIC_DIRECTORY',
  'GOVERNMENT_SOURCE',
  'MANUAL',
  // أُضيف مع نموذج التسجيل الذاتي. غيابه هنا كان يجعل الفلتر عليه وتعديل
  // مصدر أي سجل مسجَّل ذاتياً يُرفضان بـ400 — القائمة هنا هي التي تحكم.
  'SELF_REGISTRATION',
  'OTHER',
] as const;
const CONTACT_STATUSES = ['NOT_CONTACTED', 'CONTACTED', 'CONTACT_FAILED'] as const;
const RESPONSE_STATUSES = ['NO_RESPONSE', 'RESPONDED', 'INTERESTED', 'NOT_INTERESTED'] as const;

class CreateLeadDto {
  @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) businessName?: string;
  @IsOptional() @IsString() @MaxLength(30) phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(30) whatsappNumber?: string;
  @IsOptional() @IsString() @MaxLength(30) alternativePhoneNumber?: string;
  @IsOptional() @IsString() areaId?: string;
  @IsOptional() @IsString() @MaxLength(120) areaName?: string;
  @IsOptional() @IsString() @MaxLength(120) neighborhood?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
  @IsOptional() @IsIn(LICENSE_STATUSES) licenseStatus?: (typeof LICENSE_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(80) licenseNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) licenseSource?: string;
  @IsOptional() @IsIn(SOURCE_TYPES) dataSource?: (typeof SOURCE_TYPES)[number];
  @IsOptional() @IsString() @MaxLength(500) sourceUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class UpdateLeadDto extends CreateLeadDto {
  @IsOptional() @IsString() @MaxLength(200) declare name: string;
}

class ReasonDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

class OptionalReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class NoteDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) note!: string;
  @IsOptional() @IsIn(['WHATSAPP', 'PHONE', 'SMS', 'EMAIL']) channel?: 'WHATSAPP' | 'PHONE' | 'SMS' | 'EMAIL';
}

class DoNotContactDto {
  @IsBoolean() on!: boolean;
}

class OptInDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsIn(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT']) status!: 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT';
  @IsString() @IsNotEmpty() @MaxLength(200) source!: string;
}

class DataSourceDto {
  @IsIn(SOURCE_TYPES) sourceType!: (typeof SOURCE_TYPES)[number];
  @IsOptional() @IsString() @MaxLength(200) sourceName?: string;
  @IsOptional() @IsString() @MaxLength(500) sourceUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsBoolean() isPrimarySource?: boolean;
}

class ResolveDuplicateDto {
  @IsBoolean() isDuplicate!: boolean;
}

class ImportRowsDto {
  @IsArray() rows!: Record<string, unknown>[];
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
}

class ListLeadsDto {
  @IsOptional() @IsString() areaId?: string;
  @IsOptional() @IsIn(LICENSE_STATUSES) licenseStatus?: (typeof LICENSE_STATUSES)[number];
  @IsOptional() @IsIn(APPROVAL_STATUSES) approvalStatus?: (typeof APPROVAL_STATUSES)[number];
  @IsOptional() @IsIn(CONTACT_STATUSES) contactStatus?: (typeof CONTACT_STATUSES)[number];
  @IsOptional() @IsIn(RESPONSE_STATUSES) responseStatus?: (typeof RESPONSE_STATUSES)[number];
  @IsOptional() @IsIn(SOURCE_TYPES) dataSource?: (typeof SOURCE_TYPES)[number];
  @IsOptional() @Type(() => Boolean) @IsBoolean() whatsappAvailable?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() interested?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() registered?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() doNotContact?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() possibleDuplicates?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() includeDeleted?: boolean;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(['applied', 'newest']) sort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

/**
 * إدارة الوكالات المحتملة.
 *
 * **لماذا `/v2/agency-leads` لا `/v2/agencies`؟** الأخير محجوز بالكامل
 * للوكالات العاملة (لوحة الوكالة ولوحة المنصة تناديانه)، وتركيب مسارين
 * مختلفَي المعنى على عنوان واحد يكسر ما يعمل اليوم.
 *
 * الصلاحيات: `platform.leads.manage` للقراءة والتعديل، و`platform.leads.approve`
 * للاعتماد والرفض والإيقاف والحذف — فصل مقصود: من يُدخل البيانات ليس بالضرورة
 * من يقرر قبول الوكالة.
 */
@Controller('v2/agency-leads')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class AgencyLeadsController {
  constructor(
    private leads: AgencyLeadsService,
    private imports: LeadImportService,
  ) {}

  // ---- الاستيراد قبل :id حتى لا يلتقطها المسار العام ----

  @Post('import')
  @RequirePermissions('platform.leads.manage')
  importRows(@Body() dto: ImportRowsDto, @CurrentUserV2() user: User) {
    return this.imports.start(dto.rows, dto.fileName, user.id);
  }

  /** استيراد ملف CSV — نفس المسار بصيغة multipart */
  @Post('import/file')
  @RequirePermissions('platform.leads.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
        if (!ok.includes(file.mimetype) && !file.originalname.endsWith('.csv')) {
          cb(new BadRequestException('الملف يجب أن يكون CSV'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  importFile(@UploadedFile() file: Express.Multer.File, @CurrentUserV2() user: User) {
    if (!file) throw new BadRequestException('لا ملف مرفق');
    const rows = LeadImportService.parseCsv(file.buffer.toString('utf8'));
    return this.imports.start(rows, file.originalname, user.id);
  }

  @Get('imports')
  @RequirePermissions('platform.leads.manage')
  listImports() {
    return this.imports.list();
  }

  @Get('imports/:id')
  @RequirePermissions('platform.leads.manage')
  getImport(@Param('id') id: string) {
    return this.imports.get(id);
  }

  @Get('stats')
  @RequirePermissions('platform.leads.manage')
  stats() {
    return this.leads.stats();
  }

  // ---- CRUD ----

  @Get()
  @RequirePermissions('platform.leads.manage')
  list(@Query() q: ListLeadsDto) {
    return this.leads.list(q);
  }

  @Post()
  @RequirePermissions('platform.leads.manage')
  create(@Body() dto: CreateLeadDto, @CurrentUserV2() user: User) {
    return this.leads.create(dto, user.id);
  }

  @Get(':id')
  @RequirePermissions('platform.leads.manage')
  get(@Param('id') id: string) {
    return this.leads.get(id);
  }

  @Patch(':id')
  @RequirePermissions('platform.leads.manage')
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @CurrentUserV2() user: User) {
    return this.leads.update(id, dto, user.id);
  }

  /** حذف ناعم — السجل يبقى في القاعدة ويغيب عن القوائم */
  @Delete(':id')
  @RequirePermissions('platform.leads.approve')
  softDelete(
    @Param('id') id: string,
    @Body() dto: OptionalReasonDto,
    @CurrentUserV2() user: User,
  ) {
    return this.leads.changeApproval(id, 'DELETED', dto.reason, user.id);
  }

  // ---- الاعتماد ----

  @Post(':id/approve')
  @RequirePermissions('platform.leads.approve')
  approve(@Param('id') id: string, @Body() dto: OptionalReasonDto, @CurrentUserV2() user: User) {
    return this.leads.changeApproval(id, 'APPROVED', dto.reason, user.id);
  }

  @Post(':id/reject')
  @RequirePermissions('platform.leads.approve')
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUserV2() user: User) {
    return this.leads.changeApproval(id, 'REJECTED', dto.reason, user.id);
  }

  @Post(':id/suspend')
  @RequirePermissions('platform.leads.approve')
  suspend(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUserV2() user: User) {
    return this.leads.changeApproval(id, 'SUSPENDED', dto.reason, user.id);
  }

  /** استعادة محذوف — يعود إلى قائمة المراجعة لا إلى الاعتماد */
  @Post(':id/restore')
  @RequirePermissions('platform.leads.approve')
  restore(@Param('id') id: string, @Body() dto: OptionalReasonDto, @CurrentUserV2() user: User) {
    return this.leads.changeApproval(id, 'PENDING_REVIEW', dto.reason, user.id);
  }

  @Post(':id/delete')
  @RequirePermissions('platform.leads.approve')
  deleteViaPost(
    @Param('id') id: string,
    @Body() dto: OptionalReasonDto,
    @CurrentUserV2() user: User,
  ) {
    return this.leads.changeApproval(id, 'DELETED', dto.reason, user.id);
  }

  @Get(':id/approval-history')
  @RequirePermissions('platform.leads.manage')
  approvalHistory(@Param('id') id: string) {
    return this.leads.approvalHistory(id);
  }

  // ---- التواصل ----

  @Get(':id/outreach')
  @RequirePermissions('platform.leads.manage')
  outreach(@Param('id') id: string) {
    return this.leads.outreachHistory(id);
  }

  @Post(':id/outreach/notes')
  @RequirePermissions('platform.leads.manage')
  addNote(@Param('id') id: string, @Body() dto: NoteDto, @CurrentUserV2() user: User) {
    return this.leads.addNote(id, dto.note, user.id, dto.channel);
  }

  @Get(':id/messages')
  @RequirePermissions('platform.leads.manage')
  messages(@Param('id') id: string) {
    return this.leads.messages(id);
  }

  @Get(':id/contact-history')
  @RequirePermissions('platform.leads.manage')
  contactHistory(@Param('id') id: string) {
    return this.leads.contactHistory(id);
  }

  @Post(':id/do-not-contact')
  @RequirePermissions('platform.leads.manage')
  doNotContact(
    @Param('id') id: string,
    @Body() dto: DoNotContactDto,
    @CurrentUserV2() user: User,
  ) {
    return this.leads.setDoNotContact(id, dto.on, user.id);
  }

  @Post(':id/opt-in')
  @RequirePermissions('platform.leads.manage')
  optIn(@Param('id') id: string, @Body() dto: OptInDto, @CurrentUserV2() user: User) {
    return this.leads.setOptIn(id, dto.phone, dto.status, dto.source, user.id);
  }

  @Post(':id/data-sources')
  @RequirePermissions('platform.leads.manage')
  addSource(@Param('id') id: string, @Body() dto: DataSourceDto, @CurrentUserV2() user: User) {
    return this.leads.addDataSource(id, dto, user.id);
  }

  @Post(':id/resolve-duplicate')
  @RequirePermissions('platform.leads.manage')
  resolveDuplicate(
    @Param('id') id: string,
    @Body() dto: ResolveDuplicateDto,
    @CurrentUserV2() user: User,
  ) {
    return this.leads.resolveDuplicate(id, dto.isDuplicate, user.id);
  }
}
