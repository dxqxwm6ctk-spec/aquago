import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

export const REDIS = 'REDIS_CLIENT';
export const REDIS_PUB = 'REDIS_PUB_CLIENT';
export const REDIS_SUB = 'REDIS_SUB_CLIENT';

/**
 * خيارات موحّدة لكل اتصالات Redis.
 *
 * `retryStrategy` صريحة: الافتراضي في ioredis يعيد المحاولة إلى الأبد بتباعد
 * متزايد، وهو ما نريده هنا فعلاً — Redis يحمل الآن قناة البث بين الحاويات،
 * فالاستسلام يعني توقف الأحداث الحيّة بلا عودة. لكن نُسقّف التباعد بثانيتين
 * حتى لا تمتد فترة الانقطاع دقائق بعد عودة Redis.
 */
export function redisOptions(extra: RedisOptions = {}): RedisOptions {
  return {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    ...redisTlsOption(),
    ...extra,
  };
}

/**
 * TLS على اتصال Redis.
 *
 * `rediss://` في الرابط يكفي وحده ويتولّاه ioredis — وهو الطريق المعتاد
 * (Railway وDigitalOcean كلاهما يعطي رابطاً بهذه الصيغة حين تُفعَّل TLS).
 * `REDIS_TLS=true` موجود للحالة الأخرى: مزوّد يفرض TLS لكنه يعطي رابطاً
 * بصيغة `redis://`. بلا هذا المتغيّر لا حيلة إلا تعديل الرابط يدوياً في
 * كل بيئة — وهو بالضبط نوع الالتصاق بمنصّة الذي نتجنّبه.
 */
export function redisTlsOption(): RedisOptions {
  const url = process.env.REDIS_URL || '';
  const forced = (process.env.REDIS_TLS || '').trim().toLowerCase();
  const wantsTls = forced === 'true' || forced === '1';
  if (!wantsTls || url.startsWith('rediss://')) return {};
  try {
    return { tls: { servername: new URL(url).hostname } };
  } catch {
    return { tls: {} };
  }
}

function client(name: string, extra: RedisOptions = {}): Redis {
  const c = new Redis(
    process.env.REDIS_URL || 'redis://localhost:6379',
    redisOptions(extra),
  );
  // بلا مستمع 'error' يرفع ioredis استثناءً غير ملتقَط فيُسقط العملية عند
  // أول انقطاع. الانقطاع حالة متوقَّعة تُسجَّل ويُعاد الاتصال بعدها تلقائياً.
  c.on('error', (e) => console.error(`[redis:${name}] ${e.message}`));
  return c;
}

/**
 * عملاء Redis المشتركون.
 *
 * ثلاثة اتصالات لا واحد، وهذا شرط بروتوكولي لا اختيار: اتصالٌ في وضع
 * الاشتراك (subscribe) لا يقبل أوامر أخرى، فلو استُخدم عميل الكاش نفسه
 * لمحوّل Socket.IO لتعطّلت كل قراءات الصلاحيات وحضور السائقين لحظة اشتراكه.
 *
 *   REDIS      أوامر عامة — كاش الصلاحيات، حضور السائقين
 *   REDIS_PUB  نشر أحداث المحوّل بين الحاويات
 *   REDIS_SUB  اشتراك أحداث المحوّل (وضع اشتراك دائم)
 *
 * BullMQ يبقى على اتصالاته الخاصة (`bullConnection()`): مكتبته تفرض
 * `maxRetriesPerRequest: null` وتدير دورة حياة اتصالاتها بنفسها.
 */
@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => client('cmd') },
    { provide: REDIS_PUB, useFactory: () => client('pub') },
    { provide: REDIS_SUB, useFactory: () => client('sub') },
  ],
  exports: [REDIS, REDIS_PUB, REDIS_SUB],
})
export class RedisV2Module implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private cmd: Redis,
    @Inject(REDIS_PUB) private pub: Redis,
    @Inject(REDIS_SUB) private sub: Redis,
  ) {}

  /**
   * إغلاق مرتّب عند SIGTERM.
   *
   * بلا هذا تُقطع الاتصالات مع العملية فيرى Redis وصلات ميتة تنتظر انتهاء
   * المهلة، وتظهر أخطاء "Connection is closed" في سجل الإيقاف تُشوّش على
   * أي عطل حقيقي وقت النشر. `quit` تُنهي الجلسة بالبروتوكول؛ وإن تعذّر
   * (Redis ساقط أصلاً) نقطع مباشرة بدل تعليق الإيقاف.
   */
  async onApplicationShutdown() {
    await Promise.all(
      [this.cmd, this.pub, this.sub].map(async (c) => {
        c.on('error', () => undefined);
        await c.quit().catch(() => c.disconnect());
      }),
    );
  }
}
