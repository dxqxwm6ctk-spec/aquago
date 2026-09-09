import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AgencyLeadsService } from './agency-leads.service';

class ApplyDto {
  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) businessName?: string;
  @IsString() @IsNotEmpty() @MaxLength(30) phoneNumber!: string;
  @IsOptional() @IsString() @MaxLength(30) whatsappNumber?: string;
  @IsOptional() @IsString() @MaxLength(60) areaId?: string;
  @IsOptional() @IsString() @MaxLength(120) areaName?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
  @IsOptional() @IsString() @MaxLength(80) licenseNumber?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/**
 * تقديم الوكالة لنفسها — **مسار عام بلا مصادقة**، يخدم نموذج `/apply/`.
 *
 * صفٌّ منفصل عن `AgencyLeadsController` لسببين: ذاك محميّ بحارسين على مستوى
 * الصف كله، ولا يجوز أن يُثقب حارسٌ لمسار واحد؛ وعنوانه `v2/agency-leads`
 * يحمل `@Get(':id')` الذي قد يبتلع أي مسار فرعي جديد. العنوان هنا مستقلّ
 * تماماً فلا تعارض ولا ثقب.
 *
 * الحماية بديلاً عن التوكن: حدّ معدّل على العنوان وعلى رقم الهاتف داخل
 * الخدمة، وتحقّق من الأرقام، وسقوف طول على كل حقل. وما يدخل من هنا يبقى
 * `PENDING_REVIEW` لا يقترب من الاعتماد.
 */
@Controller('v2/agency-applications')
export class AgencyApplyController {
  constructor(private leads: AgencyLeadsService) {}

  /** مناطق للاختيار في النموذج — أسماء إدارية عامة، لا بيانات حسّاسة */
  @Get('areas')
  areas() {
    return this.leads.publicAreas();
  }

  @Post()
  apply(@Body() dto: ApplyDto, @Ip() ip: string) {
    return this.leads.applyPublic(dto, ip);
  }
}
