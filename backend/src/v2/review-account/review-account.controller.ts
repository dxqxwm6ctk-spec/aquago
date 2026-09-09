import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ReviewAccountService } from './review-account.service';

class UpdateReviewAccountDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional() @IsString() @MaxLength(20) code?: string | null;
  @IsOptional() @IsBoolean() requireCode?: boolean;
}

/**
 * إدارة حساب مراجعة المتجر. لا مسار عام هنا إطلاقاً: الباب يُستهلك من داخل
 * مسار الدخول نفسه، وكشف الرقم أو الرمز عبر واجهة عامة يُبطل الغرض.
 */
@Controller('v2/review-account')
@UseGuards(JwtV2Guard, PermissionsGuard)
@RequirePermissions('platform.reviewaccount.manage')
export class ReviewAccountController {
  constructor(private reviewAccount: ReviewAccountService) {}

  @Get()
  list() {
    return this.reviewAccount.list();
  }

  @Put(':app')
  update(
    @Param('app') app: string,
    @Body() dto: UpdateReviewAccountDto,
    @CurrentUserV2() user: User,
  ) {
    return this.reviewAccount.update(app, dto, user.id);
  }
}
