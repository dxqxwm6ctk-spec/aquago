import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';

/** يتحقق من توكن الوصول (typ=v2) ويحمّل المستخدم من قاعدة v2 على req.userV2 */
@Injectable()
export class JwtV2Guard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private prisma: PrismaV2Service,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('توكن مفقود');
    }
    try {
      const payload = await this.jwt.verifyAsync(header.slice(7));
      if (payload.typ !== 'v2') throw new Error('wrong token type');
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });
      if (!user || user.status !== 'ACTIVE') throw new Error('inactive');
      // الجلسة قد تكون سُحبت (أدمن أخرج الجهاز، أو دخل السائق من جهاز آخر)
      // — بلا هذا الفحص يبقى الجهاز المسحوب يعمل حتى ينتهي توكنه، وهو ما
      // يُفرغ «إخراج الجهاز» من معناه.
      //
      // توكن بلا sid صادرٌ قبل هذه الميزة: يُقبل حتى ينتهي (١٥ دقيقة) بدل
      // إخراج كل المستخدمين لحظة النشر.
      if (payload.sid) {
        const session = await this.prisma.refreshToken.findFirst({
          where: { sessionId: payload.sid, userId: payload.sub, revokedAt: null },
          select: { id: true },
        });
        if (!session) throw new SessionRevokedError(payload.sid, payload.sub);
      }
      req.userV2 = user;
      return true;
    } catch (e) {
      // «جلسة غير صالحة» جواب لا يُفهم منه شيء. حين نعرف السبب نقوله: من
      // طُرد لأن أحداً دخل بحسابه يستحق أن يعرف ذلك لا أن يظنّه عطلاً.
      if (e instanceof SessionRevokedError) {
        throw new UnauthorizedException(await this.revokedMessage(e));
      }
      throw new UnauthorizedException('جلسة غير صالحة أو منتهية');
    }
  }

  private async revokedMessage(e: SessionRevokedError): Promise<string> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { sessionId: e.sessionId, userId: e.userId },
      orderBy: { revokedAt: 'desc' },
      select: { revokedReason: true },
    });
    return SESSION_REVOKED_AR[row?.revokedReason ?? ''] ?? 'انتهت الجلسة — سجّل دخولك من جديد';
  }
}

/** الجلسة موجودة لكنها سُحبت — نميّزها لنقول سببها بدل رسالة عامة */
class SessionRevokedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly userId: string,
  ) {
    super('session revoked');
  }
}

export const SESSION_REVOKED_AR: Record<string, string> = {
  NEW_DEVICE: 'سُجّل الدخول إلى حسابك من جهاز آخر — الحساب يعمل على جهاز واحد في المرة',
  PASSWORD_CHANGED: 'تغيّرت كلمة مرور الحساب — سجّل دخولك من جديد',
  ADMIN: 'أُخرج هذا الجهاز من الإدارة — تواصل مع الدعم إن لم تكن تتوقع ذلك',
  DRIVER_REMOVED: 'أُزيل حسابك من الوكالة — تواصل معها إن كان ذلك خطأً',
  LOGOUT: 'سُجّل خروجك من هذا الجهاز',
  ACCOUNT_DELETED: 'حُذف حسابك بناءً على طلبك',
};

export const CurrentUserV2 = createParamDecorator(
  (_: unknown, context: ExecutionContext): User =>
    context.switchToHttp().getRequest().userV2,
);
