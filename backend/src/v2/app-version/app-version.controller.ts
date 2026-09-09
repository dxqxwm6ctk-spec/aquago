import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtV2Guard } from '../auth/jwt-v2.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AppVersionService } from './app-version.service';

class UpdateAppVersionDto {
  @IsString() @MinLength(1) @MaxLength(20) minVersion!: string;
  /// مفتاح التفعيل — false يوقف الإجبار كلياً بصرف النظر عن minVersion
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(300) updateMessageAr?: string;
  @IsOptional() @IsString() @MaxLength(500) downloadUrl?: string | null;
}

@Controller('v2/app-version')
export class AppVersionController {
  constructor(private appVersion: AppVersionService) {}

  /** يستدعيه التطبيق عند الإقلاع — عام، بلا دخول (قبل تسجيل الزبون أصلاً) */
  @Get('check')
  check(@Query('app') app: string, @Query('version') version: string) {
    return this.appVersion.check(app, version);
  }

  @Get()
  @UseGuards(JwtV2Guard, PermissionsGuard)
  @RequirePermissions('platform.appversion.manage')
  list() {
    return this.appVersion.list();
  }

  @Put(':app')
  @UseGuards(JwtV2Guard, PermissionsGuard)
  @RequirePermissions('platform.appversion.manage')
  update(@Param('app') app: string, @Body() dto: UpdateAppVersionDto) {
    return this.appVersion.update(app, dto);
  }
}
