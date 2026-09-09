/**
 * فحص جاهزية العامل من سطر الأوامر — لأن العامل بلا خادم HTTP (قرار
 * المرحلة 1.1 المتعمَّد: `createApplicationContext` بلا منفذ)، فموازن
 * تحميل لا يستهدفه أصلاً، لكن Docker `HEALTHCHECK` وorchestrator محلي ما
 * زالا يحتاجان طريقة لمعرفة أن العامل حيّ ومتصل فعلاً.
 *
 * **بلا حاوية DI عمداً — درسٌ من تشغيله فعلياً لا افتراضاً:** أول نسخة
 * كانت تبني AppModule كاملة عبر NestFactory، فتُهيّئ كل وحدة في المشروع
 * (RBAC وFirebase وTelegram وكل شيء آخر) بلا علاقة بالفحص، وقد علِقت
 * فعلياً بلا خرج ولا خطأ عند اختبارها ضد قاعدة وRedis ميتين. `HealthService`
 * تحتاج قيمتين فقط — عميل PrismaV2Service وعميل Redis — فتُنشآن مباشرة
 * بلا Nest إطلاقاً؛ الصنفان عاديان (لا يتطلب أيٌّ منهما حاوية حقن).
 *
 * فحصٌ يعمل كل ثوانٍ قليلة لا يستحق تكلفة تحميل تطبيق كامل ولا خطره.
 */
import Redis from 'ioredis';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { HealthService } from './health.service';

// أقصر من HEALTHCHECK --timeout (5s في Dockerfile) بهامش يكفي زمن إقلاع
// Node قبل بدء الفحص فعلياً (~0.5s قياساً) — خروج من داخل العملية نفسها
// بسبب واضح، لا اعتماد على قتل Docker الخارجي وحده كخط دفاع أول.
// `connect_timeout=5` على رابط Prisma (connection-pool.ts) أطول من هذه
// المهلة عمداً: تلك تخدم الإقلاع الحقيقي أيضاً (حيث التسامح مع قاعدة
// بطيئة الظهور على شبكة خاصة مطلوب)، فالحدّ الفعلي الحاسم لهذا الفحص هو
// هذه المهلة القصيرة، لا connect_timeout الأطول.
const TIMEOUT_MS = 3000;

async function main() {
  const prisma = new PrismaV2Service();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true, // فحصٌ قصير العمر — لا اتصال حتى نطلبه صراحةً
  });
  redis.on('error', () => undefined);

  const health = new HealthService(prisma, redis);
  const result = await health.readiness();
  console.log(JSON.stringify(result));

  // خروج فوري صريح لا `exitCode` وحدها — قِيسَ فعلياً: بعد فشل الاتصال،
  // `ioredis.disconnect()` (ومحاولة `$disconnect()` من Prisma بدرجة أقل)
  // تترك مؤقّتات إعادة محاولة داخلية حيّة لثانيتين تقريباً حتى بعد نجاح
  // القطع ظاهرياً، فتُبقي حلقة الحدث دائرة وتُبقي فحصاً قصير العمر معلّقاً
  // ضعف مهلته المقصودة. `process.exit` لا ينتظر تفريغ الحلقة — والفحص هنا
  // انتهى فعلاً بمجرد طباعة النتيجة، فلا حاجة لإغلاق مرتّب يخدم عملية
  // ستُقتل خلال ثوانٍ على أي حال.
  process.exit(result.ready ? 0 : 1);
}

const timeout = setTimeout(() => {
  console.error('فحص جاهزية العامل: انتهت المهلة — قاعدة أو Redis لا يستجيبان');
  process.exit(1);
}, TIMEOUT_MS);
timeout.unref();

main().catch((e) => {
  console.error('فشل فحص جاهزية العامل:', e);
  process.exit(1);
});
