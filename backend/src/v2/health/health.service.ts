import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { isWorker } from '../common/role';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { REDIS } from '../redis/redis.module';

export type DependencyStatus = 'ok' | 'down' | 'skipped';

export interface ReadinessResult {
  ready: boolean;
  role: 'api' | 'worker';
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
  /** بالمللي‌ثانية — لرصد تدهور زمن استجابة القاعدة قبل أن يصير عطلاً */
  latencyMs: { database?: number; redis?: number };
}

/** مهلة كل فحص فرعي — انظر الشرح فوق checkRedis لسبب وجودها تحديداً */
const CHECK_TIMEOUT_MS = 1500;

/**
 * فحوص الجاهزية — رخيصة عمداً.
 *
 * `SELECT 1` لا استعلاماً على جدول حقيقي: أرخص ما يثبت أن الاتصال حيّ
 * ويستجيب، بلا قفل صفوف ولا خطة استعلام. `PING` المكافئ على Redis. هذه
 * الفحوص تُستدعى من موازن تحميل كل ثوانٍ قليلة على كل حاوية — استعلامٌ
 * أثقل يتحوّل بذاته إلى حِمل حقيقي على القاعدة عند التوسّع.
 *
 * **لماذا القاعدة الواحدة تكفي فحصاً واحداً:** PrismaService وPrismaV2Service
 * يتصلان بنفس خادم القاعدة (مخططان مختلفان في قاعدة واحدة على Railway/DO)،
 * فاتصال أحدهما مؤشرٌ كافٍ على وصول الخادم — فحص كليهما يضاعف الحِمل بلا
 * معلومة إضافية تُذكر. عند انفصالهما فعلياً (خطة مستقبلية) يصير فحصان
 * ضروريَين، لا قبل ذلك.
 */
@Injectable()
export class HealthService {
  constructor(
    private prisma: PrismaV2Service,
    @Inject(REDIS) private redis: Redis,
  ) {}

  /**
   * الجاهزية بحسب الدور: كلا الدورين يحتاج قاعدة بيانات حيّة، وكلاهما
   * يحتاج Redis أيضاً — لكن لسببين مختلفين تماماً لا لأنه فحصٌ عام واحد:
   *
   *   API:    Redis يحمل محوّل Socket.IO (المرحلة 1.2) — بلا اتصال الآن
   *           لا تصل أحداث دخول/عروض حيّة عبر الحاويات، فحاويةٌ بلا Redis
   *           تخدم HTTP سليماً لكنها معزولة عن بثّ الحاويات الأخرى.
   *   Worker: Redis هو BullMQ نفسه — بلا اتصال لا تُستهلك طوابير التوزيع
   *           ولا المهام المجدولة إطلاقاً، وهذا الدور الوحيد للعامل.
   *
   * التفريق موجود في التوثيق لا في القرار: كلاهما "down" يعني غير جاهز في
   * كلا الدورين اليوم — لكن الفحص يُبقي معلومة *لماذا* واضحة في السجلّ.
   */
  async readiness(): Promise<ReadinessResult> {
    const role = isWorker() ? 'worker' : 'api';
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      ready: database.status === 'ok' && redis.status === 'ok',
      role,
      checks: { database: database.status, redis: redis.status },
      latencyMs: {
        ...(database.latencyMs !== undefined ? { database: database.latencyMs } : {}),
        ...(redis.latencyMs !== undefined ? { redis: redis.latencyMs } : {}),
      },
    };
  }

  /**
   * يسابق أي وعد بمهلة صريحة — مُستخلَصة إلى دالة واحدة بعد أن ثبت
   * الحاجة إليها فعلياً لا نظرياً: قياسٌ حيّ على Docker Compose (المرحلة
   * 3.4) أظهر `checkRedis` يمتد إلى 22 ثانية بعد إيقاف Redis، رغم أن
   * `ping()` نفسها "سريعة الفشل" في الاختبارات المعزولة بالمرحلة الثانية.
   * السبب: العميل المشترك (RedisV2Module) يحمل retryStrategy تراكمياً
   * لخدمة الاستعمال العادي (كاش الصلاحيات يستفيد من إعادة محاولة قصيرة
   * قبل الرجوع للقاعدة) — وفحص الجاهزية كان ينتظر حالة إعادة محاولة ذلك
   * العميل نفسها بدل أن يملك مهلته المستقلة، فكل فحص فاشل متتالٍ يزيد
   * التأخير قبل الفحص الذي يليه (200ms، 400ms، ...حتى سقف 2000ms مضروبة
   * بعدد المحاولات المسموحة). فحص جاهزية يعتمد على تعافي عميل آخر بدل أن
   * يحكم بنفسه ليس رخيصاً — هو عكس الهدف المعلن أعلاه تماماً.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timeout')), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async checkDatabase(): Promise<{ status: DependencyStatus; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.withTimeout(this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down' };
    }
  }

  private async checkRedis(): Promise<{ status: DependencyStatus; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down' };
    }
  }
}
