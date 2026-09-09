import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import type { User } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { AuthV2Service, publicUser } from './auth-v2.service';
import { deviceLabel } from './device-label.util';
import { CurrentUserV2, JwtV2Guard } from './jwt-v2.guard';

class FirebaseLoginDto {
  @IsString() @IsNotEmpty() idToken!: string;
  @IsOptional() @IsString() name?: string;
}

/** دخول جوجل أو آبل — الاسم يأتي داخل التوكن نفسه فلا يُرسله التطبيق */
class SocialLoginDto {
  @IsString() @IsNotEmpty() idToken!: string;
}

/** بدء/استطلاع مصافحة واتساب — الرقم وحده، لا رمز بعد */
class WhatsappHandshakeDto {
  @IsString() @IsNotEmpty() phone!: string;
}

class PhoneVerifyRequestDto {
  @IsString() @IsNotEmpty() phone!: string;
}

class PhoneVerifyConfirmDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @IsNotEmpty() code!: string;
}

class DevLoginDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsOptional() @IsString() name?: string;
}

class WhatsappOtpRequestDto {
  @IsString() @IsNotEmpty() phone!: string;
}

class WhatsappOtpVerifyDto {
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @IsNotEmpty() code!: string;
  @IsOptional() @IsString() name?: string;
}

class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken!: string;
}

class UpdateNameDto {
  @IsString() @IsNotEmpty() name!: string;
}

/** دخول اللوحات — المعرّف اسم مستخدم أو بريد */
class LoginDto {
  @IsString() @IsNotEmpty() username!: string;
  @IsString() @IsNotEmpty() password!: string;
}

class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword!: string;
  @IsString() @IsNotEmpty() newPassword!: string;
}

@Controller('v2/auth')
export class AuthV2Controller {
  constructor(
    private auth: AuthV2Service,
    private prisma: PrismaV2Service,
  ) {}

  @Post('firebase-login')
  firebaseLogin(@Body() dto: FirebaseLoginDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.firebaseLogin(
      dto.idToken,
      dto.name,
      deviceLabel(req),
      ip,
    );
  }

  /**
   * **المسار الأساسي لدخول الزبون** — جوجل بلا رمز تحقق ولا رصيد رسائل.
   * الرقم يُوثَّق لاحقاً مرة واحدة عبر `phone/verify` قبل أول طلب.
   */
  @Post('google-login')
  googleLogin(@Body() dto: SocialLoginDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.googleLogin(dto.idToken, deviceLabel(req), ip);
  }

  /**
   * **دخول آبل** — نظير `google-login` لمستخدمي iOS. تشترطه آبل على كل تطبيق
   * يعرض دخولاً بمزوّد خارجي (Guideline 4.8)، فغيابه يعني رفض النسخة عند
   * المراجعة. يمرّ بـFirebase كما يمرّ جوجل، فالتحقق واحد لكليهما.
   */
  @Post('apple-login')
  appleLogin(@Body() dto: SocialLoginDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.appleLogin(dto.idToken, deviceLabel(req), ip);
  }

  /**
   * هل مسار المصافحة متاح؟ يُسأل قبل بناء شاشة الهاتف — الرقم اختياري
   * (يُمرَّر ليُحترم استثناء القناة على رقم بعينه).
   */
  @Get('whatsapp/handshake/available')
  whatsappHandshakeAvailable(@Query('phone') phone?: string) {
    return this.auth.whatsappHandshakeAvailability(phone);
  }

  /**
   * **مصافحة واتساب — الخطوة الأولى.** يفتح جلسة تحقق ويُرجع رابط واتساب
   * برسالة مُملوءة مسبقاً يرسلها المستخدم بنفسه.
   *
   * بلا جلسة كسائر مسارات الدخول: من ينادي هذا لا حساب له بعد.
   */
  @Post('whatsapp/handshake/start')
  startWhatsappHandshake(@Body() dto: WhatsappHandshakeDto, @Ip() ip: string) {
    return this.auth.startWhatsappHandshake(dto.phone, ip);
  }

  /**
   * **الخطوة الثالثة** — يستطلعها التطبيق حتى تصل رسالة المستخدم، وعندها
   * يُرسَل رمز التحقق. الإرسال من هنا لا من مستقبِل الأحداث: انظر
   * `pollWhatsappHandshake`.
   */
  @Post('whatsapp/handshake/poll')
  pollWhatsappHandshake(@Body() dto: WhatsappHandshakeDto) {
    return this.auth.pollWhatsappHandshake(dto.phone);
  }

  /** توثيق الرقم لحساب داخلٍ أصلاً — يتطلب جلسة، خلاف مسار الدخول */
  @Post('phone/verify/request')
  @UseGuards(JwtV2Guard)
  requestPhoneVerification(
    @Body() dto: PhoneVerifyRequestDto,
    @CurrentUserV2() user: User,
    @Ip() ip: string,
  ) {
    return this.auth.requestPhoneVerification(user.id, dto.phone, ip);
  }

  @Post('phone/verify/confirm')
  @UseGuards(JwtV2Guard)
  confirmPhoneVerification(
    @Body() dto: PhoneVerifyConfirmDto,
    @CurrentUserV2() user: User,
  ) {
    return this.auth.confirmPhoneVerification(user.id, dto.phone, dto.code);
  }

  /** دخول تطوير بدون Firebase وبدون أي تحقق — مرفوض تلقائياً بالإنتاج */
  @Post('dev-login')
  devLogin(@Body() dto: DevLoginDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.devLogin(dto.phone, dto.name, deviceLabel(req), ip);
  }

  /** دخول ميداني عبر واتساب — نسخة انطلاق مؤقتة بديلة لـfirebase-login */
  @Post('whatsapp-otp/request')
  requestWhatsappOtp(@Body() dto: WhatsappOtpRequestDto, @Ip() ip: string) {
    return this.auth.requestWhatsappOtp(dto.phone, ip);
  }

  @Post('whatsapp-otp/verify')
  verifyWhatsappOtp(@Body() dto: WhatsappOtpVerifyDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.verifyWhatsappOtp(
      dto.phone,
      dto.code,
      dto.name,
      deviceLabel(req),
      ip,
    );
  }

  /** لوحات المنصة والوكالة — لا OTP هنا */
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.loginWithPassword(
      dto.username,
      dto.password,
      deviceLabel(req),
      ip,
    );
  }

  @Post('change-password')
  @UseGuards(JwtV2Guard)
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUserV2() user: User,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      deviceLabel(req),
      ip,
    );
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: Request, @Ip() ip: string) {
    return this.auth.refresh(dto.refreshToken, deviceLabel(req), ip);
  }

  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtV2Guard)
  async me(@CurrentUserV2() user: User) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: { select: { name: true, nameAr: true, scope: true } } },
    });
    // اسم الوكالة يظهر في ملف السائق — السائق يعرف لأي وكالة هو تابع
    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId: user.id },
      include: { agency: { select: { id: true, nameAr: true } } },
    });
    return { ...publicUser(user), roles, driverProfile };
  }

  /**
   * قبول شروط الاستخدام — شاشة أول دخول في التطبيق.
   *
   * القبول يُسجَّل في الخادم لا في ذاكرة الجهاز: من يمسح بيانات التطبيق أو
   * يبدّل هاتفه لا يعود «لم يوافق»، ولا تُفقد الموافقة نفسها وهي ما يُحتجّ
   * به عند نزاع.
   */
  @Post('me/accept-terms')
  @UseGuards(JwtV2Guard)
  acceptTerms(@CurrentUserV2() user: User) {
    return this.auth.acceptTerms(user.id);
  }

  /** يعدّل المستخدم اسمه — مرة كل مهلة تبريد، تفاصيلها بالخدمة */
  @Patch('me/name')
  @UseGuards(JwtV2Guard)
  updateName(@Body() dto: UpdateNameDto, @CurrentUserV2() user: User) {
    return this.auth.updateOwnName(user.id, dto.name);
  }

  /**
   * إقرار الاسم عند أول دخول — لا يستهلك مهلة التبريد، خلاف PATCH me/name.
   * شاشة إلزامية في التطبيق: الاسم هو ما ينادي به السائق عند الباب.
   */
  @Post('me/confirm-name')
  @UseGuards(JwtV2Guard)
  confirmName(@Body() dto: UpdateNameDto, @CurrentUserV2() user: User) {
    return this.auth.confirmOwnName(user.id, dto.name);
  }

  /**
   * يحذف المستخدم حسابه بنفسه — مطلب آبل 5.1.1(v). تفاصيل ما يُمحى وما
   * يُجرَّد من الهوية في الخدمة.
   */
  @Delete('me')
  @UseGuards(JwtV2Guard)
  deleteMe(@CurrentUserV2() user: User) {
    return this.auth.deleteOwnAccount(user.id);
  }
}
