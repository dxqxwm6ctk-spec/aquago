import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { COMPLAINT_TOPICS, SupportService, type ComplaintTopic } from './support.service';

class ComplaintDto {
  @IsIn(Object.keys(COMPLAINT_TOPICS)) topic!: ComplaintTopic;
  @IsString() @MinLength(10) @MaxLength(2000) bodyAr!: string;
  @IsOptional() @IsString() orderId?: string;
}

class ChatMessageDto {
  @IsString() @MinLength(10) @MaxLength(2000) bodyAr!: string;
}

/** الدعم من التطبيقات: يرسل المستخدم شكوى، ويتواصل معه الدعم خارج التطبيق */
@Controller('v2/support')
@UseGuards(JwtV2Guard)
export class SupportController {
  constructor(private support: SupportService) {}

  /** المواضيع المتاحة — تبنيها الشاشة ديناميكياً بدل تكرارها في التطبيق */
  @Get('topics')
  topics() {
    return Object.entries(COMPLAINT_TOPICS).map(([key, labelAr]) => ({
      key,
      labelAr,
    }));
  }

  @Get('complaints')
  mine(@CurrentUserV2() user: User) {
    return this.support.myComplaints(user.id);
  }

  @Post('complaints')
  submit(@CurrentUserV2() user: User, @Body() dto: ComplaintDto) {
    return this.support.submitComplaint(user.id, dto);
  }

  // ===== المحادثة الحيّة =====
  // المسارات أعلاه (topics/complaints) تبقى عاملة: النسخ المثبّتة على
  // أجهزة المستخدمين لا تزال تناديها، وحذفها يكسر شاشة الدعم عندهم.

  @Get('chat')
  chat(@CurrentUserV2() user: User) {
    return this.support.chatHistory(user.id);
  }

  @Post('chat')
  async sendChat(@CurrentUserV2() user: User, @Body() dto: ChatMessageDto) {
    // من التطبيق: تيليجرام يتلقى جرساً، والرد يكون من لوحة المنصة
    const res = await this.support.handleUserMessage(user.id, dto.bodyAr, 'APP');
    if (!res.ok) {
      // سببان مختلفان تماماً: نص قصير يُصلحه المستخدم بالكتابة، وطلب بلغ
      // سقفه لا يُصلحه إلا انتظار الدعم — رسالة واحدة لهما تُضلّل
      throw new BadRequestException(
        res.reason === 'AWAITING_APPROVAL'
          ? 'طلبك وصل الدعم وبانتظار الموافقة — ستُفتح المحادثة فور قبوله'
          : 'اكتب وصفاً للمشكلة (10 أحرف على الأقل)',
      );
    }
    return res;
  }
}
