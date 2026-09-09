import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { NotificationsService } from './notifications.service';

class UpdatePreferencesDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() offers?: boolean;
  @IsOptional() @IsBoolean() orders?: boolean;
  @IsOptional() @IsBoolean() system?: boolean;
}

/** سجل إشعارات المستخدم وتفضيلاته — مشترك بين تطبيقي السائق والزبون */
@Controller('v2/notifications')
@UseGuards(JwtV2Guard)
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  list(@CurrentUserV2() user: User, @Query('take') take?: string) {
    return this.notifications.list(user.id, take ? Number(take) : undefined);
  }

  @Get('unread-count')
  unread(@CurrentUserV2() user: User) {
    return this.notifications.unreadCount(user.id).then((unread) => ({ unread }));
  }

  @Get('preferences')
  preferences(@CurrentUserV2() user: User) {
    return this.notifications.preferences(user.id);
  }

  @Patch('preferences')
  updatePreferences(@CurrentUserV2() user: User, @Body() dto: UpdatePreferencesDto) {
    return this.notifications.updatePreferences(user.id, dto);
  }

  @Post('read-all')
  readAll(@CurrentUserV2() user: User) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  read(@CurrentUserV2() user: User, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  /** إفراغ الوارد كاملاً — قبل :id حتى لا يبتلعها المسار ذو المعامل */
  @Delete()
  clear(@CurrentUserV2() user: User) {
    return this.notifications.removeAll(user.id);
  }

  @Delete(':id')
  remove(@CurrentUserV2() user: User, @Param('id') id: string) {
    return this.notifications.remove(user.id, id);
  }
}
