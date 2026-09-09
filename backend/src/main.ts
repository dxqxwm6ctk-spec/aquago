import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { processRole } from './v2/common/role';
import { JsonLogger } from './v2/observability/json-logger';
import { RedisIoAdapter } from './v2/tracking/redis-io.adapter';

/**
 * المسجّل يُبنى قبل `NestFactory` ويُمرَّر إليه: أخطاء الإقلاع نفسها —
 * وحدة تفشل في التهيئة، اتصال قاعدة يُرفض — تحدث قبل أن يجهز التطبيق،
 * وهي أهم ما نحتاج قراءته آلياً. تركيبه بعد الإقلاع يترك تلك السطور
 * بالضبط خارج الصيغة المنظَّمة.
 */
function makeLogger(): JsonLogger {
  const logger = new JsonLogger();
  logger.setLogLevels(JsonLogger.levels());
  return logger;
}

/**
 * أصول CORS المسموحة: قائمة مفصولة بفواصل في CORS_ORIGINS (مثال:
 * "https://agency.netlify.app,https://platform.netlify.app"). لا نطاق
 * افتراضي — الإنتاج بلا CORS_ORIGINS يفشل عند الإقلاع بدل أن يفتح '*' بصمت.
 * خارج production نسمح بأي أصل حتى يعمل التطوير المحلي بلا إعداد إضافي.
 */
function corsOrigins(): string[] | true {
  const raw = process.env.CORS_ORIGINS?.trim();
  const origins = raw ? raw.split(',').map((o) => o.trim()).filter(Boolean) : [];
  if (origins.length) return origins;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CORS_ORIGINS غير معرَّف — عرّف نطاقات الواجهة المسموحة قبل التشغيل بوضع الإنتاج',
    );
  }
  return true; // تطوير محلي فقط
}

/**
 * دور العامل: نفس الصورة ونفس الوحدات، بلا مستمع HTTP.
 *
 * `createApplicationContext` لا يفتح منفذاً ولا يبني طبقة HTTP — العامل لا
 * يخدم طلبات، وفتح منفذ له يعني نقطة دخول بلا سبب ومنفذاً يجب تأمينه.
 * دورة حياة الوحدات كما هي، فمستهلكو BullMQ يعملون كالمعتاد.
 */
async function bootstrapWorker() {
  const logger = makeLogger();
  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  app.enableShutdownHooks();
  logger.log('AquaGo worker — طوابير BullMQ والمهام المجدولة', 'Bootstrap');
}

async function bootstrapApi() {
  // rawBody: يحتفظ Nest بالجسم الخام إلى جانب المحلَّل. لازمٌ للتحقق من
  // توقيع webhook متى (X-Hub-Signature-256): التوقيع محسوب على البايتات كما
  // أرسلتها Meta، وإعادة ترتيب مفاتيح JSON عند التحليل تكسره.
  const logger = makeLogger();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger });
  // كوكي جلسة عرض الفاتورة العامة (invoice_session) — HttpOnly، تُقرأ عبر
  // req.cookies بدل تحليل ترويسة Cookie يدوياً في كل معالج.
  app.use(cookieParser());
  // المحوّل قبل `listen`: بدونه تحتفظ كل حاوية بغرفها في ذاكرتها وحدها،
  // فسائق موصول بـAPI#1 لا يصله عرضٌ بُثّ من API#2 — بلا خطأ في السجل.
  const ioAdapter = new RedisIoAdapter(app);
  ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);
  app.enableCors({ origin: corsOrigins() });
  app.setGlobalPrefix('api', { exclude: ['admin'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  // إيقاف أنيق: الموازِن يسحب الحاوية من الدوران عند SIGTERM، وonModuleDestroy
  // يغلق مستهلكي الطوابير واتصالات Prisma بدل قطعها في منتصف مهمة.
  app.enableShutdownHooks();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`AquaGo API يستمع على المنفذ ${port} — /api و/admin`, 'Bootstrap');
}

// الدور يُقرأ مرة واحدة هنا: قيمة غير معروفة توقف الإقلاع بدل أن تُفسَّر
// `api` بصمت، فـROLE=wroker لا يعني طوابير بلا مستهلك.
const role = processRole();
void (role === 'worker' ? bootstrapWorker() : bootstrapApi());
