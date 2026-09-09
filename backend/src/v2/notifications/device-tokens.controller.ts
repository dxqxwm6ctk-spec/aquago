import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { DeviceApp, DevicePlatform } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';

class RegisterDeviceTokenDto {
  @IsString() token!: string;
  @IsEnum(DevicePlatform) platform!: DevicePlatform;
  /**
   * أي تطبيق يسجّل. اختياري لتبقى النسخ القديمة تعمل — غيابه يعني الزبون،
   * وهو ما كانت عليه كل التوكنات قبل هذا الحقل. تطبيق السائق يرسله صراحةً.
   */
  @IsOptional() @IsEnum(DeviceApp) app?: DeviceApp;
}

/** تسجيل/إلغاء توكن FCM لجهاز المستخدم — يغذّي إشعارات Push */
@Controller('v2/device-tokens')
@UseGuards(JwtV2Guard)
export class DeviceTokensController {
  private readonly logger = new Logger(DeviceTokensController.name);

  constructor(private prisma: PrismaV2Service) {}

  /**
   * تشخيص ذاتي: هل وصل توكن هذا المستخدم إلى قاعدة البيانات؟
   *
   * السؤال «لماذا لا توجد device tokens؟» كان يحتاج وصولاً إلى القاعدة
   * للإجابة عليه. هنا يجيب عنه الجهاز نفسه بنداء واحد، وهو ما يفصل عطل
   * التطبيق (لا توكن أصلاً) عن عطل الإرسال (توكن موجود ولا يصل إشعار).
   *
   * لا يُعيد التوكنات كاملة — آخر ثمانية محارف تكفي للتمييز، والتوكن الكامل
   * يُرسَل إليه إشعاراً باسم صاحبه لو تسرّب.
   */
  @Get()
  async mine(@CurrentUserV2() user: User) {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId: user.id },
      select: { platform: true, app: true, lastSeenAt: true, token: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    return {
      count: rows.length,
      devices: rows.map((r) => ({
        platform: r.platform,
        app: r.app,
        tokenSuffix: r.token.slice(-8),
        lastSeenAt: r.lastSeenAt,
      })),
    };
  }

  /**
   * upsert بالـ token لا بالـ userId: الـ token فريد عالمياً، فإذا نفس
   * الجهاز سجّل دخول بحساب آخر لازم يُعاد تعيين userId بدل رفض الطلب.
   */
  @Post()
  async register(
    @CurrentUserV2() user: User,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    const row = await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: {
        userId: user.id,
        token: dto.token,
        platform: dto.platform,
        app: dto.app ?? DeviceApp.CUSTOMER,
      },
      // التطبيق يُحدَّث أيضاً: نفس الجهاز قد يُلغي تثبيت تطبيق ويثبّت الآخر،
      // فيعيد FCM إصدار التوكن ذاته لتطبيق مختلف.
      update: {
        userId: user.id,
        platform: dto.platform,
        app: dto.app ?? DeviceApp.CUSTOMER,
        lastSeenAt: new Date(),
      },
    });
    // أثر الوصول: يفصل «التطبيق لم يرسل» عن «الخادم رفض» — وهما سببان
    // مختلفان تماماً لغياب التوكن، وكانا يبدوان واحداً في السجل.
    this.logger.log(
      `توكن جهاز ${dto.platform}/${dto.app ?? 'CUSTOMER'} سُجّل للمستخدم ${user.id} (…${dto.token.slice(-8)})`,
    );
    return row;
  }

  @Delete(':token')
  async unregister(@CurrentUserV2() user: User, @Param('token') token: string) {
    const { count } = await this.prisma.deviceToken.deleteMany({
      where: { token, userId: user.id },
    });
    return { deleted: count };
  }
}
