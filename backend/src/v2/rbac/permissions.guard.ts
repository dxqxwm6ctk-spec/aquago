import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { PermissionsService } from './permissions.service';

/**
 * الحارس المزدوج: صلاحية + نطاق مستأجر (خطة المرحلة 2.4)
 *
 * الترتيب:
 *  1. صلاحيات المستخدم على مستوى المنصة تكفي → مسموح عبر كل الوكالات
 *     (Operations يتابع طلبات أي وكالة).
 *  2. وإلا يجب أن يحمل المسار :agencyId، وتُفحص صلاحياته **داخل تلك الوكالة
 *     تحديداً** — موظف وكالة A يطلب GET /agencies/B/drivers يفشل حتى لو
 *     كان يملك drivers.view في وكالته.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.userV2;
    if (!user) throw new UnauthorizedException('يتطلب تسجيل الدخول');

    const platformPerms = await this.permissions.getPermissions(user.id, null);
    if (required.every((k) => platformPerms.has(k))) {
      req.tenantScope = 'PLATFORM';
      return true;
    }

    const agencyId: string | undefined = req.params?.agencyId;
    if (!agencyId) {
      throw new ForbiddenException('هذه العملية تتطلب صلاحية على مستوى المنصة');
    }
    const agencyPerms = await this.permissions.getPermissions(user.id, agencyId);
    if (required.every((k) => agencyPerms.has(k))) {
      req.tenantScope = agencyId;
      return true;
    }
    throw new ForbiddenException('لا تملك الصلاحية المطلوبة في هذه الوكالة');
  }
}
