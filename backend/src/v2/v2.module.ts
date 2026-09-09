import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AgenciesV2Module } from './agencies/agencies.module';
import { AppVersionV2Module } from './app-version/app-version.module';
import { AuthV2Module } from './auth/auth-v2.module';
import { ContractsV2Module } from './contracts/contracts.module';
import { CouponsV2Module } from './coupons/coupons.module';
import { PrismaV2Module } from './database/prisma-v2.module';
import { DispatchV2Module } from './dispatch/dispatch.module';
import { FinanceV2Module } from './finance/finance.module';
import { FirebaseAdminModule } from './firebase/firebase-admin.module';
import { HealthV2Module } from './health/health.module';
import { InvoicesV2Module } from './invoices/invoices.module';
import { MediaV2Module } from './media/media.module';
import { NotificationsV2Module } from './notifications/notifications.module';
import { ObservabilityModule } from './observability/observability.module';
import { OnboardingV2Module } from './onboarding/onboarding.module';
import { OrdersV2Module } from './orders/orders-v2.module';
import { OutreachV2Module } from './outreach/outreach.module';
import { PlatformV2Module } from './platform/platform.module';
import { RbacModule } from './rbac/rbac.module';
import { ReviewAccountV2Module } from './review-account/review-account.module';
import { SchedulerV2Module } from './scheduler/scheduler.module';
import { StorageV2Module } from './storage/storage.module';
import { RedisV2Module } from './redis/redis.module';
import { SupportV2Module } from './support/support.module';
import { TrackingV2Module } from './tracking/tracking-v2.module';

const JWT_ISSUER = 'aquago-api';
const JWT_AUDIENCE = 'aquago-v2';

/// الأسرار الافتراضية المرفوضة في الإنتاج — كلها لا واحدًا.
///
/// كانت القائمة سرًّا واحدًا باسم GasGO. وحين اشتُقّ AquaGo صار
/// `docker-compose` يمرّر سرًّا افتراضيًا آخر (`aquago-dev-...`) لا
/// يطابق المقارنة، فيمرّ الحارسُ عنه صامتًا: سرٌّ معروفٌ منشور في
/// المستودع يوقّع توكنات إنتاج. الحارس يجب أن يعرف كل ما وزّعناه
/// افتراضيًا، وإلا حَرَسَ الاسمَ لا الخطر.
const DEFAULT_SECRETS = new Set([
  'aquago-dev-secret-change-in-production',
  'aquago-dev-secret',
  'jordan-gas-dev-secret-change-in-production',
  'jordan-gas-dev-secret',
]);

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && !DEFAULT_SECRETS.has(secret)) {
    return secret;
  }
  // السر الافتراضي مقبول في التطوير فقط — الإنتاج يجب أن يفشل فوراً لا أن يعمل بسر معروف
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET غير معرَّف (أو لا يزال بالقيمة الافتراضية) — عرّفه في .env قبل التشغيل بوضع الإنتاج',
    );
  }
  return secret || 'aquago-dev-secret';
}

/**
 * منظومة المنصة (Jordan Gas Platform) — كل مساراتها تحت /api/v2/*، ومستقلة
 * تماماً عن النظام القديم المُزال من AppModule (قاعدة بيانات وRedis وتوقيع
 * JWT خاص بها). issuer/audience طبقة دفاع إضافية: توكن موقّع لخدمة أخرى
 * بنفس السر (لو تكرر بالخطأ) لن يُقبل هنا.
 */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: jwtSecret(),
      signOptions: { expiresIn: '15m', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      verifyOptions: { issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    }),
    PrismaV2Module,
    RedisV2Module,
    StorageV2Module,
    ObservabilityModule,
    HealthV2Module,
    RbacModule,
    FirebaseAdminModule,
    NotificationsV2Module,
    TrackingV2Module,
    AuthV2Module,
    AgenciesV2Module,
    CouponsV2Module,
    InvoicesV2Module,
    OrdersV2Module,
    DispatchV2Module,
    FinanceV2Module,
    PlatformV2Module,
    SupportV2Module,
    MediaV2Module,
    AppVersionV2Module,
    OutreachV2Module,
    OnboardingV2Module,
    ContractsV2Module,
    ReviewAccountV2Module,
    SchedulerV2Module,
  ],
})
export class V2Module {}
